"""DynamoDB-emulated integration tests: actual conditional/transaction API calls."""

import json
import io
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import accounts
import controls
import jobs
import handler
import classifier
from auth import AccessError, Principal
from models import ObjectiveClassificationRequest
from test_classifier import objective_payload, request_payload


ENV = {"AWS_DEFAULT_REGION": "ap-south-1", "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
       "AWS_SESSION_TOKEN": "testing", "AWS_LAMBDA_FUNCTION_NAME": "test-worker", "AWS_EC2_METADATA_DISABLED": "true",
       "FOCUSFEED_USER_TABLE": "users", "FOCUSFEED_ACCESS_TABLE": "access", "FOCUSFEED_CONFIG_TABLE": "config",
       "FOCUSFEED_JOB_TABLE": "jobs", "TYPESAFE_API_KEY": "test-key", "TYPESAFE_MODEL": "jev-1.13.0"}


class JobTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, ENV); env.start(); self.addCleanup(env.stop)
        mock = mock_aws(); mock.start(); self.addCleanup(mock.stop)
        accounts._tables.values = {}
        db = boto3.resource("dynamodb")
        for name, names in (("users", ["pk", "sk"]), ("jobs", ["pk", "sk"]), ("access", ["userId"]), ("config", ["id"])):
            db.create_table(TableName=name, BillingMode="PAY_PER_REQUEST",
                KeySchema=[{"AttributeName": name, "KeyType": "HASH" if i == 0 else "RANGE"} for i, name in enumerate(names)],
                AttributeDefinitions=[{"AttributeName": name, "AttributeType": "S"} for name in names])
        self.alice, self.bob = Principal("alice", session_id="alice-session"), Principal("bob", session_id="bob-session")
        for principal in (self.alice, self.bob):
            accounts.table("access").put_item(Item={"userId": principal.subject, "status": "active", "accessUntil": int(time.time()) + 3600})

    def rules(self, **updates):
        rules = controls.Policy(**updates)
        accounts.table("config").put_item(Item={"id": "policy", "document": rules.model_dump_json()})

    def request(self, name="request-123"):
        payload = objective_payload(); payload["requestId"] = name
        return ObjectiveClassificationRequest.model_validate(payload)

    def submit(self, principal=None, name="request-123"):
        return jobs.submit(principal or self.alice, "/objectives/classify", self.request(name))

    def used(self, pk, sk):
        return accounts.data_table().get_item(Key={"pk": pk, "sk": sk}, ConsistentRead=True).get("Item", {}).get("used", 0)

    def dispatch(self, principal=None, model="jev-1.13.0", questions=2):
        with controls.provider_scope(principal or self.alice, int(time.time()) + 200):
            return controls.before_provider({"model": model, "questions": {str(i): {} for i in range(questions)}})

    def test_duplicate_submission_is_one_job_and_changed_input_conflicts(self):
        first = self.submit(); again = self.submit()
        self.assertEqual(first, again)
        day, _ = controls.periods(time.time())
        self.assertEqual(self.used("USER#alice", "JOBS#" + day), 1)
        changed = self.request().model_copy(update={"objectives": ["a different topic"]})
        with self.assertRaises(AccessError) as error: jobs.submit(self.alice, "/objectives/classify", changed)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.used("USER#alice", "JOBS#" + day), 1)

    def test_job_read_is_account_scoped_and_expiry_is_enforced_without_ttl_deletion(self):
        job = self.submit()
        with self.assertRaises(AccessError) as error: jobs.poll(self.bob, job["jobId"])
        self.assertEqual(error.exception.status, 404)
        accounts.table("jobs").update_item(Key=jobs.key("alice", job["jobId"]), UpdateExpression="SET deadline = :past", ExpressionAttributeValues={":past": 1})
        self.assertEqual(jobs.poll(self.alice, job["jobId"])["error"]["code"], "job_expired")
        with patch.object(handler, "classify_objectives") as classify:
            jobs.run("alice", job["jobId"]); classify.assert_not_called()

    def test_slots_are_bounded_and_released_after_completion(self):
        self.rules(concurrentJobs=1)
        first = self.submit()
        with self.assertRaises(AccessError) as error: self.submit(name="second-request")
        self.assertEqual(error.exception.code, "concurrent_limit")
        result = SimpleNamespace(model_dump=lambda **kwargs: {"requestId": "request-123", "diagnostics": {"jevRequest": {"private": "text"}}})
        with patch.object(handler, "classify_objectives", return_value=result) as classify:
            jobs.run("alice", first["jobId"]); jobs.run("alice", first["jobId"])
            classify.assert_called_once()
        saved = jobs.read("alice", first["jobId"])
        self.assertNotIn("payload", saved)
        self.assertNotIn("jevRequest", jobs.poll(self.alice, first["jobId"])["result"]["diagnostics"])
        self.assertEqual(self.submit(name="second-request")["status"], "queued")

    def test_daily_and_minute_admission_limits_roll_back_slot_and_job_writes(self):
        for field in ("jobsPerDay", "jobsPerMinute"):
            with self.subTest(field=field):
                self.rules(**{field: 1})
                # Separate user each subtest to keep durable counters independent.
                principal = Principal(field, session_id="session")
                self.submit(principal, "first-request")
                with self.assertRaises(AccessError) as error: self.submit(principal, "second-request")
                self.assertEqual(error.exception.code, "request_limit")
                items = accounts.table("jobs").scan()["Items"]
                self.assertEqual(len([item for item in items if item["subject"] == field]), 1)
                self.assertNotIn("Item", accounts.data_table().get_item(Key={"pk": "USER#" + field, "sk": "SLOT#1"}))

    def test_expired_slot_can_be_reclaimed_without_ttl_cleanup(self):
        self.rules(concurrentJobs=1); self.submit()
        accounts.data_table().update_item(Key={"pk": "USER#alice", "sk": "SLOT#0"}, UpdateExpression="SET leaseUntil = :past", ExpressionAttributeValues={":past": 1})
        self.assertEqual(self.submit(name="new-request")["status"], "queued")

    def test_budget_and_questions_are_atomic_across_users_and_periods(self):
        self.rules(globalDailyMicroUsd=2753, globalMonthlyMicroUsd=2753)
        self.assertEqual(self.dispatch()["reservedMicroUsd"], 2753)
        with self.assertRaises(AccessError) as error: self.dispatch(self.bob)
        self.assertEqual(error.exception.status, 429)
        day, month = controls.periods(time.time())
        self.assertEqual(self.used("USER#bob", "QUESTIONS#" + day), 0)
        self.assertEqual(self.used("BUDGET", "DAY#" + day), 2753)
        self.assertEqual(self.used("BUDGET", "MONTH#" + month), 2753)

    def test_monthly_budget_blocks_next_day_and_question_limit_blocks_before_cost(self):
        self.rules(questionsPerDay=2, globalMonthlyMicroUsd=2753)
        self.dispatch()
        with self.assertRaises(AccessError): self.dispatch()
        day, month = controls.periods(time.time())
        self.assertEqual(self.used("BUDGET", "DAY#" + day), 2753)
        with patch.object(controls, "periods", return_value=("2099-01-02", month)):
            with self.assertRaises(AccessError): self.dispatch(self.bob)
            self.assertEqual(self.used("BUDGET", "DAY#2099-01-02"), 0)

    def test_pause_and_revocation_apply_between_provider_calls(self):
        self.dispatch()
        self.rules(aiEnabled=False)
        with self.assertRaises(AccessError) as error: self.dispatch()
        self.assertEqual(error.exception.code, "ai_paused")
        self.rules()
        accounts.revoke_session(self.alice)
        with self.assertRaises(AccessError) as error: self.dispatch()
        self.assertEqual(error.exception.status, 401)

    def test_revoked_queued_work_never_reaches_classifier(self):
        job = self.submit()
        accounts.table("access").put_item(Item={"userId": "alice", "status": "revoked", "accessUntil": 0})
        with patch.object(handler, "classify_objectives") as classify:
            jobs.run("alice", job["jobId"]); classify.assert_not_called()
        result = jobs.poll(self.alice, job["jobId"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "subscription_required")

    def test_running_job_is_not_reexecuted_after_ambiguous_crash(self):
        job = self.submit()
        accounts.table("jobs").update_item(Key=jobs.key("alice", job["jobId"]), UpdateExpression="SET #s = :s", ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":s": "running"})
        with patch.object(handler, "classify_objectives") as classify:
            jobs.run("alice", job["jobId"]); classify.assert_not_called()

    def test_cloud_provider_call_requires_scope_and_reservation_even_if_directly_invoked(self):
        with patch.object(classifier, "urlopen") as http:
            with self.assertRaises(AccessError): classifier.call_typesafe({"model": "jev-1.13.0", "questions": {"q": {}}})
            http.assert_not_called()
        self.rules(globalDailyMicroUsd=1)
        with controls.provider_scope(self.alice, int(time.time()) + 200), patch.object(classifier, "urlopen") as http:
            with self.assertRaises(AccessError): classifier.call_typesafe({"model": "jev-1.13.0", "questions": {"q": {}}})
            http.assert_not_called()

    def test_provider_failure_keeps_reservation_and_never_retries(self):
        from urllib.error import URLError
        with controls.provider_scope(self.alice, int(time.time()) + 200), patch.object(classifier, "urlopen", side_effect=URLError("offline")) as http:
            with self.assertRaises(classifier.TypeSafeAPIError): classifier.call_typesafe({"model": "jev-1.13.0", "questions": {"q": {}}})
            http.assert_called_once()
        day, _ = controls.periods(time.time())
        self.assertEqual(self.used("BUDGET", "DAY#" + day), 2753)

    def test_unpriced_model_bad_config_and_storage_outage_fail_closed(self):
        with self.assertRaises(AccessError) as error: self.dispatch(model="jev-latest")
        self.assertEqual(error.exception.code, "unpriced_model")
        accounts.table("config").put_item(Item={"id": "policy", "document": '{"unknown":1}'})
        with self.assertRaises(AccessError): self.dispatch()
        self.rules()
        with patch.object(controls, "transaction", side_effect=RuntimeError("offline")):
            with self.assertRaises(AccessError) as error: self.dispatch()
            self.assertEqual(error.exception.code, "usage_unavailable")

    def test_http_submission_and_polling_require_live_account_access(self):
        with patch.object(handler, "authenticate", return_value=self.alice):
            response = handler.lambda_handler({"rawPath": "/objectives/classify", "httpMethod": "POST", "body": json.dumps(objective_payload())}, None)
            self.assertEqual(response["statusCode"], 202)
            job_id = json.loads(response["body"])["jobId"]
            event = {"rawPath": "/jobs/" + job_id, "httpMethod": "GET"}
            self.assertEqual(handler.lambda_handler(event, None)["statusCode"], 200)
            accounts.revoke_session(self.alice)
            self.assertEqual(handler.lambda_handler(event, None)["statusCode"], 401)

    def test_private_stream_handler_uses_keys_and_reports_storage_failure(self):
        job = self.submit()
        record = {"eventName": "INSERT", "dynamodb": {"Keys": controls.fields(jobs.key("alice", job["jobId"])), "SequenceNumber": "1"}}
        with patch.object(jobs, "run", side_effect=RuntimeError("storage")):
            self.assertEqual(jobs.worker_handler({"Records": [record]}, None), {"batchItemFailures": [{"itemIdentifier": "1"}]})

    def test_full_video_job_uses_real_reservation_and_durable_cache_without_charging_cache_hits(self):
        from models import ClassificationRequest
        calls = []
        def provider(request, timeout):
            self.assertLessEqual(timeout, 90)
            payload = json.loads(request.data); calls.append(payload)
            return io.BytesIO(json.dumps({"model": payload["model"], "answers": {
                q: {"type": "noul", "noul": .01} for q in payload["questions"]},
                "usage": {"input_tokens": 100, "output_tokens": 4}}).encode())
        first = ClassificationRequest.model_validate(request_payload())
        second = first.model_copy(update={"request_id": "second-video-job"})
        # Keep both Lambda/cache instances on the same clock. A test-host clock
        # adjustment must not turn a valid cache record into a future-dated one.
        with patch.object(classifier.time, "time", return_value=time.time()), patch.object(classifier, "urlopen", side_effect=provider):
            for request in (first, second):
                job = jobs.submit(self.alice, "/classify", request)
                jobs.run("alice", job["jobId"])
                result = jobs.poll(self.alice, job["jobId"])
                self.assertEqual(result["status"], "completed", result)
                self.assertEqual(len(result["result"]["assessments"]), len(request.videos))
        self.assertEqual(len(calls), 1)
        day, _ = controls.periods(time.time())
        self.assertEqual(self.used("BUDGET", "DAY#" + day), 2753)
        metrics = accounts.data_table().get_item(Key={"pk": "METRICS", "sk": "DAY#" + day})["Item"]
        self.assertEqual(metrics["inputTokens"], 100)
        self.assertEqual(metrics["providerCalls"], 1)

    def test_unsafe_provider_usage_is_rejected_without_releasing_reservation(self):
        reservation = self.dispatch()
        for usage in ({}, {"input_tokens": True}, {"input_tokens": 70000}):
            with self.assertRaises(AccessError): controls.record_usage(reservation, {"usage": usage}, 10)
        day, _ = controls.periods(time.time())
        self.assertEqual(self.used("BUDGET", "DAY#" + day), 2753)

    def test_resumed_result_does_not_restart_relative_score_lifetime(self):
        snapshot = {"jobId": "a" * 64, "status": "completed", "completedAtMs": 1000,
                    "result": json.dumps({"diagnostics": {"cache": {
                        "byVideo": {"v": {"expiresInMs": 60000}},
                        "byQuestion": {"q": {"expiresInMs": 30000}}}}})}
        with patch.object(jobs.time, "time", return_value=41):
            cache = jobs.public(snapshot)["result"]["diagnostics"]["cache"]
        self.assertEqual(cache["byVideo"]["v"]["expiresInMs"], 20000)
        self.assertEqual(cache["byQuestion"]["q"]["expiresInMs"], 0)


if __name__ == "__main__":
    unittest.main()
