"""Private Dodo reconciliation: current provider state -> bounded paid access."""

import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

from boto3.dynamodb.conditions import Key

try:
    from . import billing, dodo
    from .accounts import table
    from .auth import AccessError
    from .controls import conditional_failure, fields, transaction
except ImportError:
    import billing, dodo
    from accounts import table
    from auth import AccessError
    from controls import conditional_failure, fields, transaction


logger = logging.getLogger("focusfeed.billing.worker")
FRESHNESS_SECONDS = 86400
RECONCILE_SECONDS = 6 * 3600


def timestamp(value):
    if not isinstance(value, str):
        raise AccessError(503, "billing_contract_invalid", "Dodo returned an invalid service period.")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise AccessError(503, "billing_contract_invalid", "Dodo returned an invalid service period.")
    return int(parsed.timestamp())


def customer_id(resource):
    return dodo.identifier(resource.get("customer", {}).get("customer_id"))


def subscription_ids(payment):
    values = payment.get("subscription_ids") or ([payment["subscription_id"]] if payment.get("subscription_id") else [])
    if not isinstance(values, list) or len(values) > 4:
        raise AccessError(503, "billing_contract_invalid", "Unexpected subscription cart.")
    return list(dict.fromkeys(dodo.identifier(value) for value in values))


def bind(subscription, payment=None):
    """Bind only server-created checkout intents. Never match accounts by email."""
    sid = dodo.identifier(subscription.get("subscription_id"))
    customer, product = customer_id(subscription), dodo.identifier(subscription.get("product_id"))
    existing = billing.read("SUB", sid)
    if existing:
        if existing["customerId"] != customer:
            raise AccessError(503, "billing_owner_conflict", "Subscription owner changed unexpectedly.")
        return existing["subject"]
    intent_id = (subscription.get("metadata") or {}).get("focusfeed_intent")
    if not intent_id and payment:
        intent_id = (payment.get("metadata") or {}).get("focusfeed_intent")
        if not intent_id and payment.get("checkout_session_id"):
            intent_id = billing.read("CHECKOUT", dodo.identifier(payment["checkout_session_id"])).get("intent")
    if not intent_id:
        return None  # Another product/checkout in the same merchant account.
    intent = billing.read("INTENT", dodo.identifier(intent_id))
    if not intent or intent.get("expiresAt", 0) <= int(time.time()):
        return None
    if product != intent["productId"] or product not in dodo.config()["products"]:
        raise AccessError(503, "billing_product_conflict", "Unexpected subscription product.")
    subject, now = intent["subject"], int(time.time())
    transaction([
        {"Put": {"TableName": os.environ["FOCUSFEED_BILLING_TABLE"], "Item": fields({
            **billing.key("SUB", sid), "subject": subject, "customerId": customer, "productId": product}),
            "ConditionExpression": "attribute_not_exists(pk) OR subject = :subject",
            "ExpressionAttributeValues": fields({":subject": subject})}},
        {"Put": {"TableName": os.environ["FOCUSFEED_BILLING_TABLE"], "Item": fields({
            **billing.key("CUSTOMER", customer), "subject": subject}),
            "ConditionExpression": "attribute_not_exists(pk) OR subject = :subject",
            "ExpressionAttributeValues": fields({":subject": subject})}},
        {"Update": {"TableName": os.environ["FOCUSFEED_BILLING_TABLE"], "Key": fields(billing.key("USER", subject)),
            "UpdateExpression": "SET customerId = :customer, reconcileGroup = :group, reconcileAt = :now ADD subscriptions :subscriptions",
            "ConditionExpression": "attribute_not_exists(customerId) OR customerId = :customer",
            "ExpressionAttributeValues": fields({":customer": customer, ":group": dodo.config()["mode"],
                                                 ":now": now, ":subscriptions": {sid}})}},
    ])
    return subject


def payment_access(payment, sid, customer, now):
    if "refund_status" not in payment or "dispute_status" not in payment:
        raise AccessError(503, "billing_contract_invalid", "Payment refund/dispute state is missing.")
    if customer_id(payment) != customer:
        raise AccessError(503, "billing_owner_conflict", "Payment owner does not match subscription owner.")
    if sid not in subscription_ids(payment):
        raise AccessError(503, "billing_contract_invalid", "Payment does not belong to this subscription.")
    # Zero-value card checks, trials and on-demand/usage-only charges never buy
    # recurring access. Partial refunds retain access; full refunds remove it.
    if (payment.get("status") != "succeeded" or payment.get("charge_type") not in ("new", "renewal", "plan_change")
            or type(payment.get("total_amount")) is not int or payment["total_amount"] <= 0
            or payment.get("refund_status") == "full"
            or payment.get("dispute_status") not in (None, "dispute_won", "dispute_cancelled")):
        return 0
    if payment.get("refund_status") not in (None, "partial", "full"):
        raise AccessError(503, "billing_contract_invalid", "Unknown refund state.")
    periods = payment.get("service_periods")
    if not isinstance(periods, list):
        raise AccessError(503, "billing_contract_invalid", "Missing paid service periods.")
    end = 0
    for period in periods:
        if period.get("subscription_id") != sid:
            continue
        start, until = timestamp(period.get("starts_at")), timestamp(period.get("ends_at"))
        if start <= now < until <= now + 370 * 86400:
            end = max(end, until)
    return end


def reconcile(subject):
    owner, now = uuid.uuid4().hex, int(time.time())
    user_key = billing.key("USER", subject)
    initial = billing.read("USER", subject)
    if not initial.get("subscriptions"):
        # Recover a missed FIRST payment webhook from the server-owned checkout
        # ID as well as recovering later renewals from known subscriptions.
        if initial.get("checkoutId"):
            checkout = dodo.request("GET", "/checkouts/" + dodo.identifier(initial["checkoutId"]))
            if checkout.get("payment_id"):
                payment = dodo.request("GET", "/payments/" + dodo.identifier(checkout["payment_id"]))
                for sid in subscription_ids(payment):
                    bind(dodo.request("GET", "/subscriptions/" + sid), payment)
        initial = billing.read("USER", subject)
        if not initial.get("subscriptions"):
            if initial.get("checkoutUntil", 0) > now:
                billing.store().update_item(Key=user_key, UpdateExpression="SET reconcileAt = :next",
                    ConditionExpression="attribute_not_exists(subscriptions)", ExpressionAttributeValues={":next": now + 900})
            elif initial:
                billing.store().update_item(Key=user_key, UpdateExpression="REMOVE reconcileGroup, reconcileAt",
                    ConditionExpression="attribute_not_exists(subscriptions)")
            return
    try:
        billing.store().update_item(Key=user_key,
            UpdateExpression="SET lockOwner = :owner, lockUntil = :until",
            ConditionExpression="attribute_exists(subscriptions) AND (attribute_not_exists(lockUntil) OR lockUntil < :now)",
            ExpressionAttributeValues={":owner": owner, ":until": now + 120, ":now": now})
    except Exception as exc:
        if conditional_failure(exc) and not billing.read("USER", subject).get("subscriptions"):
            return
        raise
    try:
        user = billing.read("USER", subject)
        subscriptions = user.get("subscriptions", set())
        if not 1 <= len(subscriptions) <= 4:
            raise AccessError(503, "billing_review_required", "This account needs billing review.")
        settings = dodo.config()
        until, pending, cancel_at_end, states = 0, False, False, []
        for sid in sorted(subscriptions):
            subscription = dodo.request("GET", "/subscriptions/" + dodo.identifier(sid))
            if subscription.get("subscription_id") != sid or customer_id(subscription) != user["customerId"]:
                raise AccessError(503, "billing_owner_conflict", "Unexpected subscription owner.")
            if subscription.get("product_id") not in settings["products"]:
                # A portal plan change to a non-Pro product cannot retain Pro.
                states.append("unrecognized_plan")
                continue
            state = subscription.get("status")
            if state not in ("active", "past_due", "pending", "on_hold", "paused", "cancelled", "expired", "failed"):
                raise AccessError(503, "billing_contract_invalid", "Unknown subscription state.")
            states.append(state)
            pending = pending or state in ("active", "past_due", "pending", "on_hold", "paused")
            cancel_at_end = cancel_at_end or subscription.get("cancel_at_next_billing_date") is True
            if state not in ("active", "past_due"):
                continue
            # Fetch current payment summaries, never old webhook snapshots.
            # Only a <=1-year paid service interval is eligible for this v1 plan.
            cutoff = datetime.fromtimestamp(now - 400 * 86400, timezone.utc).isoformat()
            result = dodo.request("GET", "/payments", query={"subscription_id": sid, "status": "succeeded",
                                  "created_at_gte": cutoff, "page_size": 100, "page_number": 0})
            payments = result.get("items")
            if not isinstance(payments, list) or len(payments) >= 100:
                raise AccessError(503, "billing_review_required", "Payment history needs billing review.")
            for payment in payments:
                until = max(until, payment_access(payment, sid, user["customerId"], now))
        existing = table(os.environ["FOCUSFEED_ACCESS_TABLE"]).get_item(Key={"userId": subject}, ConsistentRead=True).get("Item", {})
        # A paid purchase/refund must not erase an already issued operator beta
        # grant. Preserve its original expiry when transitioning to Dodo records.
        beta_until = int(existing.get("betaUntil", 0))
        if existing.get("source") == "operator-beta" and existing.get("status") == "active":
            beta_until = max(beta_until, int(existing.get("accessUntil", 0)))
        effective_until = max(until, beta_until)
        access = {"userId": subject, "source": "dodo", "mode": settings["mode"],
                  "status": "active" if effective_until > now else "revoked", "accessUntil": effective_until,
                  "paidUntil": until, "betaUntil": beta_until, "verifiedAt": now}
        put = {"TableName": os.environ["FOCUSFEED_ACCESS_TABLE"], "Item": fields(access)}
        if existing:
            put.update(ConditionExpression="#source = :source AND #state = :state AND accessUntil = :until",
                       ExpressionAttributeNames={"#source": "source", "#state": "status"},
                       ExpressionAttributeValues=fields({":source": existing["source"], ":state": existing["status"], ":until": existing["accessUntil"]}))
        else:
            put["ConditionExpression"] = "attribute_not_exists(userId)"
        transaction([
            {"Put": put},
            {"Update": {"TableName": os.environ["FOCUSFEED_BILLING_TABLE"], "Key": fields(user_key),
                "UpdateExpression": "SET accessUntil = :access, verifiedAt = :now, hasSubscription = :pending, cancelAtPeriodEnd = :cancel, subscriptionStatus = :state, reconcileAt = :next REMOVE lockOwner, lockUntil",
                "ConditionExpression": "lockOwner = :owner AND lockUntil > :now AND subscriptions = :subscriptions",
                "ExpressionAttributeValues": fields({":access": until, ":now": now, ":pending": pending, ":cancel": cancel_at_end,
                    ":state": "active" if until > now else ",".join(sorted(set(states))), ":next": now + RECONCILE_SECONDS,
                    ":owner": owner, ":subscriptions": subscriptions})}},
        ])
        logger.warning(json.dumps({"event": "billing_reconciled", "premium": until > now, "mode": settings["mode"]}))
    finally:
        try:
            billing.store().update_item(Key=user_key, UpdateExpression="REMOVE lockOwner, lockUntil",
                ConditionExpression="lockOwner = :owner", ExpressionAttributeValues={":owner": owner})
        except Exception:
            pass  # An existing lease expires; never release another worker's lock.


def process(event_key):
    item = billing.store().get_item(Key=event_key, ConsistentRead=True).get("Item", {})
    if not item or item.get("status") == "completed":
        return
    if item["kind"] == "account":
        reconcile(item["subject"])
    else:
        resource = dodo.identifier(item["resource"])
        payment = None
        if item["kind"] == "subscription":
            ids = [resource]
        else:
            payment = dodo.request("GET", "/payments/" + resource)
            if payment.get("payment_id") != resource:
                raise AccessError(503, "billing_contract_invalid", "Unexpected payment ID.")
            ids = subscription_ids(payment)
        subjects = set()
        for sid in ids:
            sub = dodo.request("GET", "/subscriptions/" + sid)
            subject = bind(sub, payment)
            if subject:
                subjects.add(subject)
        for subject in subjects:
            reconcile(subject)
    billing.store().update_item(Key=event_key, UpdateExpression="SET #state = :done",
        ExpressionAttributeNames={"#state": "status"}, ExpressionAttributeValues={":done": "completed"})


def scheduled(context):
    result = billing.store().query(IndexName="ReconcileIndex",
        KeyConditionExpression=Key("reconcileGroup").eq(dodo.config()["mode"]) & Key("reconcileAt").lte(int(time.time())), Limit=25)
    failures = 0
    for item in result.get("Items", []):
        if context and context.get_remaining_time_in_millis() < 20000:
            break  # Unprocessed accounts remain due for the next scheduled run.
        try:
            subject = item["pk"].split("#USER#", 1)[1]
            reconcile(subject)
        except Exception:
            failures += 1
            logger.warning('{"event":"billing_scheduled_reconciliation_failed"}')
    if failures:
        raise RuntimeError("Billing reconciliation needs attention")


def lambda_handler(event, context):
    if event.get("source") == "aws.events":
        scheduled(context)
        return {}
    failures = []
    for record in event.get("Records", []):
        if record.get("eventName") != "INSERT":
            continue
        event_key = None
        try:
            keys = record["dynamodb"]["Keys"]
            event_key = {name: keys[name]["S"] for name in ("pk", "sk")}
            prefix = "DODO#" + dodo.config()["mode"] + "#EVENT#"
            if event_key["pk"].startswith(prefix) and event_key["sk"] == "EVENT":
                process(event_key)
        except Exception:
            # Keep payloads, bearer keys and customer/portal details out of logs.
            logger.warning(json.dumps({"event": "billing_event_failed",
                                       "eventId": event_key["pk"].rsplit("#", 1)[-1] if event_key else None}))
            failures.append({"itemIdentifier": record["dynamodb"]["SequenceNumber"]})
    return {"batchItemFailures": failures}
