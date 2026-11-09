"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { dom } = require("./dom-harness");
const settle = () => new Promise(setImmediate);
async function setup(t, save) {
  const h = dom(fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8")); t.after(h.cleanup);
  h.load("settings.js");
  const state = h.context.FocusFeedSettings.migrate({}), data = { classifierEndpoint: "https://api.typesafe.ai" };
  const summary = { mode: "byok", endpoint: data.classifierEndpoint, premium: false, keyConfigured: false };
  h.context.chrome = { runtime: { getURL: p => "chrome-extension://ownfeed/" + p, sendMessage(message, callback) {
    const result = (async () => {
      if (message.type === "FF_SETTINGS_GET") return { ok: true, data: state };
      if (message.type === "FF_BYOK_SAVE") return save(message);
      if (["FF_BYOK_STATUS", "FF_ACCOUNT_STATUS"].includes(message.type)) return { ok: true, data: summary };
      return { ok: true, data: {} };
    })();
    if (callback) result.then(callback); else return result;
  } }, storage: { local: { get: async defaults => ({ ...defaults, ...data }) }, onChanged: { addListener() {} } },
    tabs: { query: async () => [], create: async () => {} } };
  h.load("preferences-controller.js", "display-settings.js", "popup/topic-input.js", "popup/popup.js");
  await settle(); await settle(); return h;
}
test("BYOK popup clears the password before waiting, hides hosted billing, and reports success", async t => {
  let release, received;
  const h = await setup(t, message => { received = message; return new Promise(resolve => { release = resolve; }); });
  assert.equal(h.document.getElementById("hostedAccount").hidden, true);
  const field = h.document.getElementById("byokKey"), save = h.document.getElementById("byokSave");
  field.value = "test-private-key"; save.click();
  assert.equal(field.value, ""); assert.equal(save.disabled, true); await settle();
  assert.equal(received.key, "test-private-key");
  release({ ok: true, data: { keyConfigured: true, mode: "byok", premium: true, userId: "byok-test" } });
  await settle(); await settle();
  assert.equal(save.disabled, false); assert.equal(h.document.getElementById("byokRemove").hidden, false);
  assert.match(h.document.getElementById("byokFeedback").textContent, /Key checked/);
  assert.doesNotMatch(h.document.body.textContent, /test-private-key/);
});
test("a rejected key leaves the password empty and a retry available", async t => {
  const h = await setup(t, () => ({ ok: false, error: { code: "byok_key_rejected", message: "TypeSafe rejected this key." } }));
  h.document.getElementById("byokKey").value = "bad-key"; h.document.getElementById("byokSave").click();
  await settle(); await settle();
  assert.equal(h.document.getElementById("byokKey").value, "");
  assert.equal(h.document.getElementById("byokSave").disabled, false);
  assert.match(h.document.getElementById("byokFeedback").textContent, /TypeSafe rejected/);
});
