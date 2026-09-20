import base64
import json
import logging
import os
from typing import Any

from pydantic import ValidationError

try:
    from .classifier import DEFAULT_MODEL_ID, PROMPT_VERSION, classify_videos
    from .models import ClassificationRequest
except ImportError:  # Lambda loads modules from CodeUri as top-level modules.
    from classifier import DEFAULT_MODEL_ID, PROMPT_VERSION, classify_videos  # type: ignore[no-redef]
    from models import ClassificationRequest  # type: ignore[no-redef]


logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

MAX_BODY_BYTES = 32_000


def classifier_failure(exc: Exception) -> tuple[str, str]:
    error_response = getattr(exc, "response", {})
    aws_error = error_response.get("Error", {}) if isinstance(error_response, dict) else {}
    aws_code = aws_error.get("Code", "") if isinstance(aws_error, dict) else ""
    error_name = type(exc).__name__
    error_text = str(exc).lower()

    if aws_code == "ValidationException" and "model identifier is invalid" in error_text:
        model_id = os.getenv("BEDROCK_MODEL_ID", DEFAULT_MODEL_ID)
        region = os.getenv("BEDROCK_REGION", os.getenv("AWS_REGION", "us-east-1"))
        return (
            "invalid_model_configuration",
            f"Bedrock rejected model '{model_id}' in region '{region}'. "
            "Use a compatible model and region, then restart the API.",
        )

    if aws_code == "ValidationException" and "operation not allowed" in error_text:
        return (
            "bedrock_account_restricted",
            "Amazon Bedrock rejected model invocation for this AWS account. "
            "If the us-east-1 playground shows the same error, contact AWS Account and Billing support.",
        )

    if error_name in {"NoCredentialsError", "PartialCredentialsError", "ProfileNotFound"}:
        return (
            "aws_credentials_missing",
            "AWS credentials were not found. Check AWS_PROFILE and your AWS CLI configuration, then restart the API.",
        )

    if aws_code in {
        "AccessDenied",
        "AccessDeniedException",
        "UnauthorizedException",
        "UnrecognizedClientException",
        "InvalidClientTokenId",
        "ExpiredTokenException",
    }:
        return (
            "bedrock_access_denied",
            "AWS rejected the Bedrock request. Check the profile credentials and bedrock:InvokeModel permission.",
        )

    if error_name in {"EndpointConnectionError", "ConnectTimeoutError", "ReadTimeoutError"}:
        return (
            "aws_endpoint_unreachable",
            "The backend could not reach Amazon Bedrock. Check the configured region and network connection.",
        )

    return (
        "classification_unavailable",
        "The classifier is temporarily unavailable. Check the backend terminal for details.",
    )


def response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "content-type,x-request-id",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "cache-control": "no-store",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }


def event_method(event: dict[str, Any]) -> str:
    return (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or "GET"
    ).upper()


def event_path(event: dict[str, Any]) -> str:
    return event.get("rawPath") or event.get("path") or "/"


def event_body(event: dict[str, Any]) -> bytes:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        return base64.b64decode(raw, validate=True)
    return raw.encode("utf-8")


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method = event_method(event)
    path = event_path(event)

    if method == "OPTIONS":
        return response(204, {})

    if method == "GET" and path.endswith("/health"):
        return response(
            200,
            {
                "status": "ok",
                "service": "focusfeed-classifier",
                "provider": "amazon-bedrock",
                "model": os.getenv("BEDROCK_MODEL_ID", DEFAULT_MODEL_ID),
                "region": os.getenv("BEDROCK_REGION", os.getenv("AWS_REGION", "us-east-1")),
                "promptVersion": PROMPT_VERSION,
            },
        )

    if method != "POST" or not path.endswith("/classify"):
        return response(404, {"error": {"code": "not_found", "message": "Route not found."}})

    try:
        body = event_body(event)
    except (ValueError, TypeError):
        return response(400, {"error": {"code": "invalid_body", "message": "Request body is invalid."}})

    if len(body) > MAX_BODY_BYTES:
        return response(413, {"error": {"code": "body_too_large", "message": "Request body is too large."}})

    try:
        payload = json.loads(body)
        request = ClassificationRequest.model_validate(payload)
    except (json.JSONDecodeError, UnicodeDecodeError, ValidationError) as exc:
        details = exc.errors(include_input=False, include_url=False) if isinstance(exc, ValidationError) else []
        return response(
            400,
            {
                "error": {
                    "code": "invalid_request",
                    "message": "Classification request failed validation.",
                    "details": details,
                }
            },
        )

    try:
        result = classify_videos(request)
    except Exception as exc:
        logger.exception("Bedrock classification failed", extra={"request_id": request.request_id})
        error_code, error_message = classifier_failure(exc)
        return response(
            502,
            {
                "error": {
                    "code": error_code,
                    "message": error_message,
                }
            },
        )

    return response(200, result.model_dump(by_alias=True))
