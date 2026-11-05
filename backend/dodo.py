"""Small server-only Dodo HTTP adapter. Fixed destinations, bounded I/O, no retries."""

import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:
    from .auth import AccessError
except ImportError:
    from auth import AccessError


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None  # Never forward a merchant bearer token to a redirect target.


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", value):
        raise AccessError(502, "invalid_billing_resource", "Dodo returned an invalid billing resource.")
    return value


def config(require_key=True):
    mode = os.getenv("DODO_ENVIRONMENT", "test_mode")
    product = os.getenv("DODO_PRO_PRODUCT_ID", "")
    business = os.getenv("DODO_BUSINESS_ID", "")
    key = os.getenv("DODO_API_KEY", "")
    if mode not in ("test_mode", "live_mode") or not all((product, business)) or require_key and not key:
        raise AccessError(503, "billing_unavailable", "Billing is not available yet. Free controls still work.")
    products = {identifier(product), *(identifier(p.strip()) for p in os.getenv("DODO_LEGACY_PRODUCT_IDS", "").split(",") if p.strip())}
    return {"mode": mode, "product": identifier(product), "business": identifier(business), "products": products,
            "key": key, "origin": "https://test.dodopayments.com" if mode == "test_mode" else "https://live.dodopayments.com"}


def request(method, path, body=None, query=None):
    settings = config()
    target = settings["origin"] + path + ("?" + urlencode(query) if query else "")
    req = Request(target, data=json.dumps(body, separators=(",", ":")).encode() if body is not None else None,
                  method=method, headers={"Authorization": "Bearer " + settings["key"],
                                          "Content-Type": "application/json", "User-Agent": "focusfeed-billing/1"})
    try:
        with build_opener(NoRedirect()).open(req, timeout=6) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("oversized response")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("invalid response")
        return value
    except (HTTPError, URLError, TimeoutError, ValueError, UnicodeError) as exc:
        # Provider errors may contain emails/payment data. Do not expose or log them.
        raise AccessError(503, "billing_provider_unavailable", "Dodo could not complete this request. Try again shortly.") from exc


def link(value, kind):
    mode = config()["mode"]
    host = ("test." if mode == "test_mode" else "") + ("checkout" if kind == "checkout" else "customer") + ".dodopayments.com"
    parsed = urlsplit(value if isinstance(value, str) else "")
    if parsed.scheme != "https" or parsed.hostname != host or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise AccessError(502, "invalid_billing_link", "Dodo returned an unexpected billing link.")
    return value
