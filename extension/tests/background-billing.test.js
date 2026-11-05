"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const endpoint = "https://api.focusfeed.example", internal = { url: "chrome-extension://focusfeed/popup/popup.html" };
const auth = { mode: "required", issuer: "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_pool123",
  clientId: "1234567890client1234567890", domain: "https://focusfeed-test.auth.ap-south-1.amazoncognito.com", scope: "openid email focusfeed/ai" };
function area(data) {
  return { get: async key => typeof key === "string" ? { [key]: data[key] } : { ...key, ...data },
    set: async values => Object.assign(data, values), remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }, setAccessLevel: async () => {} };
}
function setup() {
  const listeners = [], local = { classifierEndpoint: endpoint }, session = {}, opened = [], calls = [];
  let enabled = true, checkoutUrl = "https://test.checkout.dodopayments.com/session/cks_1", pauseCheckout;
  session.focusfeedCredentialsV1 = { endpoint, issuer: auth.issuer, clientId: auth.clientId, domain: auth.domain,
    accessToken: "signed-access", refreshToken: "private-refresh", expiresAt: Date.now() + 3600000 };
  const context = vm.createContext({ URL, URLSearchParams, TextEncoder, crypto: webcrypto, AbortController, setTimeout, clearTimeout, console,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    chrome: { storage: { local: area(local), session: area(session) }, runtime: { getURL: p => "chrome-extension://focusfeed/" + p,
      onMessage: { addListener: fn => listeners.push(fn) } }, tabs: { create: async value => opened.push(value) } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/health")) return { ok: true, json: async () => ({ configured: true, auth,
        provider: "typesafe-jev", model: "jev-1.13.0", promptVersion: "typesafe-jev-intent-video-match-2026-10-29.1",
        objectivePromptVersion: "typesafe-jev-intent-validation-2026-10-27.2", taxonomyVersion: "focusfeed-topics-v1",
        billing: { provider: "dodo", enabled } }) };
      if (url.endsWith("/oauth2/revoke")) return { ok: true, json: async () => ({}) };
      assert.equal(init.headers.Authorization, "Bearer signed-access");
      if (url.endsWith("/account")) return { ok: true, json: async () => ({ mode: "required", userId: "alice", premium: false, accessUntil: null }) };
      if (url.endsWith("/account/logout")) return { ok: true, json: async () => ({ signedOut: true }) };
      if (url.endsWith("/billing/status")) return { ok: true, json: async () => ({ available: true, mode: "test_mode", canManage: true, hasSubscription: false }) };
      if (url.endsWith("/billing/refresh")) return { ok: true, json: async () => ({ refreshing: true }) };
      if (url.endsWith("/billing/portal")) return { ok: true, json: async () => ({ url: "https://test.customer.dodopayments.com/session/private-portal", mode: "test_mode" }) };
      assert.equal(url, endpoint + "/billing/checkout");
      if (pauseCheckout) await pauseCheckout();
      return { ok: true, json: async () => ({ url: checkoutUrl, mode: "test_mode" }) };
    } });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  function dispatch(message, sender = internal) {
    return new Promise((resolve, reject) => {
      for (const listener of listeners) if (listener(message, sender, resolve)) return;
      reject(new Error("Message not accepted"));
    });
  }
  return { dispatch, local, session, calls, opened, set enabled(v) { enabled = v; }, set checkoutUrl(v) { checkoutUrl = v; }, set pauseCheckout(fn) { pauseCheckout = fn; } };
}

test("verified free account can open checkout; client identity/price fields are not forwarded", async () => {
  const h = setup();
  const result = await h.dispatch({ type: "FF_BILLING_CHECKOUT", userId: "bob", product_id: "cheap", amount: 1, return_url: "https://evil.example" });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.opened, true);
  assert.equal(h.opened[0].url, "https://test.checkout.dodopayments.com/session/cks_1");
  const call = h.calls.find(c => c.url.endsWith("/billing/checkout"));
  assert.equal(call.init.body, undefined);
  assert.doesNotMatch(JSON.stringify(result), /signed-access|private-refresh|cks_1/);
  assert.equal(h.local.focusfeedAccountV1.premium, false, "opening checkout itself never grants Pro");
});

test("billing actions are restricted to trusted extension pages", async () => {
  const h = setup();
  for (const type of ["FF_BILLING_STATUS", "FF_BILLING_CHECKOUT", "FF_BILLING_PORTAL", "FF_BILLING_REFRESH"])
    await assert.rejects(h.dispatch({ type }, { url: "https://www.youtube.com/watch?v=one", tab: { id: 1 } }), /not accepted/);
  assert.equal(h.opened.length, 0);
});

test("portal links open in the worker and are not returned through popup messages", async () => {
  const h = setup(), result = await h.dispatch({ type: "FF_BILLING_PORTAL" });
  assert.equal(result.ok, true); assert.equal(h.opened.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-portal|signed-access|private-refresh/);
});

test("disabled billing does not dispatch checkout", async () => {
  const h = setup(); h.enabled = false;
  assert.equal((await h.dispatch({ type: "FF_BILLING_STATUS" })).data.available, false);
  const result = await h.dispatch({ type: "FF_BILLING_CHECKOUT" });
  assert.equal(result.error.code, "billing_unavailable");
  assert.equal(h.calls.filter(c => c.url.endsWith("/billing/checkout")).length, 0);
});

test("unexpected checkout destinations cannot be opened", async () => {
  for (const url of ["https://evil.example", "https://test.checkout.dodopayments.com.evil/session/x", "https://checkout.dodopayments.com/session/live", "https://a:b@test.checkout.dodopayments.com/x"] ) {
    const h = setup(); h.checkoutUrl = url;
    const result = await h.dispatch({ type: "FF_BILLING_CHECKOUT" });
    assert.equal(result.error.code, "invalid_billing_link"); assert.equal(h.opened.length, 0);
  }
});

test("sign-out while checkout is opening prevents a late link from being opened", async () => {
  const h = setup();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  h.pauseCheckout = async () => { started(); await new Promise(resolve => { release = resolve; }); };
  const pending = h.dispatch({ type: "FF_BILLING_CHECKOUT" });
  await ready;
  assert.equal((await h.dispatch({ type: "FF_ACCOUNT_SIGN_OUT" })).ok, true);
  release();
  const result = await pending;
  assert.equal(result.error.code, "billing_cancelled"); assert.equal(h.opened.length, 0);
});

test("backend connection changes fence a checkout reply", async () => {
  const h = setup();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  h.pauseCheckout = async () => { started(); await new Promise(resolve => { release = resolve; }); };
  const pending = h.dispatch({ type: "FF_BILLING_CHECKOUT" });
  await ready; h.local.classifierEndpoint = "https://new-api.example"; release();
  assert.equal((await pending).error.code, "billing_cancelled"); assert.equal(h.opened.length, 0);
});
