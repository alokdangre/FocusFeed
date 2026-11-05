"""Server-owned policy and atomic cost reservations. No customer-writable switches."""

import contextvars
import json
import logging
import math
import os
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from pydantic import BaseModel, ConfigDict, Field, StrictBool

try:
    from .accounts import table, data_table, require_session, require_premium
    from .auth import AccessError
except ImportError:
    from accounts import table, data_table, require_session, require_premium
    from auth import AccessError


class Policy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(default=1, ge=1)
    aiEnabled: StrictBool = True
    jobsPerMinute: int = Field(default=30, ge=1, le=300)
    jobsPerDay: int = Field(default=1000, ge=1, le=100000)
    concurrentJobs: int = Field(default=3, ge=1, le=10)
    questionsPerDay: int = Field(default=5000, ge=1, le=1000000)
    globalDailyMicroUsd: int = Field(default=2_000_000, ge=1, le=1_000_000_000)
    globalMonthlyMicroUsd: int = Field(default=20_000_000, ge=1, le=10_000_000_000)


def policy() -> Policy:
    """Uncached: operator changes take effect at the next admission/AI dispatch."""
    try:
        name = os.environ["FOCUSFEED_CONFIG_TABLE"]
        item = table(name).get_item(Key={"id": "policy"}, ConsistentRead=True).get("Item")
        value = Policy.model_validate_json(item["document"]) if item else Policy()
    except Exception as exc:
        raise AccessError(503, "policy_unavailable", "AI settings are temporarily unavailable.") from exc
    if not value.aiEnabled:
        raise AccessError(503, "ai_paused", "AI filtering is temporarily paused. Free controls still work.")
    return value


def transaction(actions):
    # A standalone low-level client avoids boto3 Resource's implicit marshalling
    # hooks. Every key/value here is an explicit DynamoDB AttributeValue.
    client = boto3.client("dynamodb", config=Config(connect_timeout=3, read_timeout=5,
                           retries={"max_attempts": 2, "mode": "standard"}))
    return client.transact_write_items(TransactItems=actions, ClientRequestToken=uuid.uuid4().hex)


def fields(values):
    from boto3.dynamodb.types import TypeSerializer
    serializer = TypeSerializer()
    return {key: serializer.serialize(value) for key, value in values.items()}


def counter(pk, sk, amount, limit, expires):
    if amount > limit:
        raise AccessError(429, "usage_limit", "AI allowance reached. Try again after the allowance resets.")
    return {"Update": {
        "TableName": os.environ["FOCUSFEED_USER_TABLE"],
        "Key": fields({"pk": pk, "sk": sk}),
        "UpdateExpression": "SET expiresAt = :ttl ADD used :amount",
        "ConditionExpression": "attribute_not_exists(used) OR used <= :remaining",
        "ExpressionAttributeValues": fields({":ttl": expires, ":amount": amount, ":remaining": limit - amount}),
    }}


def conditional_failure(exc):
    if not isinstance(exc, ClientError):
        return False
    if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
        return True
    return (exc.response["Error"]["Code"] == "TransactionCanceledException" and
            any(item.get("Code") == "ConditionalCheckFailed" for item in exc.response.get("CancellationReasons", [])))


def periods(now):
    date = datetime.fromtimestamp(now, timezone.utc)
    return date.strftime("%Y-%m-%d"), date.strftime("%Y-%m")


_dispatch = contextvars.ContextVar("focusfeed_dispatch", default=None)
logger = logging.getLogger("focusfeed.usage")


@contextmanager
def provider_scope(principal, deadline):
    marker = _dispatch.set((principal, deadline))
    try:
        yield
    finally:
        _dispatch.reset(marker)


def before_provider(payload):
    context = _dispatch.get()
    if context is None:
        if os.getenv("AWS_LAMBDA_FUNCTION_NAME"):
            raise AccessError(503, "missing_reservation", "AI work must run through the protected job worker.")
        return None  # Explicit local developer execution uses the owner's key.
    principal, deadline = context
    now = int(time.time())
    if deadline - now < 95:
        raise AccessError(503, "job_deadline", "This AI request ran out of time. Try a smaller batch.")
    require_session(principal)
    require_premium(principal)
    rules = policy()
    # These pinned text models have a documented 64k request context and free
    # output. Reserve the full 65,536 tokens, never a bytes-to-token guess.
    # No long-context header or provider retries are enabled in call_typesafe.
    if payload.get("model") not in ("jev-1.13.0", "jev-1.14.0"):
        raise AccessError(503, "unpriced_model", "This AI model needs a reviewed spending limit.")
    questions = len(payload.get("questions", {}))
    if not 1 <= questions <= 96:
        raise AccessError(400, "question_limit", "Too many AI questions in one request.")
    reservation = math.ceil(65536 * 0.042)  # micro-USD, $0.042 / million input tokens
    day, month = periods(now)
    try:
        transaction([
            counter("USER#" + principal.subject, "QUESTIONS#" + day, questions, rules.questionsPerDay, now + 3 * 86400),
            counter("BUDGET", "DAY#" + day, reservation, rules.globalDailyMicroUsd, now + 40 * 86400),
            counter("BUDGET", "MONTH#" + month, reservation, rules.globalMonthlyMicroUsd, now + 400 * 86400),
        ])
    except AccessError:
        raise
    except Exception as exc:
        if conditional_failure(exc):
            raise AccessError(429, "usage_limit", "AI allowance or service spending limit reached. Free controls still work.") from exc
        raise AccessError(503, "usage_unavailable", "Could not safely reserve AI usage. Try again later.") from exc
    # Reservation is retained even after a timeout or provider error. This is
    # deliberately conservative: uncertain provider charges never get refunded.
    return {"day": day, "month": month, "reservedMicroUsd": reservation,
            "questions": questions, "policyRevision": rules.revision}


def record_usage(reservation, result, elapsed_ms):
    if reservation is None:
        return
    usage = result.get("usage", {})
    tokens = usage.get("input_tokens") if isinstance(usage, dict) else None
    valid = type(tokens) is int and 0 <= tokens <= 65536
    event = {"event": "ai_usage", **reservation, "durationMs": elapsed_ms,
             "inputTokens": tokens if valid else None, "usageValid": valid}
    logger.warning(json.dumps(event, separators=(",", ":")))
    if not valid:
        # Keep the entire reservation; do not log response text or personal data.
        raise AccessError(503, "provider_usage_invalid", "AI usage could not be verified.")
    try:
        data_table().update_item(Key={"pk": "METRICS", "sk": "DAY#" + reservation["day"]},
            UpdateExpression="SET expiresAt = :ttl ADD inputTokens :tokens, providerCalls :one, durationMs :ms",
            ExpressionAttributeValues={":ttl": int(time.time()) + 40 * 86400, ":tokens": tokens,
                                       ":one": 1, ":ms": elapsed_ms})
    except Exception:
        # Analytics is best effort. Authoritative spend reservation already committed.
        logger.warning('{"event":"usage_metrics_write_failed"}')
