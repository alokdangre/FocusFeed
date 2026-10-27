"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
require("../video-model.js");
require("../channel-policy.js");
require("../settings.js");
require("../auto-runtime.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topic = { id: "topic.gaming", taxonomyId: "topic.gaming", taxonomyVersion: "focusfeed-topics-v1", text: "Gaming", contentType: "topic" };
function profile(mode = "general") { return { id: mode, version: 1, mode, objectives: [topic], sessionDurationMinutes: 1 }; }
function state() { return { schemaVersion: 2, revision: 1, enabled: true, general: profile(), focus: profile("focus"), focusSession: { active: false } }; }
function assessment(id, outcome = "match") { return { videoId: id, outcome, reason: "test",
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
  const request = FocusFeedVideo.cloudRequest({ requestId: "test-123", profile: { ...profile(), updatedAt: "x" },
    videos: [{ videoId: "v", title: "Title", aliases: ["@creator"] }] });
  assert.deepEqual(Object.keys(request.profile).sort(), ["id", "mode", "objectives", "version"]);
  assert.equal(request.videos[0].aliases, undefined);
});
test("Hide Shorts applies locally without topics and Watch once cannot bypass it", async () => {
  const h = harness(() => { throw new Error("The provider must not be called"); });
  h.prefs.focusfeedSettingsV2.hideShorts = true;
  h.prefs.focusfeedSettingsV2.general.objectives = [];
  const c = h.add("short"); c.video.isShort = true;
  await h.runtime.reload(); assert.equal(c.action, "hide"); assert.equal(c.reason, "shorts_block");
  h.runtime.restore("short"); assert.equal(c.action, "hide"); assert.equal(h.calls.length, 0);
  h.prefs.focusfeedSettingsV2.hideShorts = false; await h.runtime.reload(); assert.equal(c.action, "show");
  h.runtime.stop();
});
test("manual playback keeps explicit channel and Shorts policies without dispatching topic checks", async () => {
  const h = harness(() => { throw new Error("Playback must not call the provider"); });
  const c = h.add("playing"); c.video.playback = true;
  h.prefs.focusFeedChannelBlocksV1 = [{ channelId: "@creator", scope: "global" }];
  await h.runtime.reload(); assert.equal(c.action, "hide"); assert.equal(c.reason, "channel_block");
  h.prefs.focusFeedChannelBlocksV1 = []; c.video.isShort = true;
  h.prefs.focusfeedSettingsV2.hideShorts = true;
  await h.runtime.reload(); assert.equal(c.action, "hide"); assert.equal(c.reason, "shorts_block");
  h.prefs.focusfeedSettingsV2.hideShorts = false;
  await h.runtime.reload(); assert.equal(c.action, "show");
  await sleep(130); assert.equal(h.calls.length, 0); h.runtime.stop();
});
test("hung transport releases pending cards within its deadline", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const context = vm.createContext({ console, Date, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 90000 ? 10 : ms) });
  ["video-model.js", "channel-policy.js", "settings.js", "auto-runtime.js"]
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
test("automatic batches admit twelve videos and obey the 96-question budget", async () => {
  const h = harness();
  for (let i = 0; i < 13; i++) h.add("v" + i);
  await h.runtime.reload(); await sleep(130);
  assert.equal(h.calls.find(c => c.type === "FF_AUTO_CLASSIFY").request.videos.length, 12);
  h.runtime.stop();
  const full = harness();
  full.prefs.focusfeedSettingsV2.general.objectives = Array.from({ length: 12 }, (_v, i) => ({ ...topic, id: "topic-" + i, text: "Preference " + i }));
  for (let i = 0; i < 12; i++) full.add("v" + i);
  await full.runtime.reload(); await sleep(130);
  assert.equal(full.calls.find(c => c.type === "FF_AUTO_CLASSIFY").request.videos.length, 8);
  full.runtime.stop();
});
test("cached sources remain visible and expiry refreshes the existing card", async () => {
  const h = harness(async m => ({ ok: true, data: { ok: true, data: {
    assessments: m.request.videos.map(v => assessment(v.videoId)),
    diagnostics: { usage: { input_tokens: 0, output_tokens: 0 }, cache: {
      hits: 1, providerCalls: 0, providerQuestions: 0,
      byVideo: { v1: { source: "cache", expiresAt: Date.now() + 60 } } } }
  } } }));
  const c = h.add("v1"); await h.runtime.reload(); await sleep(130);
  assert.equal(c.reason, "cache");
  assert.equal(h.runtime.snapshot().metrics.cacheHits, 1);
  await sleep(100); h.scan(); assert.equal(c.action, "pending");
  await sleep(130);
  assert.equal(h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 2);
  h.runtime.stop();
});
