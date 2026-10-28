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
    TypeSafeResponseError,
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


def objective_answers(nonsense: list[float]) -> dict:
    answers = {}
    for index, score in enumerate(nonsense):
        answers[f"o{index}_nonsense"] = noul(score)
    return answers


def complete_answers() -> dict:
    return {
        "v0_o0_match": noul(0.94),
        "v0_o1_match": noul(0.02),
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

    def test_builds_only_one_noul_per_video_objective(self) -> None:
        request = ClassificationRequest.model_validate(request_payload())
        payload = build_typesafe_request(request)

        self.assertEqual(payload["model"], "jev-1.13.0")
        self.assertEqual(len(payload["questions"]), 4)
        self.assertEqual(
            set(payload["questions"]),
            {"v0_o0_match", "v0_o1_match", "v1_o0_match", "v1_o1_match"},
        )
        self.assertEqual(payload["questions"]["v0_o0_match"]["type"], "noul")
        match_question = payload["questions"]["v0_o0_match"]["instructions"]["question"]
        self.assertIn("`videos[0]`", match_question)
        self.assertIn("title, description, or channel", match_question)
        self.assertNotIn("mode", payload["state"])
        self.assertEqual(payload["state"]["objectives"][0]["taxonomy_id"], "topic.education")
        self.assertIn("DSA", payload["state"]["objectives"][0]["source_text"])
        self.assertIn("GTA 5", payload["state"]["objectives"][1]["includes"])

    def test_question_count_is_videos_times_confirmed_topics(self) -> None:
        for video_count in (1, 4, 12):
            for topic_count in (1, 2):
                with self.subTest(videos=video_count, topics=topic_count):
                    data = request_payload()
                    data["profile"]["objectives"] = data["profile"]["objectives"][:topic_count]
                    data["videos"] = [
                        {**data["videos"][0], "videoId": f"video-{index}"}
                        for index in range(video_count)
                    ]
                    payload = build_typesafe_request(ClassificationRequest.model_validate(data))
                    self.assertEqual(len(payload["questions"]), video_count * topic_count)
                    self.assertTrue(all(key.endswith("_match") for key in payload["questions"]))

    def test_checks_only_nonsense_without_a_category_or_mode_gate(self) -> None:
        request = ObjectiveClassificationRequest.model_validate(objective_payload())
        payload = build_objective_typesafe_request(request)
        self.assertEqual(set(payload["questions"]), {"o0_nonsense", "o1_nonsense"})
        self.assertNotIn("taxonomy", payload["state"])
        self.assertNotIn("mode", payload["state"])
        self.assertEqual(payload["state"]["objectives"], request.objectives)

    def test_valid_topics_preserve_wording_and_unclear_topics_cannot_be_saved(self) -> None:
        data = objective_payload()
        data["objectives"] = ["movie reviews", "movie trailers", "do better", "xyzzy blargh"]
        result = classify_objectives(ObjectiveClassificationRequest.model_validate(data),
            evaluator=FakeEvaluator(objective_answers([.05, .07, .90, .99])))
        first, second, vague, nonsense = result.objectives
        self.assertEqual(first.validated_objective.text, "movie reviews")
        self.assertEqual(first.validated_objective.match_scope, "intent")
        self.assertIsNone(first.validated_objective.taxonomy_id)
        self.assertNotEqual(first.validated_objective.id, second.validated_objective.id)
        self.assertIsNone(vague.validated_objective)
        self.assertIsNone(nonsense.validated_objective)
        self.assertEqual(result.diagnostics["needsClarificationIds"], ["objective-3", "objective-4"])

    def test_niche_topic_is_valid_without_matching_a_fixed_category(self) -> None:
        data = objective_payload(); data["objectives"] = ["Sumerian cuneiform tutorials"]
        result = classify_objectives(ObjectiveClassificationRequest.model_validate(data),
            evaluator=FakeEvaluator(objective_answers([.1])))
        self.assertEqual(result.objectives[0].status, "ready_for_confirmation")
        self.assertIsNone(result.objectives[0].validated_objective.taxonomy_id)

    def test_nonsense_threshold_is_inclusive_and_mode_does_not_change_validation(self) -> None:
        for mode in ["general", "focus"]:
            with self.subTest(mode=mode):
                data = objective_payload()
                data.update(mode=mode, objectives=["review", "movie TV revisits", "random words"])
                evaluator = FakeEvaluator(objective_answers([0.0, 0.699, 0.70]))
                result = classify_objectives(ObjectiveClassificationRequest.model_validate(data), evaluator=evaluator)
                self.assertEqual([a.status for a in result.objectives],
                    ["ready_for_confirmation", "ready_for_confirmation", "needs_clarification"])
                self.assertEqual(result.objectives[0].validated_objective.text, "review")
                self.assertEqual(result.objectives[1].validated_objective.text, "movie TV revisits")
                self.assertEqual(result.objectives[2].nonsense_probability, 0.70)
                self.assertIsNone(result.objectives[2].validated_objective)
                self.assertEqual(result.diagnostics["thresholds"], {"nonsenseProbability": 0.70})
                self.assertEqual(result.diagnostics["jevRequest"], evaluator.payload)

    def test_missing_or_nonfinite_validation_never_accepts_an_intent(self) -> None:
        for value in [None, float("nan"), 1.1, True]:
            with self.subTest(value=value), self.assertRaises(TypeSafeResponseError):
                answers = objective_answers([.1, .1])
                answers["o0_nonsense"] = noul(value)
                classify_objectives(ObjectiveClassificationRequest.model_validate(objective_payload()), evaluator=FakeEvaluator(answers))

    def test_direct_intents_round_trip_and_go_to_video_matching_without_broadening(self) -> None:
        data = objective_payload(); data["objectives"] = ["movie reviews", "DSA tutorials except livestreams"]
        accepted = classify_objectives(ObjectiveClassificationRequest.model_validate(data),
            evaluator=FakeEvaluator(objective_answers([.05, .05])))
        video_request = request_payload()
        video_request["profile"]["objectives"] = [a.validated_objective.model_dump(by_alias=True) for a in accepted.objectives]
        payload = build_typesafe_request(ClassificationRequest.model_validate(video_request))
        self.assertEqual(payload["state"]["objectives"], [
            {"match_scope": "intent", "intent": "movie reviews"},
            {"match_scope": "intent", "intent": "DSA tutorials except livestreams"}])
        self.assertIn("complete content preference", payload["questions"]["v0_o0_match"]["instructions"]["question"])
        video_request["profile"]["objectives"][0]["sourceText"] = "all movies"
        with self.assertRaises(ValueError):
            ClassificationRequest.model_validate(video_request)

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
        self.assertNotIn("evidenceProbability", result.assessments[0].model_dump(by_alias=True))
        self.assertIn("Title: Sliding Window", result.assessments[0].evidence[0])
        self.assertEqual(result.timing.total_ms, 125)
        self.assertEqual(result.diagnostics["acceptedAssessmentCount"], 2)
        self.assertEqual(result.diagnostics["usage"]["input_tokens"], 400)
        self.assertIsNotNone(evaluator.payload)
        self.assertNotIn("evidenceProbability", result.diagnostics["judgments"]["dsa-1"])
        self.assertEqual(result.diagnostics["unexpectedQuestionIds"], [])

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
        self.assertEqual(match_outcome([0.65]), "match")
        self.assertEqual(match_outcome([0.50]), "match")
        self.assertEqual(match_outcome([0.49]), "uncertain")
        self.assertEqual(match_outcome([0.20]), "no_match")
        self.assertEqual(match_outcome([0.21]), "uncertain")

    def test_missing_judgment_returns_observable_uncertain_assessment(self) -> None:
        request = ClassificationRequest.model_validate(request_payload())
        answers = complete_answers()
        del answers["v0_o0_match"]

        result = classify_videos(request, evaluator=FakeEvaluator(answers))

        self.assertEqual(result.assessments[0].outcome, "uncertain")
        self.assertNotIn("evidenceProbability", result.assessments[0].model_dump(by_alias=True))
        self.assertEqual(result.diagnostics["missingVideoIds"], ["dsa-1"])
        self.assertEqual(result.diagnostics["acceptedAssessmentCount"], 1)


if __name__ == "__main__":
    unittest.main()
