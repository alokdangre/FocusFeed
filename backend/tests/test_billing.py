"""Signed Dodo webhooks and DynamoDB-emulated billing workflows; no live payments."""

import base64
import copy
import io
import json
import os
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import boto3
from moto import mock_aws
from standardwebhooks.webhooks import Webhook

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import accounts
import billing
import billing_worker as worker
import dodo
from auth import AccessError, Principal


SECRET = "whsec_" + base64.b64encode(b"test-signing-secret-32-characters").decode()
ENV = {"AWS_DEFAULT_REGION": "ap-south-1", "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
       "AWS_SESSION_TOKEN": "testing", "AWS_EC2_METADATA_DISABLED": "true", "FOCUSFEED_ACCESS_TABLE": "access",
       "FOCUSFEED_USER_TABLE": "users", "FOCUSFEED_BILLING_TABLE": "billing", "DODO_ENVIRONMENT": "test_mode",
       "DODO_PRO_PRODUCT_ID": "pdt_pro", "DODO_BUSINESS_ID": "bus_test", "DODO_API_KEY": "test-merchant-secret",
       "DODO_WEBHOOK_SECRET": SECRET, "DODO_RETURN_URL": "https://api.example/billing/return", "DODO_LEGACY_PRODUCT_IDS": ""}
ENV["FOCUSFEED_BILLING_MODE"] = "test_mode"


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


class BillingTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, ENV); env.start(); self.addCleanup(env.stop)
        aws = mock_aws(); aws.start(); self.addCleanup(aws.stop)
        accounts._tables.values = {}
        db = boto3.resource("dynamodb")
        for name, keys in (("users", ["pk", "sk"]), ("access", ["userId"])):
            db.create_table(TableName=name, BillingMode="PAY_PER_REQUEST",
                KeySchema=[{"AttributeName": key, "KeyType": "HASH" if i == 0 else "RANGE"} for i, key in enumerate(keys)],
                AttributeDefinitions=[{"AttributeName": key, "AttributeType": "S"} for key in keys])
        db.create_table(TableName="billing", BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": key, "AttributeType": typ} for key, typ in (("pk", "S"), ("sk", "S"), ("reconcileGroup", "S"), ("reconcileAt", "N"))],
            GlobalSecondaryIndexes=[{"IndexName": "ReconcileIndex", "KeySchema": [{"AttributeName": "reconcileGroup", "KeyType": "HASH"},
                {"AttributeName": "reconcileAt", "KeyType": "RANGE"}], "Projection": {"ProjectionType": "KEYS_ONLY"}}])
        self.alice, self.bob = Principal("alice", session_id="alice-session"), Principal("bob", session_id="bob-session")
        self.calls, self.subscriptions, self.payments, self.sessions = [], {}, {}, {}
        provider = patch.object(dodo, "request", side_effect=self.provider); self.http = provider.start(); self.addCleanup(provider.stop)

    def provider(self, method, path, body=None, query=None):
        self.calls.append((method, path, body, query))
        if method == "POST" and path == "/checkouts":
            index = len(self.sessions) + 1
            sid, cid, checkout_id = "sub_" + str(index), "cus_" + str(index), "cks_" + str(index)
            cid = body.get("customer", {}).get("customer_id", cid)
            self.subscriptions[sid] = {"subscription_id": sid, "customer": {"customer_id": cid}, "metadata": body["metadata"],
                "product_id": body["product_cart"][0]["product_id"], "status": "active", "cancel_at_next_billing_date": False,
                "next_billing_date": iso(time.time() + 31 * 86400)}
            self.sessions[checkout_id] = {"id": checkout_id, "payment_status": None, "payment_id": None}
            return {"session_id": checkout_id, "checkout_url": "https://test.checkout.dodopayments.com/session/" + checkout_id}
        if path.startswith("/checkouts/"):
            return copy.deepcopy(self.sessions[path.rsplit("/", 1)[1]])
        if path.startswith("/subscriptions/"):
            return copy.deepcopy(self.subscriptions[path.rsplit("/", 1)[1]])
        if path.startswith("/payments/"):
            return copy.deepcopy(self.payments[path.rsplit("/", 1)[1]])
        if path == "/payments":
            self.assertEqual(query["status"], "succeeded")
            return {"items": copy.deepcopy([p for p in self.payments.values() if query["subscription_id"] in p["subscription_ids"]])}
        if "/customer-portal/session" in path:
            return {"link": "https://test.customer.dodopayments.com/session/signed-portal-link"}
        raise AssertionError((method, path))

    def purchase(self, principal=None):
        return billing.checkout(principal or self.alice)

    def pay(self, sid="sub_1", payment_id="pay_1", **updates):
        now = int(time.time())
        value = {"payment_id": payment_id, "status": "succeeded", "customer": self.subscriptions[sid]["customer"],
            "metadata": self.subscriptions[sid]["metadata"], "subscription_ids": [sid], "charge_type": "new",
            "total_amount": 1000, "refund_status": None, "dispute_status": None,
            "service_periods": [{"subscription_id": sid, "starts_at": iso(now - 60), "ends_at": iso(now + 30 * 86400)}]}
        value.update(updates); self.payments[payment_id] = value
        return value

    def signed(self, kind, data, event_id="evt_1", business="bus_test", at=None, encoded=False):
        at = at or datetime.now(timezone.utc)
        raw = json.dumps({"business_id": business, "type": kind, "timestamp": at.isoformat(), "data": data}, separators=(",", ":"))
        signature = Webhook(SECRET).sign(event_id, at, raw)
        return {"rawPath": "/billing/webhook", "httpMethod": "POST", "body": base64.b64encode(raw.encode()).decode() if encoded else raw,
            "isBase64Encoded": encoded, "headers": {"webhook-id": event_id, "webhook-timestamp": str(int(at.timestamp())), "webhook-signature": signature}}

    def deliver(self, kind="payment.succeeded", event_id="evt_1", resource="pay_1"):
        field = "subscription_id" if kind.startswith("subscription.") else "payment_id"
        result = billing.lambda_handler(self.signed(kind, {field: resource}, event_id), None)
        self.assertEqual(result["statusCode"], 200, result)
        worker.process(billing.key("EVENT", event_id, "EVENT"))

    def access(self, principal=None):
        return accounts.account(principal or self.alice, touch=False)

    def test_checkout_is_server_owned_and_duplicate_click_reuses_unpaid_session(self):
        first = self.purchase(); again = self.purchase()
        self.assertEqual(first, again)
        creates = [c for c in self.calls if c[:2] == ("POST", "/checkouts")]
        self.assertEqual(len(creates), 1)
        body = creates[0][2]
        self.assertEqual(body["product_cart"], [{"product_id": "pdt_pro", "quantity": 1}])
        self.assertEqual(body["subscription_data"]["trial_period_days"], 0)
        self.assertEqual(body["return_url"], ENV["DODO_RETURN_URL"])
        intent = billing.read("INTENT", body["metadata"]["focusfeed_intent"])
        self.assertEqual(intent["subject"], "alice")
        self.assertFalse(self.access()["premium"])

    def test_active_without_successful_payment_does_not_grant_access(self):
        self.purchase(); self.deliver("subscription.active", resource="sub_1")
        self.assertFalse(self.access()["premium"])
        self.assertTrue(billing.status(self.alice)["canManage"])

    def test_confirmed_payment_grants_exact_paid_period_and_renewal_extends_it(self):
        self.purchase(); payment = self.pay(); self.deliver()
        self.assertEqual(self.access()["accessUntil"], worker.timestamp(payment["service_periods"][0]["ends_at"]))
        renewed = self.pay(payment_id="pay_2", charge_type="renewal", service_periods=[{
            "subscription_id": "sub_1", "starts_at": iso(time.time() - 10), "ends_at": iso(time.time() + 60 * 86400)}])
        self.deliver("subscription.renewed", "evt_2", "sub_1")
        self.assertEqual(self.access()["accessUntil"], worker.timestamp(renewed["service_periods"][0]["ends_at"]))

    def test_duplicate_signed_event_is_durable_and_never_reprocesses_a_completed_event(self):
        self.purchase(); self.pay(); self.deliver()
        count = len(self.calls)
        self.deliver()
        self.assertEqual(len(self.calls), count)
        self.assertEqual(billing.read("EVENT", "evt_1", "EVENT")["status"], "completed")

    def test_bad_signatures_changed_bodies_old_future_timestamps_and_wrong_business_are_rejected(self):
        original = self.signed("payment.succeeded", {"payment_id": "pay_1"})
        cases = []
        bad = copy.deepcopy(original); bad["body"] += " "; cases.append(bad)
        bad = copy.deepcopy(original); bad["headers"]["webhook-signature"] = "v1,invalid"; cases.append(bad)
        bad = copy.deepcopy(original); bad["headers"].pop("webhook-id"); cases.append(bad)
        for delta in (-600, 600): cases.append(self.signed("payment.succeeded", {"payment_id": "pay_1"}, at=datetime.fromtimestamp(time.time() + delta, timezone.utc)))
        cases.append(self.signed("payment.succeeded", {"payment_id": "pay_1"}, business="bus_other"))
        for event in cases:
            with self.subTest(event=event["headers"]): self.assertEqual(billing.lambda_handler(event, None)["statusCode"], 401)
        self.assertEqual(billing.store().scan()["Count"], 0)

    def test_base64_webhook_verifies_original_bytes_and_inbox_has_no_customer_payload(self):
        event = self.signed("payment.succeeded", {"payment_id": "pay_1", "customer": {"email": "private@example.com"}}, encoded=True)
        self.assertEqual(billing.lambda_handler(event, None)["statusCode"], 200)
        item = billing.read("EVENT", "evt_1", "EVENT")
        self.assertNotIn("private@example.com", str(item)); self.assertNotIn("data", item)

    def test_delayed_active_or_payment_event_cannot_resurrect_cancelled_subscription(self):
        self.purchase(); self.pay(); self.deliver()
        self.subscriptions["sub_1"]["status"] = "cancelled"
        self.deliver("subscription.cancelled", "evt_2", "sub_1")
        self.assertFalse(self.access()["premium"])
        self.deliver("subscription.active", "evt_3", "sub_1")
        self.deliver("payment.succeeded", "evt_4")
        self.assertFalse(self.access()["premium"])

    def test_scheduled_cancellation_keeps_access_until_paid_end(self):
        self.purchase(); self.pay(); self.subscriptions["sub_1"]["cancel_at_next_billing_date"] = True
        self.deliver("subscription.updated", resource="sub_1")
        self.assertTrue(self.access()["premium"])
        self.assertTrue(billing.status(self.alice)["cancelAtPeriodEnd"])

    def test_refund_before_payment_delivery_remains_revoked_after_delayed_success(self):
        self.purchase(); self.pay(refund_status="full")
        self.deliver("refund.succeeded")
        self.deliver("payment.succeeded", "evt_2")
        self.assertFalse(self.access()["premium"])

    def test_partial_refund_keeps_access_full_refund_removes_it(self):
        self.purchase(); self.pay(refund_status="partial"); self.deliver("refund.succeeded")
        self.assertTrue(self.access()["premium"])
        self.payments["pay_1"]["refund_status"] = "full"
        self.deliver("refund.succeeded", "evt_2")
        self.assertFalse(self.access()["premium"])

    def test_refund_of_expired_period_does_not_remove_new_paid_period(self):
        self.purchase(); self.pay(refund_status="full", service_periods=[{
            "subscription_id": "sub_1", "starts_at": iso(time.time() - 60 * 86400), "ends_at": iso(time.time() - 30 * 86400)}])
        self.pay(payment_id="pay_2", charge_type="renewal")
        self.deliver("refund.succeeded")
        self.assertTrue(self.access()["premium"])

    def test_missing_financial_state_cannot_be_treated_as_no_refund_or_dispute(self):
        self.purchase(); self.pay()
        for field in ("refund_status", "dispute_status"):
            payment = copy.deepcopy(self.payments["pay_1"]); payment.pop(field)
            with self.assertRaises(AccessError): worker.payment_access(payment, "sub_1", "cus_1", int(time.time()))

    def test_open_dispute_blocks_period_and_won_dispute_restores_confirmed_period(self):
        self.purchase(); self.pay(dispute_status="dispute_opened"); self.deliver("dispute.opened")
        self.assertFalse(self.access()["premium"])
        self.payments["pay_1"]["dispute_status"] = "dispute_won"
        self.deliver("dispute.won", "evt_2")
        self.assertTrue(self.access()["premium"])

    def test_zero_value_card_check_trial_or_usage_only_payment_never_unlocks_pro(self):
        self.purchase()
        for i, changes in enumerate(({"total_amount": 0}, {"charge_type": None}, {"service_periods": []}, {"charge_type": "on_demand"})):
            self.pay(**changes); self.deliver("payment.succeeded", "evt_" + str(i))
            self.assertFalse(self.access()["premium"])

    def test_failed_held_paused_and_expired_subscriptions_do_not_authorize_ai(self):
        self.purchase(); self.pay()
        for i, state in enumerate(("pending", "failed", "on_hold", "paused", "expired")):
            self.subscriptions["sub_1"]["status"] = state
            self.deliver("subscription.updated", "evt_" + str(i), "sub_1")
            self.assertFalse(self.access()["premium"])

    def test_unknown_intent_or_unapproved_product_cannot_grant(self):
        self.purchase(); self.pay(); self.subscriptions["sub_1"]["metadata"] = {"focusfeed_intent": "unknown"}
        self.deliver()
        self.assertFalse(self.access()["premium"])
        self.subscriptions["sub_1"]["metadata"] = self.payments["pay_1"]["metadata"]
        self.subscriptions["sub_1"]["product_id"] = "pdt_other"
        with self.assertRaises(AccessError): self.deliver("payment.succeeded", "evt_2")
        self.assertFalse(self.access()["premium"])

    def test_customer_cannot_be_rebound_to_another_account_with_same_email(self):
        self.purchase(); self.pay(); self.deliver()
        self.purchase(self.bob)
        self.subscriptions["sub_2"]["customer"] = {"customer_id": "cus_1"}
        self.pay("sub_2", "pay_2")
        with self.assertRaises(Exception): self.deliver("payment.succeeded", "evt_2", "pay_2")
        self.assertEqual(billing.read("CUSTOMER", "cus_1")["subject"], "alice")
        self.assertFalse(self.access(self.bob)["premium"])

    def test_customer_portal_is_bound_to_verified_account_and_uses_fixed_return_url(self):
        self.purchase(); self.pay(); self.deliver()
        result = billing.portal(self.alice)
        self.assertIn("test.customer.dodopayments.com", result["url"])
        self.assertEqual(self.calls[-1][1], "/customers/cus_1/customer-portal/session")
        self.assertEqual(self.calls[-1][3]["send_email"], "false")
        with self.assertRaises(AccessError): billing.portal(self.bob)
        with self.assertRaises(AccessError): billing.checkout(self.alice)

    def test_billing_http_rejects_identity_price_and_redirect_overrides(self):
        with patch.object(billing, "authenticate", return_value=self.alice):
            for path in ("/billing/checkout", "/billing/portal", "/billing/refresh"):
                for data in ({"userId": "bob"}, {"product_id": "cheap-product"}, {"return_url": "https://evil.example"}, {"amount": 1}):
                    result = billing.lambda_handler({"httpMethod": "POST", "rawPath": path, "body": json.dumps(data)}, None)
                    self.assertEqual(result["statusCode"], 400)
            accounts.revoke_session(self.alice)
            self.assertEqual(billing.lambda_handler({"httpMethod": "POST", "rawPath": "/billing/checkout", "body": "{}"}, None)["statusCode"], 401)
        self.assertEqual(self.calls, [])

    def test_default_auth_rejects_anonymous_and_local_developer_billing(self):
        with patch.dict(os.environ, {"FOCUSFEED_AUTH_MODE": "local", "AWS_LAMBDA_FUNCTION_NAME": ""}):
            event = {"httpMethod": "POST", "rawPath": "/billing/checkout", "_focusfeed_local_request": True}
            self.assertEqual(billing.lambda_handler(event, None)["statusCode"], 403)
            event.pop("_focusfeed_local_request")
            self.assertEqual(billing.lambda_handler(event, None)["statusCode"], 401)

    def test_return_page_ignores_forged_success_parameters_and_grants_nothing(self):
        result = billing.lambda_handler({"httpMethod": "GET", "rawPath": "/billing/return", "rawQueryString": "status=active&userId=alice"}, None)
        self.assertEqual(result["statusCode"], 200)
        self.assertFalse(self.access()["premium"])

    def test_provider_outage_preserves_record_but_stale_paid_access_fails_closed(self):
        self.purchase(); self.pay(); self.deliver()
        before = accounts.table("access").get_item(Key={"userId": "alice"})["Item"]
        with patch.object(dodo, "request", side_effect=AccessError(503, "provider_unavailable", "offline")):
            with self.assertRaises(AccessError): worker.reconcile("alice")
        self.assertEqual(accounts.table("access").get_item(Key={"userId": "alice"})["Item"], before)
        accounts.table("access").update_item(Key={"userId": "alice"}, UpdateExpression="SET verifiedAt = :old", ExpressionAttributeValues={":old": int(time.time()) - 86401})
        self.assertFalse(self.access()["premium"])

    def test_existing_beta_grant_survives_unpaid_activation_and_refund(self):
        beta_end = int(time.time()) + 45 * 86400
        accounts.table("access").put_item(Item={"userId": "alice", "status": "active", "source": "operator-beta", "accessUntil": beta_end})
        self.purchase(); self.deliver("subscription.active", resource="sub_1")
        self.assertEqual(self.access()["accessUntil"], beta_end)
        self.pay(refund_status="full"); self.deliver("refund.succeeded", "evt_2")
        self.assertEqual(self.access()["accessUntil"], beta_end)

    def test_test_and_live_records_are_isolated(self):
        self.purchase(); self.pay(); self.deliver()
        with patch.dict(os.environ, {"DODO_ENVIRONMENT": "live_mode", "FOCUSFEED_BILLING_MODE": "live_mode"}):
            self.assertEqual(billing.read("USER", "alice"), {})
            self.assertFalse(self.access()["premium"])

    def test_scheduled_reconciliation_recovers_missed_cancellation_webhook(self):
        self.purchase(); self.pay(); self.deliver()
        self.subscriptions["sub_1"]["status"] = "cancelled"
        billing.store().update_item(Key=billing.key("USER", "alice"), UpdateExpression="SET reconcileAt = :due", ExpressionAttributeValues={":due": 0})
        worker.lambda_handler({"source": "aws.events"}, None)
        self.assertFalse(self.access()["premium"])

    def test_scheduled_reconciliation_recovers_missed_first_payment_webhook(self):
        self.purchase(); self.pay()
        self.sessions["cks_1"].update(payment_id="pay_1", payment_status="succeeded")
        billing.store().update_item(Key=billing.key("USER", "alice"), UpdateExpression="SET reconcileAt = :due", ExpressionAttributeValues={":due": 0})
        worker.lambda_handler({"source": "aws.events"}, None)
        self.assertTrue(self.access()["premium"])

    def test_pending_and_abandoned_checkouts_are_rechecked_then_stop_polling(self):
        self.purchase(); worker.reconcile("alice")
        self.assertGreater(billing.read("USER", "alice")["reconcileAt"], time.time())
        billing.store().update_item(Key=billing.key("USER", "alice"), UpdateExpression="SET checkoutUntil = :old", ExpressionAttributeValues={":old": 1})
        worker.reconcile("alice")
        self.assertNotIn("reconcileGroup", billing.read("USER", "alice"))

    def test_successful_checkout_does_not_create_a_second_subscription_while_confirmation_is_pending(self):
        self.purchase(); self.pay(); self.sessions["cks_1"].update(payment_id="pay_1", payment_status="succeeded")
        with self.assertRaises(AccessError) as error: self.purchase()
        self.assertEqual(error.exception.code, "payment_pending")
        self.assertEqual(len(self.subscriptions), 1)

    def test_concurrent_reconciler_cannot_overwrite_with_an_older_snapshot(self):
        self.purchase(); self.pay(); self.deliver()
        billing.store().update_item(Key=billing.key("USER", "alice"), UpdateExpression="SET lockOwner = :owner, lockUntil = :until", ExpressionAttributeValues={":owner": "other", ":until": int(time.time()) + 100})
        with self.assertRaises(Exception): worker.reconcile("alice")
        self.assertEqual(billing.read("USER", "alice")["lockOwner"], "other")

    def test_failed_event_is_retried_and_not_acknowledged_as_completed(self):
        self.purchase(); self.pay()
        event = self.signed("payment.succeeded", {"payment_id": "pay_1"})
        billing.lambda_handler(event, None)
        record = {"eventName": "INSERT", "dynamodb": {"SequenceNumber": "42", "Keys": {
            name: {"S": value} for name, value in billing.key("EVENT", "evt_1", "EVENT").items()}}}
        with patch.object(dodo, "request", side_effect=RuntimeError("outage")):
            result = worker.lambda_handler({"Records": [record]}, None)
            self.assertEqual(result["batchItemFailures"], [{"itemIdentifier": "42"}])
        self.assertEqual(billing.read("EVENT", "evt_1", "EVENT")["status"], "pending")
        self.assertEqual(worker.lambda_handler({"Records": [record]}, None)["batchItemFailures"], [])
        self.assertTrue(self.access()["premium"])


class ProviderAdapterTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, ENV); env.start(); self.addCleanup(env.stop)

    def test_fixed_environment_hosts_and_bounded_authenticated_request(self):
        response = io.BytesIO(b'{"items": []}')
        with patch.object(dodo, "build_opener") as opener:
            opener.return_value.open.return_value = response
            self.assertEqual(dodo.request("GET", "/payments", query={"subscription_id": "sub_1"}), {"items": []})
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://test.dodopayments.com/payments?subscription_id=sub_1")
            self.assertEqual(request.get_header("Authorization"), "Bearer test-merchant-secret")
            self.assertEqual(opener.return_value.open.call_args.kwargs["timeout"], 6)

    def test_links_reject_other_hosts_credentials_wrong_modes_and_non_https(self):
        for url in ("https://evil.example", "http://test.checkout.dodopayments.com/x", "https://test.checkout.dodopayments.com.evil/x", "https://a:b@test.checkout.dodopayments.com/x", "https://checkout.dodopayments.com/x"):
            with self.assertRaises(AccessError): dodo.link(url, "checkout")
        self.assertIsNone(dodo.NoRedirect().redirect_request(None, None, None, None, None, None))


if __name__ == "__main__":
    unittest.main()
