"""Durable account access. The API's IAM role can READ, never grant entitlements."""

import os
import threading
import time
from decimal import Decimal

import boto3
from botocore.config import Config

try:
    from .auth import AccessError, Principal
except ImportError:
    from auth import AccessError, Principal


_tables = threading.local()


def table(name: str):
    # boto3 resource objects are not shared between the development HTTP server's
    # threads. Lambda also reuses its own thread's connections across invocations.
    if not hasattr(_tables, "values"):
        _tables.values = {}
    if name not in _tables.values:
        _tables.values[name] = boto3.Session().resource("dynamodb", config=Config(connect_timeout=3, read_timeout=5,
            retries={"max_attempts": 2, "mode": "standard"})).Table(name)
    return _tables.values[name]


def data_table():
    name = os.getenv("FOCUSFEED_USER_TABLE", "")
    if not name:
        raise AccessError(503, "account_unavailable", "Account storage has not been configured.")
    return table(name)


def require_session(principal: Principal):
    if principal.local:
        return
    try:
        item = data_table().get_item(Key={"pk": "USER#" + principal.subject, "sk": "SESSION#" + principal.session_id},
                                     ConsistentRead=True).get("Item", {})
        if item.get("revoked") is True and item.get("expiresAt", 0) > int(time.time()):
            raise AccessError(401, "invalid_session", "This session was signed out. Sign in again.")
    except AccessError:
        raise
    except Exception as exc:
        raise AccessError(503, "account_unavailable", "Account verification is temporarily unavailable.") from exc


def revoke_session(principal: Principal):
    if principal.local:
        return
    try:
        # The SAM client issues 30-day refresh tokens. Keep the denial beyond
        # that lifetime so a failed provider-revocation call cannot renew it.
        data_table().put_item(Item={"pk": "USER#" + principal.subject, "sk": "SESSION#" + principal.session_id,
                                   "revoked": True, "expiresAt": int(time.time()) + 31 * 86400})
    except Exception as exc:
        raise AccessError(503, "account_unavailable", "Could not sign out the server session. Try again.") from exc


def account(principal: Principal, *, touch: bool = True) -> dict:
    if principal.local:
        return {"userId": principal.subject, "mode": "local", "premium": True, "accessUntil": None}
    name = os.getenv("FOCUSFEED_ACCESS_TABLE", "")
    if not name:
        raise AccessError(503, "account_unavailable", "Subscription access is temporarily unavailable.")
    try:
        # Strongly consistent, uncached reads: expiry/revocation applies to the
        # next admitted request, including requests whose scores are cached.
        item = table(name).get_item(Key={"userId": principal.subject}, ConsistentRead=True).get("Item", {})
        expires = item.get("accessUntil", 0)
        premium = (item.get("status") == "active" and isinstance(expires, (int, Decimal)) and
                   not isinstance(expires, bool) and expires > int(time.time()))
        now = int(time.time())
        if premium and item.get("source") == "dodo" and item.get("betaUntil", 0) <= now:
            premium = (item.get("mode") == os.getenv("FOCUSFEED_BILLING_MODE", "disabled") and
                       isinstance(item.get("verifiedAt"), (int, Decimal)) and not isinstance(item["verifiedAt"], bool)
                       and item["verifiedAt"] + 86400 > now)
        if touch:
            data_table().update_item(Key={"pk": "USER#" + principal.subject, "sk": "PROFILE"},
                UpdateExpression="SET createdAt = if_not_exists(createdAt, :now), lastSeenAt = :now",
                ExpressionAttributeValues={":now": now})
        return {"userId": principal.subject, "mode": "required", "premium": bool(premium),
                "accessUntil": int(expires) if premium else None}
    except AccessError:
        raise
    except Exception as exc:
        raise AccessError(503, "account_unavailable", "Subscription access is temporarily unavailable.") from exc


def require_premium(principal: Principal) -> dict:
    value = account(principal, touch=False)
    if not value["premium"]:
        raise AccessError(403, "subscription_required", "An active OwnFeed Pro subscription is required for AI filtering.")
    return value
