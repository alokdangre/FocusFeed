"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { dom } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
test("diagnostics use connected tab decisions and direct intent validation, without old reports", async t => {
  const h = dom(fs.readFileSync(path.join(__dirname, "../observability/observability.html"), "utf8"));
  t.after(h.cleanup);
  const validation = { response: { objectives: [{ text: "Movie reviews", status: "ready_for_confirmation",
    nonsenseProbability: 0.02, reason: "Broad topics are allowed.", validatedObjective: { text: "Movie reviews" } }],
    diagnostics: { jevRequest: { state: { objectives: ["Movie reviews"] }, questions: { o0_nonsense: { instructions: { question: "Is this gibberish?" } } } } } } };
  let connected = true;
  h.context.chrome = { storage: { local: { get: async keys => {
    assert.ok(Array.from(keys).includes("focusfeedObjectiveValidationV1"));
    assert.ok(Array.from(keys).includes("focusfeedChannelInvestigationsV1"));
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
  assert.match(h.document.getElementById("objectives").textContent, /2.0%/);
  assert.match(h.document.getElementById("objectiveRequest").textContent, /Is this gibberish\?/);
  assert.match(h.document.getElementById("runMeta").textContent, /1 tabs.*19\/7 Jev tokens/);
  assert.match(h.document.getElementById("videos").textContent, /A movie review.*90.0%/);
  connected = false; h.document.getElementById("refresh").click(); await settle();
  assert.match(h.document.getElementById("runMeta").textContent, /No connected YouTube tab/);
  assert.doesNotMatch(h.document.getElementById("videos").textContent, /A movie review/);
});
test("diagnostics export distinguishes a personal correction, negative channel result, and failed check", async t => {
  const h = dom(fs.readFileSync(path.join(__dirname, "../observability/observability.html"), "utf8")); t.after(h.cleanup);
  const item = { id: "correction-korea", videoId: "abcdefghijk", title: "Drama clip", topic: "K-dramas and Korea", match: true };
  const judgment = { text: item.topic, dominantProbability: .03, blockChannel: false, expiresAt: Date.now() + 10000 };
  const data = {
    focusfeedCorrectionsV1: { items: [item], history: [{ id: item.id, type: "correction", modelAssessment: { objectiveMatches: [{ text: item.topic, matchProbability: .05 }] } }] },
    focusfeedChannelProfilesV1: [{ channelId: "UCdrama12345678", title: "Drama channel", judgments: [judgment] }],
    focusfeedChannelInvestigationsV1: [
      { id: "check-1", triggerId: item.id, status: "learned", stage: "finished", channelId: "UCdrama12345678", channelLabel: "Drama channel",
        topics: [{ text: item.topic }], judgments: [judgment], evidence: { uploads: [{ title: "Sample" }] },
        steps: [{ request: { profile: { objectives: [{ text: item.topic }] } }, response: { matches: [judgment] } }] },
      { id: "check-2", status: "failed", stage: "fetch_evidence", channelId: "UCunavailable123", channelLabel: "Unavailable creator",
        topics: [{ text: "Gaming" }], judgments: [], error: { code: "timeout", message: "Channel retrieval timed out" } }
    ]
  };
  let exported;
  h.context.Blob = class { constructor(parts) { this.parts = parts; } };
  h.context.URL = class extends URL { static createObjectURL(blob) { exported = JSON.parse(blob.parts.join("")); return "blob:test"; } static revokeObjectURL() {} };
  h.context.chrome = { storage: { local: { get: async () => data }, onChanged: { addListener() {} } },
    tabs: { query: async () => [] }, runtime: { sendMessage: async () => ({ ok: true, data: { requests: [] } }) } };
  h.load("observability/observability.js"); await settle();
  assert.match(h.document.getElementById("corrections").textContent, /Drama clip.*Matches: K-dramas and Korea.*5.0%.*No channel match established/);
  const checks = h.document.getElementById("channelInvestigations").textContent;
  assert.match(checks, /3.0%/); assert.match(checks, /Failed.*fetch_evidence.*Channel retrieval timed out/);
  h.document.getElementById("channelFilter").value = "K-dramas and Korea";
  h.document.getElementById("channelFilter").dispatchEvent(new h.window.Event("input"));
  assert.doesNotMatch(h.document.getElementById("channelInvestigations").textContent, /Unavailable creator/);
  h.document.getElementById("export").click();
  assert.equal(exported.schemaVersion, 2); assert.equal(exported.channelLearning.investigations.length, 2, "filtering the view does not discard export evidence");
  assert.equal(exported.channelLearning.investigations[0].steps[0].response.matches[0].blockChannel, false);
  assert.equal(exported.channelLearning.corrections.items[0].match, true);
});
test("legacy saved channel judgments remain inspectable without inventing an old investigation", async t => {
  const h = dom(fs.readFileSync(path.join(__dirname, "../observability/observability.html"), "utf8")); t.after(h.cleanup);
  h.context.chrome = { storage: { local: { get: async () => ({ focusfeedChannelProfilesV1: [{ channelId: "UClegacy1234567", title: "Legacy creator", judgments: [
    { text: "K-dramas and Korea", dominantProbability: .96, blockChannel: true }
  ] }] }) }, onChanged: { addListener() {} } }, tabs: { query: async () => [] } };
  h.load("observability/observability.js"); await settle();
  const rows = h.document.getElementById("channelInvestigations").textContent;
  assert.match(rows, /Legacy creator/); assert.match(rows, /older check has no investigation trace/); assert.match(rows, /96.0%/);
});
