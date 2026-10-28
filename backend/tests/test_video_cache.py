import json
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from classifier import build_typesafe_request
from models import ClassificationRequest
from test_classifier import request_payload
from video_cache import (
    JudgmentCache, evaluate, pair_key, split_requests, within_budget,
    MAX_QUESTIONS, MAX_REQUEST_BYTES, MAX_QUESTION_CONTEXT_BYTES,
)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "scores.sqlite3"
        self.now = 1000.0
        self.cache = JudgmentCache(self.path, clock=lambda: self.now)
        self.calls = []
        self.namespace = {"prompt": "prompt-v1", "taxonomy": "topics-v1", "endpoint": "test"}
        self.env = patch.dict(os.environ, {"FOCUSFEED_CACHE_ENABLED": "true"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def payload(self, data=None):
        data = data or request_payload()
        return build_typesafe_request(ClassificationRequest.model_validate(data)), [v["videoId"] for v in data["videos"]]

    def dispatch(self, payload):
        self.calls.append(payload)
        return {"model": payload["model"], "usage": {"input_tokens": 100, "output_tokens": 10},
            "answers": {key: {"type": "noul", "noul": .95} for key in payload["questions"]}}

    def run_cached(self, data=None, dispatch=None, cache=None, namespace=None):
        payload, ids = self.payload(data)
        return evaluate(payload, ids, dispatch or self.dispatch, namespace or self.namespace, cache=cache or self.cache)

    def test_persists_across_restart_and_mode_change_without_reusing_policy_action(self):
        first = self.run_cached()
        data = request_payload("general")
        data["profile"]["version"] += 1
        second = self.run_cached(data, cache=JudgmentCache(self.path, clock=lambda: self.now))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(first["cache"]["hits"], 0)
        self.assertEqual(second["cache"]["hits"], 4)
        self.assertEqual(second["usage"]["input_tokens"], 0)
        self.assertEqual(first["providerRequests"], self.calls)
        self.assertEqual(second["providerRequests"], [])
        self.assertEqual(second["cache"]["byVideo"]["dsa-1"]["source"], "cache")
        with sqlite3.connect(self.path) as db:
            rows = db.execute("SELECT key, probability FROM judgments").fetchall()
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(len(key) == 64 and value == .95 for key, value in rows))
        self.assertNotIn("Sliding Window", self.path.read_bytes().decode(errors="ignore"))

    def test_resolving_channel_identity_does_not_repeat_paid_topic_judgments(self):
        self.run_cached()
        data = request_payload()
        data["videos"][0]["channelId"] = "UCresolved12345"
        result = self.run_cached(data)
        self.assertEqual(result["cache"]["hits"], 4)
        self.assertEqual(len(self.calls), 1)

    def test_collection_identity_entries_and_mode_are_separate_from_seed_video(self):
        data = request_payload()
        data["videos"] = [{"videoId": "collection:RDmusic", "itemType": "collection", "collectionId": "RDmusic",
                           "title": "Mix - Songs", "entries": [{"title": "A song", "channel": "Singer"}]}]
        first = self.run_cached(data)
        payload = self.calls[-1]
        self.assertEqual(payload["state"]["videos"][0]["item_type"], "collection")
        self.assertEqual(payload["state"]["videos"][0]["entries"][0]["title"], "A song")
        self.assertIn("isolated matching entry", str(payload["questions"]))
        data["profile"]["mode"] = "general"
        second = self.run_cached(data)
        self.assertEqual(second["cache"]["hits"], 0)
        self.assertEqual(len(self.calls), 2)
        self.assertIn("explicitly listed playable entry", str(self.calls[-1]["questions"]))
        self.assertEqual(first["cache"]["byVideo"]["collection:RDmusic"]["expiresAt"], 1300000)

    def test_metadata_model_topic_prompt_and_endpoint_changes_miss(self):
        self.run_cached()
        for field, value in [("title", "Changed title"), ("descriptionSnippet", "New description"),
                             ("duration", "22:00"), ("isShort", True)]:
            data = request_payload()
            data["videos"][0][field] = value
            result = self.run_cached(data)
            self.assertEqual(result["cache"]["hits"], 2, field)
            self.assertEqual(result["cache"]["providerQuestions"], 2)
            self.assertEqual(len(self.calls[-1]["state"]["videos"]), 1)
        data = request_payload()
        data["profile"]["objectives"][0]["sourceText"] = "Changed user meaning"
        self.assertEqual(self.run_cached(data)["cache"]["hits"], 2)
        self.assertEqual(self.run_cached(namespace={**self.namespace, "prompt": "v2"})["cache"]["hits"], 0)
        self.assertEqual(self.run_cached(namespace={**self.namespace, "endpoint": "other"})["cache"]["hits"], 0)
        payload, ids = self.payload()
        payload["model"] = "jev-1.14.0"
        self.assertEqual(evaluate(payload, ids, self.dispatch, self.namespace, cache=self.cache)["cache"]["hits"], 0)

    def test_added_and_reordered_categories_only_fetch_missing_pairs(self):
        one = request_payload()
        one["profile"]["objectives"] = one["profile"]["objectives"][:1]
        self.run_cached(one)
        result = self.run_cached()
        self.assertEqual(result["cache"]["hits"], 2)
        self.assertEqual(result["cache"]["providerQuestions"], 2)
        self.assertEqual(len(self.calls[-1]["state"]["objectives"]), 1)
        for q in self.calls[-1]["questions"].values():
            self.assertIn("`objectives[0]`", q["instructions"]["question"])
        data = request_payload()
        data["videos"].reverse()
        data["profile"]["objectives"].reverse()
        result = self.run_cached(data)
        self.assertEqual(result["cache"]["hits"], 4)
        self.assertEqual(len(self.calls), 2)

    def test_direct_intent_wording_and_exceptions_do_not_reuse_broad_or_other_intent_scores(self):
        data = request_payload()
        data["profile"]["objectives"] = [{"id": "intent-review", "text": "movie reviews", "contentType": "topic",
            "matchScope": "intent", "validationVersion": "focusfeed-intent-v1"}]
        self.run_cached(data)
        self.assertEqual(self.run_cached(data)["cache"]["hits"], 2)
        data["profile"]["objectives"][0]["text"] = "movie reviews except documentaries"
        self.assertEqual(self.run_cached(data)["cache"]["hits"], 0)
        data["profile"]["objectives"][0]["text"] = "movie trailers"
        self.assertEqual(self.run_cached(data)["cache"]["hits"], 0)

    def test_expiry_live_and_borderline_scores_are_short_lived_and_hits_do_not_extend_ttl(self):
        first = self.run_cached()
        self.now += 100
        hit = self.run_cached()
        self.assertEqual(first["cache"]["byVideo"]["gaming-1"]["expiresAt"], hit["cache"]["byVideo"]["gaming-1"]["expiresAt"])
        self.now += 201
        result = self.run_cached()
        self.assertEqual(result["cache"]["hits"], 2)  # live expires in five minutes, sparse standard in an hour
        self.now += 3600
        self.assertEqual(self.run_cached()["cache"]["hits"], 0)
        def uncertain(payload):
            result = self.dispatch(payload)
            for a in result["answers"].values():
                a["noul"] = .4
            return result
        self.cache.clear()
        result = self.run_cached(dispatch=uncertain)
        self.assertEqual(result["cache"]["byVideo"]["dsa-1"]["expiresAt"], int((self.now + 300) * 1000))

    def test_invalid_missing_or_failed_scores_are_never_cached(self):
        def partial(payload):
            result = self.dispatch(payload)
            result["answers"]["v0_o0_match"]["noul"] = float("nan")
            result["answers"].pop("v0_o1_match")
            return result
        self.run_cached(dispatch=partial)
        result = self.run_cached()
        self.assertEqual(result["cache"]["hits"], 2)
        self.cache.clear()
        def failed(_payload):
            raise RuntimeError("offline")
        with self.assertRaises(RuntimeError):
            self.run_cached(dispatch=failed)
        self.assertEqual(self.run_cached()["cache"]["hits"], 0)
        self.assertEqual(self.cache.inflight, {})

    def test_concurrent_duplicate_pairs_share_inflight_call(self):
        entered, release = threading.Event(), threading.Event()
        def slow(payload):
            entered.set()
            self.assertTrue(release.wait(3))
            return self.dispatch(payload)
        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(self.run_cached, None, slow)
            self.assertTrue(entered.wait(2))
            second = pool.submit(self.run_cached)
            # Wait until the second thread has attached to the same futures.
            import time
            time.sleep(.05)
            release.set()
            first.result(timeout=3)
            result = second.result(timeout=3)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(result["cache"]["shared"], 4)
        self.assertEqual(result["cache"]["providerCalls"], 0)

    def test_clear_during_inflight_does_not_repopulate_old_entries(self):
        def clear_while_running(payload):
            self.cache.clear()
            return self.dispatch(payload)
        self.run_cached(dispatch=clear_while_running)
        self.assertEqual(self.run_cached()["cache"]["hits"], 0)
        self.cache.clear()
        self.assertEqual(self.run_cached()["cache"]["hits"], 0)

    def test_cache_is_bounded_and_corruption_falls_back_to_provider(self):
        self.cache.max_entries = 2
        self.run_cached()
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM judgments").fetchone()[0], 2)
        broken = Path(self.temp.name) / "broken.sqlite3"
        broken.write_text("not sqlite")
        result = self.run_cached(cache=JudgmentCache(broken))
        self.assertFalse(result["cache"]["available"])
        self.assertEqual(result["cache"]["hits"], 0)
        self.assertEqual(result["cache"]["providerQuestions"], 4)

    def test_moving_aliases_and_disabled_cache_never_reuse_persistent_results(self):
        self.run_cached()
        with patch.dict(os.environ, {"FOCUSFEED_CACHE_ENABLED": "false"}):
            self.assertEqual(self.run_cached()["cache"]["hits"], 0)
        payload, ids = self.payload()
        payload["model"] = "jev-latest"
        result = evaluate(payload, ids, self.dispatch, self.namespace, cache=self.cache)
        self.assertFalse(result["cache"]["enabled"])

    def test_classifier_uses_persistent_cache_and_recomputes_outcomes(self):
        from classifier import classify_videos
        data = request_payload()
        with patch.dict(os.environ, {"FOCUSFEED_CACHE_PATH": str(self.path)}), patch("classifier.call_typesafe", side_effect=self.dispatch):
            first = classify_videos(ClassificationRequest.model_validate(data))
            data["profile"]["mode"] = "general"
            second = classify_videos(ClassificationRequest.model_validate(data))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(second.diagnostics["cache"]["hits"], 4)
        self.assertEqual(second.diagnostics["usage"]["input_tokens"], 0)
        self.assertEqual(first.diagnostics["jevRequests"], self.calls)
        self.assertEqual(second.diagnostics["jevRequests"], [])
        self.assertEqual(first.assessments[0].outcome, second.assessments[0].outcome)
        self.assertEqual(second.assessments[0].outcome, "match")
        self.assertNotIn("evidenceProbability", second.model_dump(by_alias=True)["assessments"][0])

    def test_all_twelve_canonical_categories_round_trip_through_response_validation(self):
        from classifier import classify_videos
        from taxonomy import TOPICS
        data = request_payload()
        data["profile"]["objectives"] = [{"id": t.id, "taxonomyId": t.id, "text": t.label,
            "contentType": "topic", "taxonomyVersion": "focusfeed-topics-v1"} for t in TOPICS[:12]]
        result = classify_videos(ClassificationRequest.model_validate(data), evaluator=self.dispatch)
        self.assertEqual(len(result.assessments[0].objective_matches), 12)

    def test_future_timestamp_and_unexpected_model_are_not_reused(self):
        def wrong_model(payload):
            result = self.dispatch(payload)
            result["model"] = "jev-1.14.0"
            return result
        with self.assertRaisesRegex(ValueError, "different model"):
            self.run_cached(dispatch=wrong_model)
        self.assertEqual(self.run_cached()["cache"]["hits"], 0)
        self.now -= 10
        self.assertEqual(self.run_cached()["cache"]["hits"], 0)

    def test_large_requests_split_with_correct_context_and_account_for_usage(self):
        data = request_payload()
        # Repeat distinct canonical categories to exercise 144 independent questions.
        from taxonomy import TOPICS
        data["profile"]["objectives"] = [{"id": t.id, "taxonomyId": t.id, "text": t.label,
            "contentType": "topic", "taxonomyVersion": "focusfeed-topics-v1"} for t in TOPICS[:12]]
        data["videos"] = [{**data["videos"][0], "videoId": f"v{i}", "title": f"Video {i}",
            "descriptionSnippet": "語" * 1000} for i in range(12)]
        result = self.run_cached(data)
        self.assertGreater(len(self.calls), 1)
        all_ids = []
        for call in self.calls:
            self.assertTrue(within_budget(call))
            self.assertLessEqual(len(call["questions"]), MAX_QUESTIONS)
            all_ids.extend(call["questions"])
            for qid, question in call["questions"].items():
                vi = int(qid.split("_")[0][1:])
                index = [v["title"] for v in call["state"]["videos"]].index(f"Video {vi}")
                self.assertIn(f"`videos[{index}]`", question["instructions"]["question"])
        self.assertEqual(len(all_ids), 144)
        self.assertEqual(len(set(all_ids)), 144)
        self.assertEqual(result["usage"]["input_tokens"], 100 * len(self.calls))


if __name__ == "__main__":
    unittest.main()
