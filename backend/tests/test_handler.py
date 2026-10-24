import base64
import json
import os
import sys
import unittest
from unittest.mock import patch


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import handler  # noqa: E402
from models import (  # noqa: E402
    ClassificationResponse,
    ClassifierInfo,
    ObjectiveAssessment,
    ObjectiveClassificationResponse,
    ObjectiveMatch,
    TimingInfo,
    VideoAssessment,
)
from test_classifier import objective_payload, request_payload  # noqa: E402
from taxonomy import TAXONOMY_VERSION, public_taxonomy  # noqa: E402


def event(method: str, path: str, body: str = "", encoded: bool = False) -> dict:
    if encoded:
        body = base64.b64encode(body.encode()).decode()
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "body": body,
        "isBase64Encoded": encoded,
    }


class HandlerTests(unittest.TestCase):
    def test_health_does_not_invoke_jev_and_reports_both_contracts(self) -> None:
        with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test-key"}, clear=True):
            result = handler.lambda_handler(event("GET", "/health"), None)
        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(body["provider"], "typesafe-jev")
        self.assertEqual(body["model"], "jev-1.13.0")
        self.assertIn("taxonomy-video-match", body["promptVersion"])
        self.assertIn("taxonomy-map", body["objectivePromptVersion"])
        self.assertEqual(body["taxonomyVersion"], TAXONOMY_VERSION)
        self.assertTrue(body["configured"])

    def test_invalid_video_request_is_rejected(self) -> None:
        result = handler.lambda_handler(event("POST", "/classify", "{}"), None)
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["error"]["code"], "invalid_request")

    def test_objective_route_returns_full_judgments(self) -> None:
        fake_response = ObjectiveClassificationResponse(
            requestId="objective-request",
            classifier=ClassifierInfo(
                provider="typesafe-jev",
                model="jev-1.13.0",
                promptVersion="objective-test",
            ),
            objectives=[
                ObjectiveAssessment(
                    objectiveId="objective-1",
                    text="gaming streams",
                    contentType="topic",
                    status="ready_for_confirmation",
                    typeConfidence=0.9,
                    typeProbabilities={"topic.gaming": 0.9, "topic.sports": 0.1},
                    understoodProbability=0.96,
                    suggestedTopics=[{
                        "taxonomyId": "topic.gaming",
                        "label": "Gaming",
                        "probability": 0.9,
                    }],
                    reason="Understood.",
                )
            ],
            taxonomyVersion=TAXONOMY_VERSION,
            taxonomy=public_taxonomy(),
            timing=TimingInfo(totalMs=25),
        )
        with patch.object(handler, "classify_objectives", return_value=fake_response):
            result = handler.lambda_handler(
                event("POST", "/objectives/classify", json.dumps(objective_payload())),
                None,
            )
        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(body["objectives"][0]["contentType"], "topic")
        self.assertEqual(body["objectives"][0]["suggestedTopics"][0]["taxonomyId"], "topic.gaming")
        self.assertEqual(body["objectives"][0]["understoodProbability"], 0.96)

    def test_valid_video_request_returns_observable_scores(self) -> None:
        fake_response = ClassificationResponse(
            requestId="request-123",
            classifier=ClassifierInfo(
                provider="typesafe-jev",
                model="jev-1.13.0",
                promptVersion="video-test",
            ),
            assessments=[
                VideoAssessment(
                    videoId="dsa-1",
                    objectiveMatches=[
                        ObjectiveMatch(
                            objectiveId="topic.education",
                            text="Education & Careers",
                            contentType="topic",
                            matchProbability=0.94,
                        )
                    ],
                    evidenceProbability=0.91,
                    outcome="match",
                    evidence=["Title: Interview Problems"],
                    reason="Matched.",
                )
            ],
            timing=TimingInfo(totalMs=42),
        )
        with patch.object(handler, "classify_videos", return_value=fake_response):
            result = handler.lambda_handler(
                event("POST", "/classify", json.dumps(request_payload()), encoded=True),
                None,
            )
        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(body["assessments"][0]["outcome"], "match")
        self.assertEqual(body["assessments"][0]["objectiveMatches"][0]["matchProbability"], 0.94)

    def test_missing_api_key_returns_actionable_error(self) -> None:
        error = handler.TypeSafeConfigurationError("TYPESAFE_API_KEY is not configured.")
        with patch.object(handler, "classify_videos", side_effect=error):
            result = handler.lambda_handler(
                event("POST", "/classify", json.dumps(request_payload())),
                None,
            )
        self.assertEqual(result["statusCode"], 502)
        body = json.loads(result["body"])["error"]
        self.assertEqual(body["code"], "typesafe_configuration_error")
        self.assertIn("TYPESAFE_API_KEY", body["message"])

    def test_typesafe_overload_does_not_claim_a_decision(self) -> None:
        api_error = handler.TypeSafeAPIError(529, "Overloaded")
        with patch.object(handler, "classify_videos", side_effect=api_error):
            result = handler.lambda_handler(
                event("POST", "/classify", json.dumps(request_payload())),
                None,
            )
        self.assertEqual(result["statusCode"], 502)
        body = json.loads(result["body"])["error"]
        self.assertEqual(body["code"], "typesafe_overloaded")
        self.assertIn("No automatic filtering decision", body["message"])


if __name__ == "__main__":
    unittest.main()
