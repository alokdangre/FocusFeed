"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const { webcrypto } = require("node:crypto");
const endpoint = "https://api.focusfeed.example", issuer = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_pool123";
const configuration = { mode: "required", issuer, clientId: "1234567890client1234567890", domain: "https://focusfeed-test.auth.ap-south-1.amazoncognito.com", scope: "openid email focusfeed/ai" };
const VAULT = "focusfeedCredentialsV1", MIRROR = "focusfeedAccountV1";
function area(data) {
  return { get: async key => typeof key === "string" ? { [key]: data[key] } : { ...key, ...data },
    set: async values => Object.assign(data, values), remove: async key => { delete data[key]; }, setAccessLevel: async value => { data.accessLevel = value.accessLevel; } };
}
function setup(options = {}) {
  const local = {}, session = {}, calls = [], boundaries = [];
  let selectedEndpoint = options.endpoint || endpoint, premium = options.premium !== false, exchange;
  const redirect = "https://testextension.chromiumapp.org/callback";
  const api = { storage: { local: area(local), session: area(session) }, identity: {
    getRedirectURL: () => redirect,
    launchWebAuthFlow: async input => {
      const url = new URL(input.url);
      exchange = { challenge: url.searchParams.get("code_challenge"), state: url.searchParams.get("state") };
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("response_type"), "code");
      return options.authorize ? options.authorize(url, redirect) : redirect + "?code=one-use-code&state=" + exchange.state;
    }
  } };
  const ctx = vm.createContext({ chrome: api, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, TextEncoder,
    crypto: webcrypto, btoa: value => Buffer.from(value, "binary").toString("base64") });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../account-client.js"), "utf8"), ctx);
  const client = ctx.FocusFeedAccountClient.create({ api, endpoint: async () => selectedEndpoint,
    selectEndpoint: async value => { selectedEndpoint = value; },
    health: async () => options.configuration === null ? {} : { auth: options.configuration || configuration },
    onBoundary: async () => { boundaries.push(true); }, fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) {
        const fields = new URLSearchParams(init.body);
        if (fields.get("grant_type") === "authorization_code") {
          assert.equal(fields.get("code"), "one-use-code");
          const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(fields.get("code_verifier")));
          assert.equal(Buffer.from(digest).toString("base64url"), exchange.challenge, "the verifier belongs to this sign-in challenge");
        } else assert.equal(fields.get("refresh_token"), "private-refresh-token");
        if (options.token) return options.token(fields);
        return { ok: true, json: async () => ({ access_token: "private-access-token", refresh_token: "private-refresh-token", token_type: "Bearer", expires_in: 3600 }) };
      }
      if (url.endsWith("/oauth2/revoke")) return { ok: true, json: async () => ({}) };
      if (url.endsWith("/account/logout")) return { ok: true, json: async () => ({ signedOut: true }) };
      assert.equal(url, selectedEndpoint + "/account");
      assert.equal(init.headers.Authorization, "Bearer private-access-token");
      return { ok: true, json: async () => ({ mode: "required", userId: "alice", premium, accessUntil: premium ? Math.floor(Date.now() / 1000) + 3600 : null }) };
    } });
  return { client, local, session, calls, boundaries, api, options, set premium(value) { premium = value; }, set endpoint(value) { selectedEndpoint = value; } };
}
test("PKCE sign-in keeps credentials in trusted session storage and exposes only account status", async () => {
  const h = setup(); const value = await h.client.signIn();
  assert.equal(value.userId, "alice"); assert.equal(value.premium, true);
  assert.equal(h.session.accessLevel, "TRUSTED_CONTEXTS");
  assert.equal(h.session[VAULT].accessToken, "private-access-token");
  assert.doesNotMatch(JSON.stringify(h.local), /private-access-token|private-refresh-token/);
  assert.doesNotMatch(JSON.stringify(value), /private-access-token|private-refresh-token/);
  assert.equal((await h.client.headers(endpoint)).Authorization, "Bearer private-access-token");
});
test("bad OAuth state cannot exchange a code or create credentials", async () => {
  const h = setup({ authorize: (_url, redirect) => redirect + "?code=stolen-code&state=incorrect" });
  await assert.rejects(h.client.signIn(), /could not be verified/);
  assert.equal(h.calls.length, 0); assert.equal(h.session[VAULT], undefined);
});
test("non-subscribers and revoked subscribers cannot pass the worker's premium gate", async () => {
  const h = setup({ premium: false }); await h.client.signIn();
  await assert.rejects(h.client.premium(), error => error.code === "subscription_required");
  h.premium = true; assert.equal((await h.client.premium()).premium, true);
  h.premium = false;
  // Fake a client-side Pro flag; the next gate still asks the server.
  h.local[MIRROR] = { premium: true, userId: "alice", validUntil: Date.now() + 9999999 };
  await assert.rejects(h.client.premium(), error => error.code === "subscription_required");
  assert.equal(h.local[MIRROR].premium, false); assert.ok(h.boundaries.length > 0);
});
test("concurrent requests share one refresh and sign-out erases the vault and invalidates AI", async () => {
  const h = setup(); await h.client.signIn(); h.session[VAULT].expiresAt = Date.now() - 1;
  const before = h.calls.length;
  await Promise.all([h.client.headers(endpoint), h.client.headers(endpoint)]);
  assert.equal(h.calls.slice(before).filter(call => call.url.endsWith("/oauth2/token")).length, 1);
  await h.client.signOut(); assert.equal(h.session[VAULT], undefined); assert.equal(h.local[MIRROR].premium, false);
  await assert.rejects(h.client.headers(endpoint), error => error.code === "authentication_required");
});
test("an endpoint change never forwards an existing account's bearer token", async () => {
  const h = setup(); await h.client.signIn(); h.endpoint = "https://other.example";
  const before = h.calls.length;
  await assert.rejects(h.client.headers("https://other.example"), error => error.code === "authentication_required");
  assert.equal(h.calls.length, before);
});
test("a late authorization failure from a previous session cannot erase the new session", async () => {
  const h = setup(); await h.client.signIn();
  h.session[VAULT].accessToken = "new-account-token"; h.local[MIRROR].userId = "bob";
  await h.client.denied(endpoint, { code: "invalid_session" }, "Bearer private-access-token");
  assert.equal(h.session[VAULT].accessToken, "new-account-token");
  assert.equal(h.local[MIRROR].userId, "bob"); assert.equal(h.local[MIRROR].premium, true);
});
test("hosted servers cannot claim local development mode or omit authentication", async () => {
  for (const config of [null, { mode: "local" }]) {
    const h = setup({ configuration: config });
    await assert.rejects(h.client.status(), error => error.code === "auth_unavailable");
    assert.equal(h.local[MIRROR].premium, false);
  }
  const local = setup({ endpoint: "http://127.0.0.1:3000", configuration: { mode: "local" } });
  assert.equal((await local.client.premium()).mode, "local");
});
test("unconfigured sign-in reproduces the unavailable message", async () => {
  const h = setup({ configuration: { mode: "required", configured: false } });
  await assert.rejects(h.client.signIn(), /Account sign-in is temporarily unavailable/);
  assert.equal(h.calls.length, 0);
});
test("local testing switches to a verified loopback server without signing in", async () => {
  const h = setup({ configuration: { mode: "local" } });
  const value = await h.client.testLocal("http://127.0.0.1:3000");
  assert.equal(value.mode, "local"); assert.equal(value.premium, true);
  assert.equal(value.endpoint, "http://127.0.0.1:3000");
  assert.equal(Object.keys(await h.client.headers(value.endpoint)).length, 0);
  assert.equal(h.session[VAULT], undefined); assert.equal(h.calls.length, 0);
});
test("local testing cannot enable guest access on hosted or authenticated servers", async () => {
  const h = setup();
  await assert.rejects(h.client.testLocal(endpoint), error => error.code === "local_testing_unavailable");
  await assert.rejects(h.client.testLocal("http://127.0.0.1:3000"), error => error.code === "local_testing_unavailable");
  await assert.rejects(h.client.headers(endpoint), error => error.code === "authentication_required");
  assert.equal(h.local[MIRROR], undefined);
});
test("local testing refreshes previously cached authentication configuration", async () => {
  const h = setup({ endpoint: "http://127.0.0.1:3000" });
  await h.client.status();
  h.options.configuration = { mode: "local" };
  assert.equal((await h.client.testLocal("http://127.0.0.1:3000")).mode, "local");
});
test("sign-out during an OAuth exchange cannot resurrect the old session", async () => {
  let finish;
  const h = setup({ token: () => new Promise(resolve => { finish = resolve; }) });
  const login = h.client.signIn();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await h.client.signOut();
  finish({ ok: true, json: async () => ({ access_token: "private-access-token", refresh_token: "private-refresh-token", token_type: "Bearer", expires_in: 3600 }) });
  await assert.rejects(login, error => error.code === "account_changed");
  assert.equal(h.session[VAULT], undefined); assert.equal(h.local[MIRROR].premium, false);
});
