"""Durable, account-owned jobs. DynamoDB Streams removes the enqueue dual-write gap."""

import hashlib
import json
import logging
import os
import re
import time
import uuid

try:
    from .accounts import table, require_session, require_premium
    from .auth import AccessError, Principal
    from . import controls
except ImportError:
    from accounts import table, require_session, require_premium
    from auth import AccessError, Principal
    import controls


logger = logging.getLogger("focusfeed.jobs")
JOB_LIFETIME = 600
WORKER_SECONDS = 240


def job_table():
    try:
        return table(os.environ["FOCUSFEED_JOB_TABLE"])
    except Exception as exc:
        raise AccessError(503, "jobs_unavailable", "AI job storage is unavailable.") from exc


def key(subject, job_id):
    return {"pk": "USER#" + subject, "sk": "JOB#" + job_id}


def read(subject, job_id):
    try:
        return job_table().get_item(Key=key(subject, job_id), ConsistentRead=True).get("Item")
    except Exception as exc:
        raise AccessError(503, "jobs_unavailable", "AI job storage is unavailable.") from exc


def submit(principal, route, request):
    rules = controls.policy()
    now = int(time.time())
    payload = request.model_dump_json(by_alias=True)
    fingerprint = hashlib.sha256((route + "\n" + payload).encode()).hexdigest()
    # Stable for retries of this operation, isolated by authenticated subject.
    job_id = hashlib.sha256((route + "\n" + request.request_id).encode()).hexdigest()
    existing = read(principal.subject, job_id)
    if existing:
        if existing["fingerprint"] != fingerprint:
            raise AccessError(409, "request_conflict", "This request ID was already used for different input.")
        return public(existing)
    day, _month = controls.periods(now)
    job = {**key(principal.subject, job_id), "jobId": job_id, "subject": principal.subject,
           "sessionId": principal.session_id, "route": route, "payload": payload,
           "fingerprint": fingerprint, "status": "queued", "createdAt": now,
           "deadline": now + JOB_LIFETIME, "expiresAt": now + 86400}
    # A fixed set of leased slots bounds all queued/running work for this user.
    # Expiry does not rely on DynamoDB TTL deletion. Worker execution must end
    # before the lease, even when a process is killed before releasing it.
    for slot in range(rules.concurrentJobs):
        job["slot"] = slot
        actions = [
            {"Put": {"TableName": os.environ["FOCUSFEED_JOB_TABLE"], "Item": controls.fields(job),
                     "ConditionExpression": "attribute_not_exists(pk)"}},
            {"Put": {"TableName": os.environ["FOCUSFEED_USER_TABLE"],
                     "Item": controls.fields({"pk": "USER#" + principal.subject, "sk": "SLOT#" + str(slot),
                                             "jobId": job_id, "leaseUntil": now + JOB_LIFETIME + WORKER_SECONDS,
                                             "expiresAt": now + 86400}),
                     "ConditionExpression": "attribute_not_exists(pk) OR leaseUntil < :now",
                     "ExpressionAttributeValues": controls.fields({":now": now})}},
            controls.counter("USER#" + principal.subject, "JOBS#" + day, 1, rules.jobsPerDay, now + 3 * 86400),
            controls.counter("USER#" + principal.subject, "MINUTE#" + str(now // 60), 1, rules.jobsPerMinute, now + 86400),
        ]
        try:
            controls.transaction(actions)
            logger.warning(json.dumps({"event": "job_queued", "route": route, "policyRevision": rules.revision}))
            return public(job)
        except Exception as exc:
            if controls.conditional_failure(exc):
                existing = read(principal.subject, job_id)
                if existing:
                    if existing["fingerprint"] != fingerprint:
                        raise AccessError(409, "request_conflict", "This request ID was already used for different input.")
                    return public(existing)
                # Only a slot collision benefits from trying another slot.
                reasons = exc.response.get("CancellationReasons", [])
                if any(r.get("Code") == "ConditionalCheckFailed" for r in reasons[2:]):
                    raise AccessError(429, "request_limit", "Too many AI requests. Try again after your allowance resets.") from exc
                continue
            raise AccessError(503, "jobs_unavailable", "Could not queue AI work. Retry the same request.") from exc
    raise AccessError(429, "concurrent_limit", "Your other AI requests are still running. Try again shortly.")


def public(job):
    status = job["status"]
    if status in ("queued", "running") and job["deadline"] <= int(time.time()):
        # Never restart ambiguous work after a worker crash. Its cost may already
        # have been incurred; a deliberate new request is needed.
        return {"jobId": job["jobId"], "status": "failed", "error": {
            "code": "job_expired", "message": "This AI request expired. Try again.", "status": 504}}
    value = {"jobId": job["jobId"], "status": status, "pollAfterMs": 1500}
    if status == "completed":
        result = json.loads(job["result"])
        # Relative score TTLs were calculated when classification finished, not
        # when a restarted browser eventually retrieves the durable result.
        elapsed = max(0, int(time.time() * 1000) - int(job.get("completedAtMs", 0)))
        cache = result.get("diagnostics", {}).get("cache", {})
        for section in ("byQuestion", "byVideo"):
            for entry in cache.get(section, {}).values():
                if "expiresInMs" in entry:
                    entry["expiresInMs"] = max(0, entry["expiresInMs"] - elapsed)
        value["result"] = result
    if status == "failed":
        value["error"] = json.loads(job["error"])
    return value


def poll(principal, job_id):
    if not re.fullmatch(r"[a-f0-9]{64}", job_id):
        raise AccessError(404, "job_not_found", "AI request not found.")
    job = read(principal.subject, job_id)
    if not job or job["expiresAt"] <= int(time.time()):
        raise AccessError(404, "job_not_found", "AI request not found.")
    return public(job)


def finish(job, owner, result=None, error=None):
    status = "failed" if error else "completed"
    document = json.dumps(error if error else result, separators=(",", ":"))
    if len(document.encode()) > 250_000:
        status, document = "failed", json.dumps({"code": "result_too_large", "message": "AI result was too large.", "status": 502})
    attribute = "error" if status == "failed" else "result"
    controls.transaction([
        {"Update": {"TableName": os.environ["FOCUSFEED_JOB_TABLE"], "Key": controls.fields(key(job["subject"], job["jobId"])),
                    "UpdateExpression": "SET #state = :state, #document = :document, completedAtMs = :completed REMOVE payload",
                    "ConditionExpression": "#state = :running AND #owner = :owner",
                    "ExpressionAttributeNames": {"#state": "status", "#document": attribute, "#owner": "owner"},
                    "ExpressionAttributeValues": controls.fields({":state": status, ":document": document,
                                                                 ":running": "running", ":owner": owner,
                                                                 ":completed": int(time.time() * 1000)})}},
        {"Delete": {"TableName": os.environ["FOCUSFEED_USER_TABLE"],
                    "Key": controls.fields({"pk": "USER#" + job["subject"], "sk": "SLOT#" + str(job["slot"])}),
                    "ConditionExpression": "jobId = :job",
                    "ExpressionAttributeValues": controls.fields({":job": job["jobId"]})}},
    ])
    logger.warning(json.dumps({"event": "job_" + status, "route": job["route"],
                               "code": error.get("code") if error else None}))


def run(subject, job_id):
    # Resolve only trusted table keys from the event, then read durable state.
    job = read(subject, job_id)
    if not job or job["status"] != "queued":
        return
    now, owner = int(time.time()), uuid.uuid4().hex
    if job["deadline"] <= now:
        return
    try:
        job_table().update_item(Key=key(subject, job_id),
            UpdateExpression="SET #state = :running, #owner = :owner",
            ConditionExpression="#state = :queued AND deadline > :now",
            ExpressionAttributeNames={"#state": "status", "#owner": "owner"},
            ExpressionAttributeValues={":running": "running", ":queued": "queued", ":owner": owner, ":now": now})
    except Exception as exc:
        if controls.conditional_failure(exc):
            return
        raise
    try:
        try:
            from .handler import classification_routes, classifier_failure
            from .user_cache import scoped_cache
        except ImportError:
            from handler import classification_routes, classifier_failure
            from user_cache import scoped_cache
        principal = Principal(subject, session_id=job["sessionId"])
        require_session(principal)
        require_premium(principal)
        controls.policy()
        model, classify = classification_routes()[job["route"]]
        request = model.model_validate_json(job["payload"])
        with controls.provider_scope(principal, min(job["deadline"], now + WORKER_SECONDS - 10)):
            result = classify(request, cache=scoped_cache(principal)) if job["route"] == "/classify" else classify(request)
        body = result.model_dump(by_alias=True)
        # Store only results/usage, not repeated copies of titles and prompts.
        diagnostics = body.get("diagnostics", {})
        diagnostics.pop("jevRequest", None)
        diagnostics.pop("jevRequests", None)
    except Exception as exc:
        if isinstance(exc, AccessError):
            error = {"code": exc.code, "message": str(exc), "status": exc.status}
        else:
            code, message = classifier_failure(exc)
            error = {"code": code, "message": message, "status": 502}
        finish(job, owner, error=error)
        return
    finish(job, owner, result=body)


def worker_handler(event, _context):
    failures = []
    for record in event.get("Records", []):
        if record.get("eventName") != "INSERT":
            continue
        try:
            keys = record["dynamodb"]["Keys"]
            pk, sk = keys["pk"]["S"], keys["sk"]["S"]
            if pk.startswith("USER#") and re.fullmatch(r"JOB#[a-f0-9]{64}", sk):
                run(pk[5:], sk[4:])
        except Exception:
            # Do not log the stream payload: it contains private request text.
            logger.warning('{"event":"job_worker_storage_failure"}')
            failures.append({"itemIdentifier": record["dynamodb"]["SequenceNumber"]})
    return {"batchItemFailures": failures}
