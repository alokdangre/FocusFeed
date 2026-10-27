"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { dom } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
test("diagnostics use connected tab decisions and direct intent validation, without old reports", async t => {
  const h = dom(fs.readFileSync(path.join(__dirname, "../observability/observability.html"), "utf8"));
  t.after(h.cleanup);
  const validation = { response: { objectives: [{ text: "Movie reviews", status: "ready_for_confirmation",
    understoodProbability: 0.95, matchableProbability: 0.88, validatedObjective: { text: "Movie reviews" } }] } };
  let connected = true;
  h.context.chrome = { storage: { local: { get: async keys => {
    assert.deepEqual(Array.from(keys), ["focusfeedObjectiveValidationV1"]);
    return { focusfeedObjectiveValidationV1: validation };
  } }, onChanged: { addListener() {} } }, tabs: {
    query: async () => [{ id: 1 }, { id: 2 }],
    sendMessage: async id => {
      if (id === 2 || !connected) throw new Error("Tab disconnected");
      return { runtime: { metrics: { inputTokens: 19, outputTokens: 7 }, records: [{
        video: { videoId: "abc", title: "A movie review", channel: "Reviews" }, action: "hide", status: "done", route: "jev",
        assessment: { outcome: "match", objectiveMatches: [{ text: "Movie reviews", contentType: "topic", matchProbability: 0.9 }] }
      }] } };
    }
  } };
  h.load("observability/observability.js"); await settle();
  assert.match(h.document.getElementById("objectives").textContent, /Exact user preference/);
  assert.match(h.document.getElementById("objectives").textContent, /88.0%/);
  assert.match(h.document.getElementById("runMeta").textContent, /1 tabs.*19\/7 Jev tokens/);
  assert.match(h.document.getElementById("videos").textContent, /A movie review.*90.0%/);
  connected = false; h.document.getElementById("refresh").click(); await settle();
  assert.match(h.document.getElementById("runMeta").textContent, /No connected YouTube tab/);
  assert.doesNotMatch(h.document.getElementById("videos").textContent, /A movie review/);
});
