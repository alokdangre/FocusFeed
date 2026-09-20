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
    TimingInfo,
    VideoAssessment,
)
from test_classifier import request_payload  # noqa: E402


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
    def test_health_does_not_invoke_bedrock(self) -> None:
        result = handler.lambda_handler(event("GET", "/health"), None)
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(json.loads(result["body"])["status"], "ok")

    def test_invalid_request_is_rejected(self) -> None:
        result = handler.lambda_handler(event("POST", "/classify", "{}"), None)
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["error"]["code"], "invalid_request")

    def test_valid_request_returns_validated_response(self) -> None:
        fake_response = ClassificationResponse(
            requestId="request-123",
            classifier=ClassifierInfo(
                provider="amazon-bedrock",
                model="test-model",
                promptVersion="test-prompt",
            ),
            assessments=[
                VideoAssessment(
                    videoId="dsa-1",
                    topics=["DSA"],
                    contentPurpose="practice",
                    goalRelevance="directly_useful",
                    unwantedMatch="no",
                    evidenceSufficiency="sufficient",
                    evidence=["Interview Problems"],
                    reason="This is interview practice content.",
                )
            ],
            timing=TimingInfo(totalMs=42),
        )
        payload = json.dumps(request_payload())
        with patch.object(handler, "classify_videos", return_value=fake_response):
            result = handler.lambda_handler(event("POST", "/classify", payload, encoded=True), None)
        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(body["requestId"], "request-123")
        self.assertEqual(body["assessments"][0]["goalRelevance"], "directly_useful")

    def test_invalid_model_configuration_returns_actionable_error(self) -> None:
        class InvalidModelError(Exception):
            response = {"Error": {"Code": "ValidationException"}}

        payload = json.dumps(request_payload())
        model_error = InvalidModelError(
            "The provided model identifier is invalid."
        )
        environment = {
            "BEDROCK_REGION": "ap-south-2",
            "BEDROCK_MODEL_ID": "us.amazon.nova-micro-v1:0",
        }
        with (
            patch.object(handler, "classify_videos", side_effect=model_error),
            patch.dict(os.environ, environment),
        ):
            result = handler.lambda_handler(event("POST", "/classify", payload), None)

        self.assertEqual(result["statusCode"], 502)
        error = json.loads(result["body"])["error"]
        self.assertEqual(error["code"], "invalid_model_configuration")
        self.assertIn("ap-south-2", error["message"])
        self.assertIn("us.amazon.nova-micro-v1:0", error["message"])

    def test_bedrock_account_restriction_returns_actionable_error(self) -> None:
        class ModelNotEnabledError(Exception):
            response = {"Error": {"Code": "ValidationException"}}

        payload = json.dumps(request_payload())
        model_error = ModelNotEnabledError("Operation not allowed")
        with patch.object(handler, "classify_videos", side_effect=model_error):
            result = handler.lambda_handler(event("POST", "/classify", payload), None)

        self.assertEqual(result["statusCode"], 502)
        error = json.loads(result["body"])["error"]
        self.assertEqual(error["code"], "bedrock_account_restricted")
        self.assertIn("Account and Billing support", error["message"])


if __name__ == "__main__":
    unittest.main()
