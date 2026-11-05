"""Real RSA JWT verification and full HTTP authorization boundary tests, no network."""

import json
import os
import sys
import time
import unittest
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import auth
import accounts
import handler
from user_cache import UserJudgmentCache

ISSUER = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_pool123"
CLIENT = "1234567890client1234567890"
ENV = {"FOCUSFEED_AUTH_MODE": "required", "FOCUSFEED_AUTH_ISSUER": ISSUER,
       "FOCUSFEED_AUTH_CLIENT_ID": CLIENT, "FOCUSFEED_AUTH_DOMAIN": "https://focusfeed-test.auth.ap-south-1.amazoncognito.com",
       "FOCUSFEED_ACCESS_TABLE": "access", "FOCUSFEED_USER_TABLE": "users", "AWS_LAMBDA_FUNCTION_NAME": "test"}


class FakeTable:
    def __init__(self):
        self.items = {}

    @staticmethod
    def key(key):
        return tuple(sorted(key.items()))

    def get_item(self, Key, ConsistentRead):
        assert ConsistentRead is True
        return {"Item": self.items.get(self.key(Key), {}).copy()}

    def put_item(self, Item):
        keys = {key: Item[key] for key in ("pk", "sk")} if "pk" in Item else {"userId": Item["userId"]}
        self.items[self.key(keys)] = Item.copy()

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues):
        item = self.items.setdefault(self.key(Key), Key.copy())
        if UpdateExpression.startswith("ADD"):
            item["generation"] = item.get("generation", 0) + 1
        else:
            item.setdefault("createdAt", ExpressionAttributeValues[":now"])
            item["lastSeenAt"] = ExpressionAttributeValues[":now"]

    @contextmanager
    def batch_writer(self):
        yield self


class AccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self):
        self.env = patch.dict(os.environ, ENV, clear=True)
        self.env.start(); self.addCleanup(self.env.stop)
        keys = Mock()
        keys.get_signing_key_from_jwt.return_value = SimpleNamespace(key=self.key.public_key())
        self.keys = patch.object(auth, "jwks_client", return_value=keys)
        self.keys.start(); self.addCleanup(self.keys.stop)
        self.access, self.data = FakeTable(), FakeTable()
        tables = patch.object(accounts, "table", side_effect=lambda name: self.access if name == "access" else self.data)
        tables.start(); self.addCleanup(tables.stop)

    def token(self, user="alice", **changes):
        claims = {"iss": ISSUER, "client_id": CLIENT, "token_use": "access", "sub": user,
                  "origin_jti": "session-" + user,
                  "scope": "openid email focusfeed/ai", "iat": int(time.time()), "exp": int(time.time()) + 3600}
        claims.update(changes)
        return jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": "trusted"})

    def event(self, path, token=None, method="POST", body=None):
        return {"rawPath": path, "requestContext": {"http": {"method": method}},
                "headers": {"Authorization": "Bearer " + token} if token else {}, "body": json.dumps(body or {})}

    def grant(self, user="alice", status="active", until=None):
        self.access.put_item(Item={"userId": user, "status": status, "accessUntil": until if until is not None else int(time.time()) + 3600})

    def test_anonymous_cannot_reach_any_ai_or_cache_operation(self):
        with patch.object(handler, "classify_videos") as video, patch.object(handler, "classify_objectives") as topic, patch.object(handler, "classify_channel") as channel:
            for path in ("/classify", "/objectives/classify", "/channels/classify", "/cache/clear"):
                result = handler.lambda_handler(self.event(path), None)
                self.assertEqual(result["statusCode"], 401, path)
            for fn in (video, topic, channel): fn.assert_not_called()

    def test_signed_in_free_expired_revoked_and_forged_body_flags_never_call_ai(self):
        with patch.object(handler, "classify_videos") as video, patch.object(handler, "classify_objectives") as topic, patch.object(handler, "classify_channel") as channel:
            for status, until in (("missing", 0), ("active", int(time.time()) - 1), ("revoked", int(time.time()) + 3600), ("trialing", int(time.time()) + 3600)):
                self.grant(status=status, until=until)
                for path in ("/classify", "/objectives/classify", "/channels/classify"):
                    result = handler.lambda_handler(self.event(path, self.token(), body={"isPro": True, "premium": True, "userId": "subscriber"}), None)
                    self.assertEqual(result["statusCode"], 403, (path, status))
                    self.assertEqual(json.loads(result["body"])["error"]["code"], "subscription_required")
            for fn in (video, topic, channel): fn.assert_not_called()

    def test_rsa_signature_expiry_issuer_client_type_and_scope_are_checked(self):
        values = [self.token(exp=int(time.time()) - 1), self.token(iss="https://attacker.example"),
                  self.token(client_id="anotherclient123"), self.token(token_use="id"), self.token(scope="openid email"),
                  self.token(sub="alice#CACHE#0"), self.token(exp=None)]
        claims = jwt.decode(self.token(), options={"verify_signature": False})
        values.append(jwt.encode(claims, self.attacker, algorithm="RS256", headers={"kid": "trusted"}))
        values.append(jwt.encode(claims, "attacker-secret-that-is-at-least-32-bytes", algorithm="HS256", headers={"kid": "trusted"}))
        values.append(jwt.encode(claims, key="", algorithm="none"))
        for token in values:
            with self.subTest(token=token[:20]):
                result = handler.lambda_handler(self.event("/account", token, "GET"), None)
                self.assertEqual(result["statusCode"], 401)

    def test_missing_claim_and_gateway_authorizer_claims_do_not_replace_a_signed_token(self):
        claims = jwt.decode(self.token(), options={"verify_signature": False}); del claims["exp"]
        token = jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": "trusted"})
        self.assertEqual(handler.lambda_handler(self.event("/classify", token), None)["statusCode"], 401)
        event = self.event("/classify"); event["requestContext"]["authorizer"] = {"jwt": {"claims": claims}}
        self.assertEqual(handler.lambda_handler(event, None)["statusCode"], 401)

    def test_account_uses_verified_subject_and_revocation_is_visible_on_next_request(self):
        self.grant("bob")
        result = handler.lambda_handler(self.event("/account", self.token(), "GET", {"userId": "bob"}), None)
        body = json.loads(result["body"])
        self.assertEqual(body["userId"], "alice"); self.assertFalse(body["premium"])
        self.grant("alice")
        self.assertTrue(json.loads(handler.lambda_handler(self.event("/account", self.token(), "GET"), None)["body"])["premium"])
        self.grant("alice", status="revoked")
        self.assertFalse(json.loads(handler.lambda_handler(self.event("/account", self.token(), "GET"), None)["body"])["premium"])
        self.assertIn(FakeTable.key({"pk": "USER#alice", "sk": "PROFILE"}), self.data.items)

    def test_subscriber_can_classify_but_has_no_public_grant_route(self):
        from test_classifier import request_payload, objective_payload
        self.grant()
        fake = SimpleNamespace(model_dump=lambda **kwargs: {"requestId": "success"})
        for route, name, body in (("/classify", "classify_videos", request_payload()), ("/objectives/classify", "classify_objectives", objective_payload())):
            with patch.object(handler, name, return_value=fake) as fn, patch.object(handler.jobs, "submit", return_value={"jobId": "test", "status": "queued"}) as submit:
                result = handler.lambda_handler(self.event(route, self.token(), body=body), None)
                self.assertEqual(result["statusCode"], 202); fn.assert_not_called(); submit.assert_called_once()
                self.assertEqual(submit.call_args.args[0].subject, "alice")
        for path in ("/account/grant", "/subscriptions/update", "/admin/access", "/bob/account", "/anything/classify"):
            self.assertEqual(handler.lambda_handler(self.event(path, self.token(), body={"premium": True}), None)["statusCode"], 404)

    def test_storage_failure_fails_closed_before_provider_work(self):
        with patch.object(accounts, "table", side_effect=RuntimeError("database unavailable")), patch.object(handler, "classify_videos") as fn:
            result = handler.lambda_handler(self.event("/classify", self.token()), None)
            self.assertEqual(result["statusCode"], 503); fn.assert_not_called()

    def test_signed_out_session_is_rejected_even_when_the_jwt_is_still_signed_and_unexpired(self):
        token = self.token(); self.grant()
        result = handler.lambda_handler(self.event("/account/logout", token, body={"userId": "bob", "origin_jti": "session-bob"}), None)
        self.assertEqual(result["statusCode"], 200)
        for path in ("/classify", "/objectives/classify", "/channels/classify", "/cache/clear"):
            self.assertEqual(handler.lambda_handler(self.event(path, token), None)["statusCode"], 401)
        # Other accounts and independently signed-in sessions are unaffected.
        self.assertEqual(handler.lambda_handler(self.event("/account", self.token("bob"), "GET"), None)["statusCode"], 200)
        self.assertEqual(handler.lambda_handler(self.event("/account", self.token(origin_jti="new-session"), "GET"), None)["statusCode"], 200)

    def test_durable_cache_is_isolated_and_one_users_clear_cannot_delete_another(self):
        alice, bob = UserJudgmentCache("alice"), UserJudgmentCache("bob")
        alice.save([("same-input", .9, 60)], 0); bob.save([("same-input", .1, 60)], 0)
        self.assertEqual(alice.lookup(["same-input"])[1]["same-input"][0], .9)
        self.assertEqual(bob.lookup(["same-input"])[1]["same-input"][0], .1)
        # Exercise actual authenticated clear, including a forged target in its body.
        result = handler.lambda_handler(self.event("/cache/clear", self.token(), body={"userId": "bob"}), None)
        self.assertEqual(result["statusCode"], 200)
        alice.save([("same-input", .8, 60)], 0)  # late completion from before clear
        self.assertEqual(alice.lookup(["same-input"]), (1, {}))
        self.assertEqual(bob.lookup(["same-input"])[1]["same-input"][0], .1)
        # A new cache object (new Lambda environment) sees the same durable data.
        self.assertEqual(UserJudgmentCache("bob").lookup(["same-input"])[1]["same-input"][0], .1)

    def test_local_bypass_requires_loopback_server_marker_and_is_forbidden_in_lambda(self):
        with patch.dict(os.environ, {"FOCUSFEED_AUTH_MODE": "local"}):
            event = self.event("/account", method="GET"); event["_focusfeed_local_request"] = True
            self.assertEqual(handler.lambda_handler(event, None)["statusCode"], 503)
            with patch.dict(os.environ, {"AWS_LAMBDA_FUNCTION_NAME": ""}):
                self.assertEqual(handler.lambda_handler(self.event("/account", method="GET"), None)["statusCode"], 401)
                self.assertEqual(handler.lambda_handler(event, None)["statusCode"], 200)

    def test_default_is_required_even_when_no_auth_config_was_provided(self):
        with patch.dict(os.environ, {}, clear=True):
            result = handler.lambda_handler(self.event("/classify"), None)
            self.assertEqual(result["statusCode"], 503)


if __name__ == "__main__":
    unittest.main()
