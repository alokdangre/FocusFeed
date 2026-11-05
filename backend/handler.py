import base64
import json
import logging
import os
from typing import Any

from pydantic import ValidationError

try:
    from .classifier import (
        TypeSafeAPIError,
        TypeSafeConfigurationError,
        TypeSafeResponseError,
        classifier_version,
        classify_objectives,
        classify_videos,
        configured_model,
    )
    from .models import ClassificationRequest, ObjectiveClassificationRequest
    from .taxonomy import TAXONOMY_VERSION
    from .channel_classifier import ChannelClassificationRequest, classify_channel, CHANNEL_PROMPT_VERSION
    from .auth import AccessError, authenticate, auth_config
    from .accounts import account, require_premium, require_session, revoke_session
    from .user_cache import scoped_cache
    from . import jobs
except ImportError:  # Lambda loads modules from CodeUri as top-level modules.
    from classifier import (  # type: ignore[no-redef]
        TypeSafeAPIError,
        TypeSafeConfigurationError,
        TypeSafeResponseError,
        classifier_version,
        classify_objectives,
        classify_videos,
        configured_model,
    )
    from models import ClassificationRequest, ObjectiveClassificationRequest  # type: ignore[no-redef]
    from taxonomy import TAXONOMY_VERSION  # type: ignore[no-redef]
    from channel_classifier import ChannelClassificationRequest, classify_channel, CHANNEL_PROMPT_VERSION
    from auth import AccessError, authenticate, auth_config
    from accounts import account, require_premium, require_session, revoke_session
    from user_cache import scoped_cache
    import jobs


logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

MAX_BODY_BYTES = 128_000


def classifier_failure(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, TypeSafeConfigurationError):
        return "typesafe_configuration_error", str(exc)
    if isinstance(exc, TypeSafeAPIError):
        if exc.status_code == 401:
            return (
                "typesafe_authentication_failed",
                "TypeSafe rejected the server API key. Check TYPESAFE_API_KEY and restart the API.",
            )
        if exc.status_code == 422:
            return (
                "typesafe_request_rejected",
                "TypeSafe rejected the Jev request contract. Check the backend log for details.",
            )
        if exc.status_code == 429:
            return (
                "typesafe_rate_limited",
                "TypeSafe rate-limited this request. Wait briefly before explicitly trying again.",
            )
        if exc.status_code == 529:
            return (
                "typesafe_overloaded",
                "TypeSafe is temporarily overloaded. No automatic filtering decision was applied.",
            )
        if exc.status_code == 0:
            return (
                "typesafe_unreachable",
                "The backend could not reach the TypeSafe API. Check its network connection.",
            )
        return (
            "typesafe_api_error",
            f"TypeSafe returned HTTP {exc.status_code}. Check the backend log for details.",
        )
    if isinstance(exc, TypeSafeResponseError):
        return (
            "typesafe_invalid_response",
            "TypeSafe returned an invalid response. No automatic filtering decision was applied.",
        )
    return (
        "classification_unavailable",
        "The classifier is temporarily unavailable. Check the backend terminal for details.",
    )


def response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    result = {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-headers": "content-type,x-request-id,authorization",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "cache-control": "no-store",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }
    if os.getenv("FOCUSFEED_ALLOWED_ORIGIN"):
        result["headers"]["access-control-allow-origin"] = os.environ["FOCUSFEED_ALLOWED_ORIGIN"]
        result["headers"]["vary"] = "Origin"
    if status_code == 401:
        result["headers"]["www-authenticate"] = "Bearer"
    return result


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


def validated_request(event: dict[str, Any], model: type) -> Any:
    body = event_body(event)
    if len(body) > MAX_BODY_BYTES:
        raise OverflowError
    return model.model_validate(json.loads(body))


def classification_routes():
    return {"/channels/classify": (ChannelClassificationRequest, classify_channel),
            "/objectives/classify": (ObjectiveClassificationRequest, classify_objectives),
            "/classify": (ClassificationRequest, classify_videos)}


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method = event_method(event)
    path = event_path(event)

    if method == "OPTIONS":
        return response(204, {})

    if method == "GET" and path == "/health":
        try:
            model = configured_model()
        except TypeSafeConfigurationError as exc:
            return response(
                503,
                {"error": {"code": "typesafe_configuration_error", "message": str(exc)}},
            )
        try:
            authentication = auth_config()
        except AccessError:
            authentication = {"mode": "required", "configured": False}
        return response(
            200,
            {
                "status": "ok",
                "service": "focusfeed-classifier",
                "provider": "typesafe-jev",
                "model": model,
                "promptVersion": classifier_version("video"),
                "objectivePromptVersion": classifier_version("objective"),
                "channelPromptVersion": CHANNEL_PROMPT_VERSION,
                "taxonomyVersion": TAXONOMY_VERSION,
                "configured": bool(os.getenv("TYPESAFE_API_KEY", "").strip() or os.getenv("FOCUSFEED_JOB_TABLE")),
                "auth": authentication,
                "jobs": {"version": 1} if authentication.get("mode") == "required" else None,
                "billing": {"provider": "dodo", "enabled": os.getenv("FOCUSFEED_BILLING_ENABLED") == "true"},
            },
        )

    routes = classification_routes()
    polling = method == "GET" and path.startswith("/jobs/")
    if not (method == "POST" and path in {*routes, "/cache/clear", "/account/logout"} or method == "GET" and path == "/account" or polling):
        return response(404, {"error": {"code": "not_found", "message": "Route not found."}})
    try:
        principal = authenticate(event)
        require_session(principal)
        if path == "/account/logout":
            revoke_session(principal)
            return response(200, {"signedOut": True})
        if path == "/account":
            return response(200, account(principal))
        if path != "/cache/clear":
            require_premium(principal)
        if polling:
            return response(200, jobs.poll(principal, path[len("/jobs/"):]))
    except AccessError as exc:
        return response(exc.status, {"error": {"code": exc.code, "message": str(exc)}})

    if path == "/cache/clear":
        try:
            scoped_cache(principal).clear()
            return response(200, {"cleared": True})
        except Exception as exc:
            logger.warning("Could not clear the judgment cache: %s", type(exc).__name__)
            return response(503, {"error": {"code": "cache_unavailable", "message": "Could not clear the server cache."}})

    request_model, classify = routes[path]

    try:
        request = validated_request(event, request_model)
    except OverflowError:
        return response(413, {"error": {"code": "body_too_large", "message": "Request body is too large."}})
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError, ValidationError) as exc:
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
        if not principal.local:
            return response(202, jobs.submit(principal, path, request))
        result = classify(request, cache=scoped_cache(principal)) if path == "/classify" else classify(request)
    except AccessError as exc:
        return response(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
    except Exception as exc:
        if isinstance(exc, (TypeSafeAPIError, TypeSafeConfigurationError, TypeSafeResponseError)):
            logger.warning(
                "TypeSafe Jev classification failed: %s",
                exc,
                extra={"request_id": request.request_id},
            )
        else:
            logger.exception("TypeSafe Jev classification failed", extra={"request_id": request.request_id})
        error_code, error_message = classifier_failure(exc)
        return response(502, {"error": {"code": error_code, "message": error_message}})

    return response(200, result.model_dump(by_alias=True))
