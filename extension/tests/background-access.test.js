"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const endpoint = "https://api.focusfeed.example";
const config = { mode: "required", issuer: "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_pool123",
  clientId: "1234567890client1234567890", domain: "https://focusfeed-test.auth.ap-south-1.amazoncognito.com", scope: "openid email focusfeed/ai" };
function area(data) {
  return { get: async keys => keys === null ? { ...data } : typeof keys === "string" ? { [keys]: data[keys] } : { ...keys, ...data },
    set: async value => Object.assign(data, value), remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    setAccessLevel: async () => {} };
}
function setup(serverJobs = false, options = {}) {
  const listeners = [], local = { classifierEndpoint: endpoint }, session = {}, calls = [];
  let premium = false, jobResult;
  const context = vm.createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console, TextEncoder, crypto: webcrypto,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    chrome: { storage: { local: area(local), session: area(session) }, runtime: {
      getURL: value => "chrome-extension://focusfeed/" + value, onMessage: { addListener: fn => listeners.push(fn) }
    } }, fetch: async (url, init) => {
      calls.push({ url, init });
      const localRequest = url.startsWith("http://127.0.0.1:3000/");
      if (localRequest && options.offline) throw new TypeError("Failed to fetch");
      if (url.endsWith("/health")) return { ok: true, json: async () => ({ auth: localRequest ? options.localAuth || config : config, jobs: serverJobs ? { version: 1 } : null, configured: true, provider: "typesafe-jev", model: "jev-1.13.0",
        promptVersion: "typesafe-jev-intent-video-match-2026-10-29.1", objectivePromptVersion: "typesafe-jev-intent-validation-2026-10-27.2", taxonomyVersion: "focusfeed-topics-v1" }) };
      assert.equal(init.headers.Authorization, localRequest ? undefined : "Bearer signed-session");
      if (url.endsWith("/account")) return { ok: true, json: async () => ({ mode: "required", userId: "alice", premium, accessUntil: premium ? Math.floor(Date.now() / 1000) + 3600 : null }) };
      if (url.includes("/jobs/")) return { ok: true, json: async () => ({ jobId: "a".repeat(64), status: "completed", result: jobResult }) };
      assert.equal(url, (localRequest ? "http://127.0.0.1:3000" : endpoint) + "/classify");
      if (!localRequest) assert.equal(premium, true);
      const request = JSON.parse(init.body);
      jobResult = { assessments: request.videos.map(video => ({ videoId: video.videoId, outcome: "no_match", reason: "fixture",
        objectiveMatches: request.profile.objectives.map(topic => ({ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: .01 })) })) };
      return { ok: true, json: async () => serverJobs ? { jobId: "a".repeat(64), status: "queued" } : jobResult };
    } });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  function dispatch(message, sender = { url: "https://www.youtube.com/", tab: { id: 1 } }) {
    return new Promise((resolve, reject) => {
      for (const listener of listeners) if (listener(message, sender, resolve)) return;
      reject(new Error("Message was not accepted"));
    });
  }
  function authenticate() {
    session.focusfeedCredentialsV1 = { endpoint, issuer: config.issuer, clientId: config.clientId, domain: config.domain,
      accessToken: "signed-session", refreshToken: "private-refresh", expiresAt: Date.now() + 3600000 };
  }
  return { dispatch, local, session, calls, authenticate, set premium(value) { premium = value; } };
}
test("real worker gates premium operations before cached results, and client flags cannot override a revoked account", async () => {
  const h = setup(), profile = { id: "general", mode: "general", version: 1, sessionDurationMinutes: 0,
    objectives: [{ id: "intent", text: "Movie reviews", sourceText: "Movie reviews", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" }] };
  const saved = await h.dispatch({ type: "FF_SETTINGS_UPDATE", action: { type: "saveProfile", profile } });
  const message = { type: "FF_AUTO_CLASSIFY", revision: saved.data.revision,
    request: { requestId: "account-test", videos: [{ videoId: "one", title: "A science video", channelId: "@science" }] } };
  h.local.focusfeedAccountV1 = { endpoint, mode: "required", userId: "alice", premium: true, validUntil: Date.now() + 9999999 };
  let response = await h.dispatch(message);
  assert.equal(response.ok, false); assert.equal(response.error.code, "authentication_required");
  assert.equal(h.calls.filter(call => call.url.endsWith("/classify")).length, 0);
  h.authenticate(); response = await h.dispatch(message);
  assert.equal(response.ok, false); assert.equal(response.error.code, "subscription_required");
  h.premium = true;
  response = await h.dispatch(message); assert.equal(response.ok, true);
  assert.equal(h.calls.filter(call => call.url.endsWith("/classify")).length, 1);
  h.premium = false;
  h.local.focusfeedAccountV1.premium = true; h.local.focusfeedAccountV1.validUntil = Date.now() + 9999999;
  response = await h.dispatch({ ...message, request: { ...message.request, requestId: "cached-copy" } });
  assert.equal(response.ok, false); assert.equal(response.error.code, "subscription_required");
  assert.equal(h.calls.filter(call => call.url.endsWith("/classify")).length, 1, "the cached score is also gated by fresh server access");
  const status = await h.dispatch({ type: "FF_ACCOUNT_STATUS" });
  assert.doesNotMatch(JSON.stringify(status), /signed-session|private-refresh/);
  await assert.rejects(h.dispatch({ type: "FF_ACCOUNT_SIGN_IN" }), /not accepted/);
  await assert.rejects(h.dispatch({ type: "FF_ACCOUNT_SIGN_OUT" }), /not accepted/);
  await assert.rejects(h.dispatch({ type: "FF_ACCOUNT_TEST_LOCAL" }), /not accepted/);
});

test("popup local-test action enables real worker classification without credentials", async () => {
  const h = setup(false, { localAuth: { mode: "local" } });
  const response = await h.dispatch({ type: "FF_ACCOUNT_TEST_LOCAL", endpoint: "https://untrusted.example" },
    { url: "chrome-extension://focusfeed/popup/popup.html" });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.data.mode, "local"); assert.equal(response.data.premium, true);
  assert.equal(h.local.classifierEndpoint, "http://127.0.0.1:3000");
  assert.equal(h.session.focusfeedCredentialsV1, undefined);
  const profile = { id: "general", mode: "general", version: 1, sessionDurationMinutes: 0,
    objectives: [{ id: "intent", text: "Movie reviews", sourceText: "Movie reviews", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" }] };
  const saved = await h.dispatch({ type: "FF_SETTINGS_UPDATE", action: { type: "saveProfile", profile } });
  const result = await h.dispatch({ type: "FF_AUTO_CLASSIFY", revision: saved.data.revision,
    request: { requestId: "local-test", videos: [{ videoId: "one", title: "A science video", channelId: "@science" }] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.calls.filter(call => call.url.endsWith("/classify")).length, 1);
  assert.ok(h.calls.every(call => !call.init.headers.Authorization));
});

test("failed local-test attempts retain the saved hosted connection and give setup instructions", async () => {
  for (const options of [{ offline: true }, { localAuth: { mode: "required", configured: false } }, {}]) {
    const h = setup(false, options);
    const response = await h.dispatch({ type: "FF_ACCOUNT_TEST_LOCAL" }, { url: "chrome-extension://focusfeed/popup/popup.html" });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "local_testing_unavailable");
    assert.match(response.error.message, /bash backend\/run_local.sh --local/);
    assert.equal(h.local.classifierEndpoint, endpoint);
    assert.equal(h.session.focusfeedCredentialsV1, undefined);
  }
});

test("retry reads fresh server configuration after restarting in local mode", async () => {
  const options = {}, h = setup(false, options), sender = { url: "chrome-extension://focusfeed/popup/popup.html" };
  assert.equal((await h.dispatch({ type: "FF_ACCOUNT_TEST_LOCAL" }, sender)).ok, false);
  options.localAuth = { mode: "local" };
  assert.equal((await h.dispatch({ type: "FF_ACCOUNT_TEST_LOCAL" }, sender)).ok, true);
});

test("real worker negotiates queued API and returns completed assessments to the existing runtime", async () => {
  const h = setup(true), profile = { id: "general", mode: "general", version: 1, sessionDurationMinutes: 0,
    objectives: [{ id: "intent", text: "Movie reviews", sourceText: "Movie reviews", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" }] };
  const saved = await h.dispatch({ type: "FF_SETTINGS_UPDATE", action: { type: "saveProfile", profile } });
  h.authenticate(); h.premium = true;
  await h.dispatch({ type: "FF_ACCOUNT_STATUS" });
  const result = await h.dispatch({ type: "FF_AUTO_CLASSIFY", revision: saved.data.revision,
    request: { requestId: "queued-request", videos: [{ videoId: "one", title: "A science video", channelId: "@science" }] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.data.assessments[0].videoId, "one");
  assert.equal(h.calls.filter(call => call.url.endsWith("/classify")).length, 1);
  assert.equal(h.calls.filter(call => call.url.includes("/jobs/")).length, 1);
});
