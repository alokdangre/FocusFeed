import tempfile
import unittest
from pathlib import Path

from classifier import build_typesafe_request, classify_videos
from models import ClassificationRequest
from video_cache import JudgmentCache, evaluate


def request(count=20):
    return {
        "requestId": "sparse-request-123",
        "profile": {"id": "general", "mode": "general", "version": 1, "objectives": [
            {"id": name, "text": name, "contentType": "topic", "matchScope": "intent",
             "validationVersion": "focusfeed-intent-v1"} for name in ["movie reviews", "gaming"]
        ]},
        "videos": [{"videoId": f"video-{i}", "title": f"Video {i}"} for i in range(count)],
        "pairs": [{"videoId": f"video-{i}", "objectiveId": "movie reviews" if i % 2 == 0 else "gaming"} for i in range(count)],
    }


def evaluator(payload):
    return {"model": "jev-1.13.0", "answers": {qid: {"type": "noul", "noul": .1} for qid in payload["questions"]}}


class SparseBatchTests(unittest.TestCase):
    def test_twenty_cards_with_different_pending_topics_ask_only_selected_pairs(self):
        parsed = ClassificationRequest.model_validate(request())
        payload = build_typesafe_request(parsed)
        self.assertEqual(len(payload["questions"]), 20)
        self.assertIn("v0_o0_match", payload["questions"])
        self.assertIn("v1_o1_match", payload["questions"])
        self.assertNotIn("v0_o1_match", payload["questions"])
        result = classify_videos(parsed, evaluator=evaluator)
        self.assertEqual(len(result.assessments), 20)
        self.assertTrue(all(len(a.objective_matches) == 1 for a in result.assessments))
        self.assertEqual(result.diagnostics["missingVideoIds"], [])

    def test_missing_selected_answer_is_invalid_not_a_nonmatch(self):
        parsed = ClassificationRequest.model_validate(request(2))
        result = classify_videos(parsed, evaluator=lambda p: {"model": "jev-1.13.0", "answers": {"v0_o0_match": {"type": "noul", "noul": .1}}})
        self.assertEqual(result.diagnostics["missingVideoIds"], ["video-1"])
        self.assertEqual(len(result.assessments[1].objective_matches), 1)

    def test_invalid_sparse_pairs_and_oversized_batches_are_rejected(self):
        for change in ["unknown_video", "unknown_topic", "duplicate", "uncovered", "empty", "too_many"]:
            data = request(2)
            if change == "unknown_video": data["pairs"][0]["videoId"] = "elsewhere"
            if change == "unknown_topic": data["pairs"][0]["objectiveId"] = "elsewhere"
            if change == "duplicate": data["pairs"].append(data["pairs"][0])
            if change == "uncovered": data["pairs"].pop()
            if change == "empty": data["pairs"] = []
            if change == "too_many": data = request(21)
            with self.subTest(change=change), self.assertRaises(ValueError):
                ClassificationRequest.model_validate(data)

    def test_sparse_scores_reuse_after_video_and_topic_reordering(self):
        data = request(2)
        calls = []
        def dispatch(payload):
            calls.append(payload)
            return evaluator(payload)
        with tempfile.TemporaryDirectory() as tmp:
            cache = JudgmentCache(Path(tmp) / "scores.sqlite")
            for reverse in [False, True]:
                if reverse:
                    data["videos"].reverse()
                    data["profile"]["objectives"].reverse()
                payload = build_typesafe_request(ClassificationRequest.model_validate(data))
                result = evaluate(payload, [v["videoId"] for v in data["videos"]], dispatch, {"prompt": "test"}, cache=cache)
                self.assertEqual(len(result["answers"]), 2)
            self.assertEqual(len(calls), 1)
            self.assertEqual(result["cache"]["hits"], 2)

    def test_ambiguous_metadata_is_not_a_negative_label_in_video_prompt(self):
        payload = build_typesafe_request(ClassificationRequest.model_validate(request(1)))
        question = payload["questions"]["v0_o0_match"]
        self.assertIn("unknown, not evidence", question["instructions"]["question"])
        self.assertIn("probability near 0.5", question["instructions"]["question"])
        self.assertNotIn("or lacks evidence", question["criteria"]["false"])
        self.assertIn("explicit exception", question["criteria"]["false"])
