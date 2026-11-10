"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { dom } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, options = {}) {
  const h = dom(fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8")); t.after(h.cleanup);
  h.load("settings.js");
  const state = h.context.FocusFeedSettings.migrate({}), calls = [];
  let listener;
  h.context.chrome = { runtime: { lastError: null, getURL: p => "chrome-extension://test/" + p,
    sendMessage(message, callback) {
      calls.push(message);
      let value;
      if (message.type === "FF_SETTINGS_GET") value = state;
      else value = {};
      if (callback) callback({ ok: true, data: value }); else return Promise.resolve({ ok: true, data: value });
    } }, storage: { local: { get: async defaults => defaults }, onChanged: { addListener: fn => { listener = fn; } } },
    tabs: { query: async () => [], create: async () => {} } };
  h.load("preferences-controller.js", "display-settings.js", "popup/topic-input.js", "popup/popup.js");
  await settle(); await settle();
  return { ...h, calls, changeAccount: value => listener({ focusfeedAccountV1: { newValue: value } }, "local"), $: id => h.document.getElementById(id) };
}

test("popup exposes BYOK without account or billing controls and never polls them", async t => {
  const h = await setup(t);
  for (const id of ["hostedAccount", "accountSignIn", "accountSignOut", "accountTestLocal", "accountRefresh", "billingUpgrade", "billingManage"])
    assert.equal(h.$(id), null);
  assert.ok(h.$("byokSave"));
  h.changeAccount({ mode: "required", userId: "legacy-user" });
  await settle();
  assert.equal(h.calls.some(c => /^FF_(ACCOUNT|BILLING)_/.test(c.type)), false);
});
