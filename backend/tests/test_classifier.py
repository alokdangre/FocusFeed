import json
import os
import sys
import unittest
from unittest.mock import patch


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from classifier import (  # noqa: E402
    build_objective_typesafe_request,
    build_typesafe_request,
    call_typesafe,
    classify_objectives,
    classify_videos,
    match_outcome,
)
from models import ClassificationRequest, ObjectiveClassificationRequest  # noqa: E402
from taxonomy import TAXONOMY_VERSION, TOPICS  # noqa: E402


def request_payload(mode: str = "focus") -> dict:
    return {
        "requestId": "request-123",
        "profile": {
            "id": "default",
            "version": 2,
            "mode": mode,
            "objectives": [
                {
                    "id": "topic.education",
                    "text": "Education & Careers",
                    "contentType": "topic",
                    "taxonomyId": "topic.education",
                    "taxonomyVersion": TAXONOMY_VERSION,
                    "sourceText": "DSA tutorials",
                },
                {
                    "id": "topic.gaming",
                    "text": "Gaming",
                    "contentType": "topic",
                    "taxonomyId": "topic.gaming",
                    "taxonomyVersion": TAXONOMY_VERSION,
                    "sourceText": "gaming streams",
                },
            ],
        },
        "videos": [
            {
                "videoId": "dsa-1",
                "title": "Sliding Window Interview Problems",
                "channel": "Algo Academy",
                "duration": "12:30",
            },
            {
                "videoId": "gaming-1",
                "title": "LIVE Ranked Gaming Stream",
                "channel": "Game Clips",
                "duration": "18:00",
                "isLive": True,
            },
        ],
    }


def objective_payload() -> dict:
    return {
        "requestId": "objective-request",
        "mode": "general",
        "objectives": ["gaming streams", "do better"],
    }


def noul(value: float) -> dict:
    return {"type": "noul", "noul": value}


def objective_answers(selected_by_objective: list[set[str]], understood: list[float]) -> dict:
    answers = {}
    for objective_index, selected in enumerate(selected_by_objective):
        for topic_index, topic in enumerate(TOPICS):
            answers[f"o{objective_index}_t{topic_index}"] = noul(
                0.82 if topic.id in selected else 0.06
            )
        answers[f"o{objective_index}_understood"] = noul(understood[objective_index])
    return answers


def complete_answers() -> dict:
    return {
        "v0_evidence": noul(0.95),
        "v0_o0_match": noul(0.94),
        "v0_o1_match": noul(0.02),
        "v1_evidence": noul(0.91),
        "v1_o0_match": noul(0.03),
        "v1_o1_match": noul(0.96),
    }


class FakeEvaluator:
    def __init__(self, answers: dict) -> None:
        self.answers = answers
        self.payload: dict | None = None

    def __call__(self, payload: dict) -> dict:
        self.payload = payload
        return {
            "model": "jev-1.13.0",
            "answers": self.answers,
            "usage": {"input_tokens": 400, "output_tokens": 80},
        }


class FakeHTTPResponse:
    def __init__(self, body: dict) -> None:
        self.body = body

    def __enter__(self) -> "FakeHTTPResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.body).encode("utf-8")


class ClassifierTests(unittest.TestCase):
    def test_profile_rejects_noncanonical_topic_identity(self) -> None:
        payload = request_payload()
        payload["profile"]["objectives"][0]["text"] = "Tampered label"
        with self.assertRaises(ValueError):
            ClassificationRequest.model_validate(payload)

    def test_builds_one_noul_per_video_objective_plus_evidence(self) -> None:
        request = ClassificationRequest.model_validate(request_payload())
        payload = build_typesafe_request(request)

        self.assertEqual(payload["model"], "jev-1.13.0")
        self.assertEqual(len(payload["questions"]), 6)
        self.assertEqual(payload["questions"]["v0_o0_match"]["type"], "noul")
        match_question = payload["questions"]["v0_o0_match"]["instructions"]["question"]
        self.assertIn("`videos[0]`", match_question)
        self.assertIn("title, description, or channel", match_question)
        self.assertNotIn("mode", payload["state"])
        self.assertEqual(payload["state"]["objectives"][0]["taxonomy_id"], "topic.education")
        self.assertIn("DSA", payload["state"]["objectives"][0]["source_text"])
        self.assertIn("GTA 5", payload["state"]["objectives"][1]["includes"])

    def test_builds_one_independent_noul_per_taxonomy_topic(self) -> None:
        request = ObjectiveClassificationRequest.model_validate(objective_payload())
        payload = build_objective_typesafe_request(request)

        self.assertEqual(len(payload["questions"]), 2 * (len(TOPICS) + 1))
        self.assertEqual(payload["questions"]["o0_t0"]["type"], "noul")
        self.assertEqual(payload["questions"]["o0_understood"]["type"], "noul")
        self.assertEqual(payload["state"]["taxonomy_version"], TAXONOMY_VERSION)
        self.assertEqual(len(payload["state"]["taxonomy"]), len(TOPICS))

    def test_objective_classification_accepts_clear_and_flags_unclear(self) -> None:
        request = ObjectiveClassificationRequest.model_validate(objective_payload())
        evaluator = FakeEvaluator(objective_answers(
            [{"topic.gaming"}, set()],
            [0.96, 0.18],
        ))

        result = classify_objectives(request, evaluator=evaluator)

        self.assertEqual(result.objectives[0].status, "ready_for_confirmation")
        self.assertEqual(result.objectives[0].content_type, "topic")
        self.assertEqual(result.objectives[0].suggested_topics[0].taxonomy_id, "topic.gaming")
        self.assertEqual(result.objectives[1].status, "needs_clarification")
        self.assertEqual(result.diagnostics["needsClarificationIds"], ["objective-2"])
        self.assertEqual(result.objectives[0].type_probabilities["topic.gaming"], 0.82)
        self.assertEqual(result.taxonomy_version, TAXONOMY_VERSION)

    def test_http_client_sends_api_key_only_in_authorization_header(self) -> None:
        captured = {}

        def fake_open(request, timeout):
            captured["authorization"] = request.get_header("Authorization")
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeHTTPResponse({"model": "jev-1.13.0", "answers": {}, "usage": {}})

        environment = {
            "TYPESAFE_API_KEY": "server-secret",
            "TYPESAFE_TIMEOUT_SECONDS": "7",
        }
        with patch.dict(os.environ, environment, clear=True), patch("classifier.urlopen", side_effect=fake_open):
            result = call_typesafe({"state": "test", "model": "jev-1.13.0", "questions": {}})

        self.assertEqual(result["model"], "jev-1.13.0")
        self.assertEqual(captured["authorization"], "Bearer server-secret")
        self.assertNotIn("server-secret", json.dumps(captured["body"]))
        self.assertEqual(captured["timeout"], 7.0)

    def test_maps_raw_jev_nouls_to_observable_assessments(self) -> None:
        request = ClassificationRequest.model_validate(request_payload())
        evaluator = FakeEvaluator(complete_answers())
        times = iter([5.0, 5.125])

        result = classify_videos(request, evaluator=evaluator, clock=lambda: next(times))

        self.assertEqual(result.classifier.provider, "typesafe-jev")
        self.assertEqual(result.classifier.model, "jev-1.13.0")
        self.assertEqual([item.video_id for item in result.assessments], ["dsa-1", "gaming-1"])
        self.assertEqual(result.assessments[0].outcome, "match")
        self.assertEqual(result.assessments[1].outcome, "match")
        self.assertEqual(result.assessments[0].objective_matches[0].match_probability, 0.94)
        self.assertEqual(result.assessments[0].evidence_probability, 0.95)
        self.assertIn("Title: Sliding Window", result.assessments[0].evidence[0])
        self.assertEqual(result.timing.total_ms, 125)
        self.assertEqual(result.diagnostics["acceptedAssessmentCount"], 2)
        self.assertEqual(result.diagnostics["usage"]["input_tokens"], 400)
        self.assertIsNotNone(evaluator.payload)

    def test_middle_probability_is_uncertain(self) -> None:
        request = ClassificationRequest.model_validate(request_payload())
        answers = complete_answers()
        answers["v1_o1_match"] = noul(0.45)

        result = classify_videos(request, evaluator=FakeEvaluator(answers))

        self.assertEqual(result.assessments[1].outcome, "uncertain")
        self.assertEqual(
            result.diagnostics["judgments"]["gaming-1"]["objectiveMatchProbabilities"]["topic.gaming"],
            0.45,
        )

    def test_calibrated_video_boundaries_match_the_live_export(self) -> None:
        self.assertEqual(match_outcome([0.65], 0.10), "match")
        self.assertEqual(match_outcome([0.50], 0.00), "match")
        self.assertEqual(match_outcome([0.49], 0.99), "uncertain")
        self.assertEqual(match_outcome([0.20], 0.70), "no_match")
        self.assertEqual(match_outcome([0.21], 0.70), "uncertain")

    def test_missing_judgment_returns_observable_uncertain_assessment(self) -> None:
        request = ClassificationRequest.model_validate(request_payload())
        answers = complete_answers()
        del answers["v0_o0_match"]

        result = classify_videos(request, evaluator=FakeEvaluator(answers))

        self.assertEqual(result.assessments[0].outcome, "uncertain")
        self.assertEqual(result.assessments[0].evidence_probability, 0.0)
        self.assertEqual(result.diagnostics["missingVideoIds"], ["dsa-1"])
        self.assertEqual(result.diagnostics["acceptedAssessmentCount"], 1)


if __name__ == "__main__":
    unittest.main()
