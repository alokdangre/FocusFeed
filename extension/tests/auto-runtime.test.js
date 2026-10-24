"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
require("../workflow-core.js");
require("../channel-policy.js");
require("../settings.js");
require("../live/engine.js");
require("../live/provider.js");
require("../auto-runtime.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topic = { id: "topic.gaming", taxonomyId: "topic.gaming", taxonomyVersion: "focusfeed-topics-v1", text: "Gaming", contentType: "topic" };
function profile(mode = "general") { return { id: mode, version: 1, mode, objectives: [topic], sessionDurationMinutes: 1 }; }
function state() { return { schemaVersion: 2, revision: 1, enabled: true, general: profile(), focus: profile("focus"), focusSession: { active: false } }; }
function assessment(id, outcome = "match") { return { videoId: id, outcome, reason: "test", evidenceProbability: .9,
  objectiveMatches: [{ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: outcome === "match" ? .9 : .1 }] }; }
function harness(response) {
  const prefs = { focusfeedSettingsV2: state(), focusFeedChannelBlocksV1: [] }, calls = [], cards = [];
  let runtime;
  const api = { storage: { local: { get: async () => prefs } }, runtime: { sendMessage: async message => {
    calls.push(message);
    if (message.type === "FF_AUTO_CANCEL") return { ok: true };
    return response ? response(message) : { ok: true, data: { ok: true, data: {
      assessments: message.request.videos.map(v => assessment(v.videoId)) } } };
  } } };
  function add(id) {
    const item = { card: { isConnected: true, dataset: {}, getBoundingClientRect: () => ({ top: 10, bottom: 200 }) },
      video: { videoId: id, title: "Video " + id, channelId: "@creator", channel: "Creator" } };
    cards.push(item); return item;
  }
  function scan() { cards.forEach(c => runtime.observe(c.card, c.video)); }
  runtime = FocusFeedAutoRuntime.create({ scan, clear() { cards.forEach(c => { c.action = "show"; }); },
    render(card, _video, action, reason) { const item = cards.find(c => c.card === card); item.action = action; item.reason = reason; } }, api);
  return { prefs, calls, cards, add, scan, runtime };
}
test("General is automatic; local blocks still apply without topics or provider", async () => {
  const h = harness(); h.prefs.focusfeedSettingsV2.general.objectives = [];
  h.prefs.focusFeedChannelBlocksV1 = [{ channelId: "UC123456789012", aliases: ["@creator"], scope: "global" }];
  const item = h.add("v1"); await h.runtime.reload();
  assert.equal(item.action, "hide"); assert.equal(item.reason, "channel_block"); assert.equal(h.calls.length, 0);
  h.prefs.focusFeedChannelBlocksV1 = []; await h.runtime.reload(); assert.equal(item.action, "show");
  h.runtime.stop();
});
test("General resolves continuously, deduplicates observations, and has no 120-video cap", async () => {
  const h = harness(); h.add("v1"); await h.runtime.reload();
  assert.equal(h.cards[0].action, "pending"); await sleep(140);
  assert.equal(h.cards[0].action, "hide");
  h.scan(); h.scan(); await sleep(120);
  assert.equal(h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 1);
  // More than the old lifetime limit, without reset or manual Load more.
  for (let i = 2; i <= 133; i++) h.add("v" + i);
  h.scan(); await sleep(3700);
  assert.equal(h.cards[132].action, "hide");
  assert.equal(h.runtime.snapshot().records.length, 100);
  h.runtime.stop();
});
test("settings/navigation cancel old work and late results cannot hide a new page", async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const card = h.add("v1"); await h.runtime.reload(); await sleep(120);
  h.runtime.navigate(true);
  resolve({ ok: true, data: { ok: true, data: { assessments: [assessment("v1")] } } });
  await sleep(20); assert.equal(card.action, "show");
  assert.ok(h.calls.some(c => c.type === "FF_AUTO_CANCEL"));
  h.prefs.focusfeedSettingsV2.enabled = false; await h.runtime.reload();
  h.runtime.navigate(false); await sleep(20); assert.equal(card.action, "show");
  h.runtime.stop();
});
test("Focus failures settle instead of remaining pending; playback can be restored once", async () => {
  const h = harness(async () => { throw new Error("offline"); });
  h.prefs.focusfeedSettingsV2.focusSession = { active: true };
  const c = h.add("v1"); await h.runtime.reload(); await sleep(130);
  assert.equal(c.action, "hide"); assert.equal(c.reason, "unavailable");
  assert.match(h.runtime.snapshot().status, /Backend unavailable/);
  h.runtime.restore("v1"); assert.equal(c.action, "show");
  h.prefs.focusFeedChannelBlocksV1 = [{ channelId: "@creator", scope: "global" }];
  await h.runtime.reload(); h.runtime.restore("v1"); assert.equal(c.action, "hide", "watch-once cannot bypass channel blocks");
  h.runtime.stop();
});
test("mismatched objective judgments are rejected and General recovers visibly", async () => {
  const h = harness(async m => {
    const a = assessment(m.request.videos[0].videoId); a.objectiveMatches[0].objectiveId = "wrong";
    return { ok: true, data: { ok: true, data: { assessments: [a] } } };
  });
  const c = h.add("v1"); await h.runtime.reload(); await sleep(130);
  assert.equal(c.action, "show"); assert.equal(c.reason, "unavailable"); h.runtime.stop();
});
test("expired Focus returns to saved General without opening popup", async () => {
  const h = harness(); const c = h.add("v1");
  h.prefs.focusfeedSettingsV2.focusSession = { active: true, endsAt: new Date(Date.now() + 220).toISOString() };
  await h.runtime.reload(); await sleep(140); assert.equal(c.action, "show", "Focus keeps a matching video");
  await sleep(250); assert.equal(c.action, "hide", "General avoids that same topic after Focus expires");
  assert.equal(h.runtime.snapshot().mode, "general"); h.runtime.stop();
});
test("provider request strips UI settings and identity aliases", () => {
  const request = FocusFeedLiveProvider.cloudRequest({ requestId: "test-123", profile: { ...profile(), updatedAt: "x" },
    videos: [{ videoId: "v", title: "Title", aliases: ["@creator"] }] });
  assert.deepEqual(Object.keys(request.profile).sort(), ["id", "mode", "objectives", "version"]);
  assert.equal(request.videos[0].aliases, undefined);
});
test("hung transport releases pending cards within its deadline", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const context = vm.createContext({ console, Date, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 35000 ? 10 : ms) });
  ["workflow-core.js", "channel-policy.js", "settings.js", "live/engine.js", "live/provider.js", "auto-runtime.js"]
    .forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context));
  let action, runtime;
  const card = { isConnected: true, dataset: {}, getBoundingClientRect: () => ({ top: 0, bottom: 200 }) };
  const cancelled = [];
  const api = { storage: { local: { get: async () => ({ focusfeedSettingsV2: state() }) } }, runtime: { sendMessage: message => {
    if (message.type === "FF_AUTO_CANCEL") { cancelled.push(message.requestId); return Promise.resolve({ ok: true }); }
    return new Promise(() => {});
  } } };
  runtime = context.FocusFeedAutoRuntime.create({ scan() { runtime.observe(card, { videoId: "v1", title: "Test" }); }, clear() {},
    render(_card, _video, value) { action = value; } }, api);
  await runtime.reload(); assert.equal(action, "pending"); await sleep(150);
  assert.equal(action, "show"); assert.equal(cancelled.length, 1); runtime.stop();
});
