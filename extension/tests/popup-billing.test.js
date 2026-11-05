"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { dom } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, options = {}) {
  const h = dom(fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8")); t.after(h.cleanup);
  h.load("settings.js");
  const state = h.context.FocusFeedSettings.migrate({}), calls = [];
  let listener;
  const account = { endpoint: "https://api.example", mode: "required", userId: "alice", premium: false, ...options.account };
  const billing = { available: true, mode: "live_mode", hasSubscription: false, canManage: false, ...options.billing };
  h.context.chrome = { runtime: { lastError: null, getURL: p => "chrome-extension://test/" + p,
    sendMessage(message, callback) {
      calls.push(message);
      let value;
      if (message.type === "FF_SETTINGS_GET") value = state;
      else if (message.type === "FF_ACCOUNT_STATUS") value = account;
      else if (message.type === "FF_ACCOUNT_TEST_LOCAL") {
        if (options.localError) {
          const response = { ok: false, error: { message: options.localError } };
          if (callback) callback(response); else return Promise.resolve(response);
          return;
        }
        Object.assign(account, { endpoint: "http://127.0.0.1:3000", mode: "local", userId: "local-developer", premium: true }); value = account;
      }
      else if (message.type === "FF_BILLING_STATUS") value = billing;
      else if (["FF_BILLING_CHECKOUT", "FF_BILLING_PORTAL"].includes(message.type)) value = { opened: true, mode: billing.mode };
      else if (message.type === "FF_BILLING_REFRESH") value = { refreshing: true };
      else value = {};
      if (callback) callback({ ok: true, data: value }); else return Promise.resolve({ ok: true, data: value });
    } }, storage: { local: { get: async defaults => defaults }, onChanged: { addListener: fn => { listener = fn; } } },
    tabs: { query: async () => [], create: async () => {} } };
  h.load("preferences-controller.js", "display-settings.js", "popup/topic-input.js", "popup/popup.js");
  await settle(); await settle();
  return { ...h, calls, account, billing, changeAccount: value => listener({ focusfeedAccountV1: { newValue: value } }, "local"), $: id => h.document.getElementById(id) };
}

test("signed-in free account sees upgrade and can open hosted checkout", async t => {
  const h = await setup(t);
  assert.equal(h.$("billingUpgrade").hidden, false); assert.equal(h.$("billingManage").hidden, true);
  h.$("billingUpgrade").click(); await settle();
  assert.equal(h.calls.filter(c => c.type === "FF_BILLING_CHECKOUT").length, 1);
  assert.match(h.$("billingStatus").textContent, /confirmation can take a few minutes/);
});

test("existing subscriber sees manage billing and scheduled-cancellation message", async t => {
  const h = await setup(t, { account: { premium: true }, billing: { canManage: true, hasSubscription: true, cancelAtPeriodEnd: true } });
  assert.equal(h.$("billingUpgrade").hidden, true); assert.equal(h.$("billingManage").hidden, false);
  assert.match(h.$("billingStatus").textContent, /Renewal is cancelled/);
  h.$("billingManage").click(); await settle();
  assert.equal(h.calls.filter(c => c.type === "FF_BILLING_PORTAL").length, 1);
});

test("sandbox checkout is labelled and does not claim to collect real payments", async t => {
  const h = await setup(t, { billing: { mode: "test_mode" } });
  assert.equal(h.$("billingUpgrade").textContent, "Test checkout ↗");
  assert.match(h.$("billingStatus").textContent, /No real payment/);
});

test("signed-out and billing-disabled accounts have no purchase actions", async t => {
  const h = await setup(t, { billing: { available: false } });
  assert.equal(h.$("billingUpgrade").hidden, true);
  h.changeAccount({ mode: "required", userId: null, premium: false });
  assert.equal(h.$("billingManage").hidden, true); assert.equal(h.$("billingStatus").hidden, true);
});

test("refresh access requests server reconciliation and keeps saved topics intact", async t => {
  const h = await setup(t);
  h.$("objectiveInput").value = "my topic draft"; h.$("objectiveInput").dispatchEvent(new h.window.Event("input"));
  h.$("accountRefresh").click(); await settle(); await settle();
  assert.equal(h.calls.filter(c => c.type === "FF_BILLING_REFRESH").length, 1);
  assert.equal(h.$("objectiveInput").value, "my topic draft");
});

test("test-without-sign-in button switches to local testing and retains the topic draft", async t => {
  const h = await setup(t, { account: { userId: null } });
  h.$("objectiveInput").value = "my topic draft";
  assert.equal(h.$("accountTestLocal").hidden, false); assert.equal(h.$("accountTestLocal").disabled, false);
  h.$("accountTestLocal").click(); await settle(); await settle();
  assert.equal(h.calls.filter(c => c.type === "FF_ACCOUNT_TEST_LOCAL").length, 1);
  assert.match(h.$("accountStatus").textContent, /Local testing is active. No sign-in required/);
  assert.equal(h.$("accountSignIn").hidden, true); assert.equal(h.$("accountTestLocal").hidden, true);
  assert.equal(h.$("billingUpgrade").hidden, true); assert.equal(h.$("objectiveInput").value, "my topic draft");
});

test("local-server setup error leaves testing button available for retry", async t => {
  const h = await setup(t, { localError: "Start the test server with: bash backend/run_local.sh --local, then try again." });
  h.$("accountTestLocal").click(); await settle(); await settle();
  assert.match(h.$("accountFeedback").textContent, /bash backend\/run_local.sh --local/);
  assert.equal(h.$("accountTestLocal").disabled, false);
});
