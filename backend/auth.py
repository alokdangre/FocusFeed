"""Cognito access-token verification. Identity never comes from request bodies."""

import os
import re
from dataclasses import dataclass
from functools import lru_cache

import jwt


class AccessError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


@dataclass(frozen=True)
class Principal:
    subject: str
    local: bool = False
    session_id: str = ""


def auth_mode() -> str:
    mode = os.getenv("FOCUSFEED_AUTH_MODE", "required")
    if mode not in ("required", "local") or (mode == "local" and os.getenv("AWS_LAMBDA_FUNCTION_NAME")):
        raise AccessError(503, "auth_unavailable", "Account authentication is not configured correctly.")
    return mode


def auth_config() -> dict:
    if auth_mode() == "local":
        return {"mode": "local"}
    issuer = os.getenv("FOCUSFEED_AUTH_ISSUER", "").rstrip("/")
    client = os.getenv("FOCUSFEED_AUTH_CLIENT_ID", "")
    domain = os.getenv("FOCUSFEED_AUTH_DOMAIN", "").rstrip("/")
    if not re.fullmatch(r"https://cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?/[A-Za-z0-9_-]+", issuer) or not re.fullmatch(r"[a-z0-9]{10,128}", client):
        raise AccessError(503, "auth_unavailable", "Account authentication has not been configured.")
    if not re.fullmatch(r"https://[a-z0-9.-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com(?:\.cn)?", domain):
        raise AccessError(503, "auth_unavailable", "Account sign-in has not been configured.")
    return {"mode": "required", "issuer": issuer, "clientId": client, "domain": domain,
            "scope": "openid email focusfeed/ai"}


@lru_cache(maxsize=4)
def jwks_client(issuer: str):
    # The URL comes only from trusted server configuration, never a JWT's jku/iss.
    return jwt.PyJWKClient(issuer + "/.well-known/jwks.json", lifespan=300, timeout=3)


def authenticate(event: dict) -> Principal:
    if auth_mode() == "local":
        # Only dev_server can set this field from the actual loopback socket.
        # HTTP headers, JSON bodies and forwarded-IP headers cannot enable it.
        if event.get("_focusfeed_local_request") is not True:
            raise AccessError(401, "authentication_required", "Sign in to your OwnFeed account.")
        return Principal("local-developer", local=True)
    config = auth_config()
    headers = {str(k).lower(): v for k, v in (event.get("headers") or {}).items()}
    value = headers.get("authorization", "")
    if not isinstance(value, str) or not re.fullmatch(r"Bearer [A-Za-z0-9_.-]{1,8192}", value):
        raise AccessError(401, "authentication_required", "Sign in to your OwnFeed account.")
    token = value[7:]
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str) or len(header["kid"]) > 200:
            raise jwt.InvalidTokenError()
        key = jwks_client(config["issuer"]).get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], issuer=config["issuer"],
                            options={"verify_aud": False, "require": ["exp", "iat", "iss", "sub", "token_use", "client_id", "scope", "origin_jti"]})
        if claims["token_use"] != "access" or claims["client_id"] != config["clientId"]:
            raise jwt.InvalidTokenError()
        if not isinstance(claims["scope"], str) or "focusfeed/ai" not in claims["scope"].split():
            raise jwt.InvalidTokenError()
        if not isinstance(claims["sub"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", claims["sub"]):
            raise jwt.InvalidTokenError()
        if not isinstance(claims["origin_jti"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", claims["origin_jti"]):
            raise jwt.InvalidTokenError()
        return Principal(claims["sub"], session_id=claims["origin_jti"])
    except jwt.PyJWKClientConnectionError as exc:
        raise AccessError(503, "auth_unavailable", "Account verification is temporarily unavailable.") from exc
    except (jwt.PyJWTError, ValueError, TypeError, KeyError) as exc:
        raise AccessError(401, "invalid_session", "Your session expired or is invalid. Sign in again.") from exc
