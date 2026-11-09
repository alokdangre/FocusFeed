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
function harness(response, options) {
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
    render(card, _video, action, reason) { const item = cards.find(c => c.card === card); item.action = action; item.reason = reason; } }, api, options);
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
test("hosted AI stays off for signed-out/free accounts while local policies and manual playback work", async t => {
  const h = harness(); t.after(h.runtime.stop); h.prefs.classifierEndpoint = "https://api.focusfeed.example";
  const card = h.add("one");
  await h.runtime.reload(); assert.equal(card.action, "show"); assert.equal(card.reason, "account_required");
  await sleep(350); assert.equal(h.calls.filter(message => message.type === "FF_AUTO_CLASSIFY").length, 0);
  h.prefs.focusfeedAccountV1 = { endpoint: h.prefs.classifierEndpoint, mode: "required", userId: "free-account", premium: false, validUntil: 0 };
  h.prefs.focusfeedSettingsV2.focusSession.active = true;
  await h.runtime.reload(); assert.equal(card.action, "show");
  h.prefs.focusFeedChannelBlocksV1 = [{ channelId: "@creator", scope: "global" }];
  await h.runtime.reload(); assert.equal(card.reason, "channel_block");
  h.prefs.focusFeedChannelBlocksV1 = []; card.video.playback = true;
  await h.runtime.reload(); assert.equal(card.action, "show"); assert.equal(card.reason, "user_playback");
});
test("BYOK filtering requires a fresh TypeSafe session and stops when the key is removed", async t => {
  const h = harness(); t.after(h.runtime.stop); h.prefs.classifierEndpoint = "https://api.typesafe.ai";
  h.prefs.focusfeedAccountV1 = { endpoint: h.prefs.classifierEndpoint, mode: "byok", userId: "byok-session", premium: true, validUntil: Date.now() + 60000 };
  const card = h.add("one"); await h.runtime.reload(); await sleep(350); assert.equal(card.action, "hide");
  h.prefs.focusfeedAccountV1.premium = false; await h.runtime.reload(); assert.equal(card.action, "show");
  await sleep(350); assert.equal(h.calls.filter(message => message.type === "FF_AUTO_CLASSIFY").length, 1);
  h.prefs.focusfeedAccountV1.premium = true; h.prefs.classifierEndpoint = "https://other.example";
  await h.runtime.reload(); assert.equal(card.action, "show"); assert.equal(card.reason, "account_required");
});
test("revoked or expired account access discards settled premium decisions and stops further AI work", async t => {
  const h = harness(); t.after(h.runtime.stop); h.prefs.classifierEndpoint = "https://api.focusfeed.example";
  h.prefs.focusfeedAccountV1 = { endpoint: h.prefs.classifierEndpoint, mode: "required", userId: "subscriber", premium: true, validUntil: Date.now() + 60000 };
  const card = h.add("one"); await h.runtime.reload(); await sleep(350); assert.equal(card.action, "hide");
  h.prefs.focusfeedAccountV1.premium = false; await h.runtime.reload(); assert.equal(card.action, "show");
  await sleep(350); assert.equal(h.calls.filter(message => message.type === "FF_AUTO_CLASSIFY").length, 1);
  h.prefs.focusfeedAccountV1.premium = true; await h.runtime.reload(); await sleep(350); assert.equal(card.action, "hide");
  h.prefs.focusfeedAccountV1.validUntil = Date.now() - 1; h.runtime.tick(); await sleep(20);
  assert.equal(card.action, "show"); assert.equal(card.reason, "account_required");
});
test("observed channel aliases apply locally while staying out of model metadata", async () => {
  const h = harness(); h.prefs.focusfeedSettingsV2.general.objectives = [];
  h.prefs.focusFeedChannelBlocksV1 = [{ channelId: "@creator", scope: "global" }];
  const item = h.add("v1"); item.video.channelId = "UCcreator123456"; item.video.aliases = ["@creator"];
  await h.runtime.reload();
  assert.equal(item.action, "hide"); assert.equal(item.reason, "channel_block"); assert.equal(h.calls.length, 0);
  h.runtime.stop();
});
test("General resolves continuously, deduplicates observations, and has no 120-video cap", async t => {
  const h = harness(); h.add("v1"); await h.runtime.reload();
  t.after(h.runtime.stop);
  assert.equal(h.cards[0].action, "pending"); await sleep(350);
  assert.equal(h.cards[0].action, "hide");
  h.scan(); h.scan(); await sleep(330);
  assert.equal(h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 1);
  // More than the old lifetime limit, without reset or manual Load more.
  for (let i = 2; i <= 133; i++) h.add("v" + i);
  h.scan();
  const deadline = performance.now() + 8000;
  while (h.cards[132].action !== "hide" && performance.now() < deadline) await sleep(25);
  assert.equal(h.cards[132].action, "hide");
  assert.equal(h.runtime.snapshot().records.length, 100);
  h.runtime.stop();
});
test("block and Undo preserve settled decisions instead of making the entire feed pending", async t => {
  const h = harness(async message => ({ ok: true, data: { ok: true, data: {
    assessments: message.request.videos.map(video => assessment(video.videoId, "no_match"))
  } } })); t.after(h.runtime.stop);
  const first = h.add("first"), second = h.add("second"); second.video.channelId = "@other";
  await h.runtime.reload(); await sleep(330);
  assert.equal(first.action, "show"); assert.equal(second.action, "show");
  h.prefs.focusFeedChannelBlocksV1 = [{ scope: "global", channelId: "@creator" }];
  await h.runtime.reload(); await h.runtime.reload();
  assert.equal(first.reason, "channel_block"); assert.equal(second.action, "show");
  h.prefs.focusFeedChannelBlocksV1 = []; await h.runtime.reload();
  assert.equal(first.action, "show"); assert.equal(second.action, "show");
  await sleep(330);
  assert.equal(h.calls.filter(message => message.type === "FF_AUTO_CLASSIFY").length, 1);
  assert.equal(h.calls.filter(message => message.type === "FF_AUTO_CANCEL").length, 0);
});
test("a channel change preserves an in-flight topic check and its result still respects the block", async t => {
  let finish;
  const h = harness(message => new Promise(resolve => { finish = () => resolve({ ok: true, data: { ok: true, data: {
    assessments: message.request.videos.map(video => assessment(video.videoId, "no_match"))
  } } }); })); t.after(h.runtime.stop);
  const first = h.add("first"), second = h.add("second"); second.video.channelId = "@other";
  await h.runtime.reload(); await sleep(330);
  h.prefs.focusFeedChannelBlocksV1 = [{ scope: "global", channelId: "@creator" }];
  await h.runtime.reload(); finish(); await sleep(20);
  assert.equal(first.reason, "channel_block"); assert.equal(second.action, "show");
  assert.equal(h.calls.filter(message => message.type === "FF_AUTO_CANCEL").length, 0);
  assert.equal(h.calls.filter(message => message.type === "FF_AUTO_CLASSIFY").length, 1);
});
test("collections never use a seed video's channel or ask for single-video topic judgments", async t => {
  const h = harness(); t.after(h.runtime.stop);
  h.prefs.focusFeedChannelBlocksV1 = [{ scope: "global", channelId: "@creator" }];
  const item = h.add("mix-seed"); item.video.collection = true;
  await h.runtime.reload(); await sleep(330);
  assert.equal(item.action, "show"); assert.equal(item.reason, "collection_unknown"); assert.equal(h.calls.length, 0);
});
test("Focus keeps unchecked collections out without sending seed-video judgments", async t => {
  const h = harness(); t.after(h.runtime.stop); h.prefs.focusfeedSettingsV2.focusSession.active = true;
  const item = h.add("mix-seed"); item.video.collection = true;
  await h.runtime.reload(); assert.equal(item.action, "hide"); assert.equal(item.reason, "collection_unknown"); assert.equal(h.calls.length, 0);
});
test("paused Focus discovery never refreshes expired judgments", async t => {
  const h = harness(); t.after(h.runtime.stop); const item = h.add("one");
  item.video.noNewTopicChecks = true; h.prefs.focusfeedSettingsV2.focusSession.active = true;
  await h.runtime.reload(); await sleep(330);
  assert.equal(item.action, "hide"); assert.equal(item.reason, "focus_paused"); assert.equal(h.calls.length, 0);
});
test("topic edits refresh scores without blanking; endpoint and cache invalidation discard decisions", async t => {
  const h = harness(); t.after(h.runtime.stop); const card = h.add("one");
  await h.runtime.reload(); await sleep(330);
  const changes = [
    { action: "hide", change() { h.prefs.focusfeedSettingsV2.general.objectives = [{ ...topic, text: "Changed actual topic" }]; } },
    { action: "pending", change() { h.prefs.classifierEndpoint = "https://classifier.example";
      h.prefs.focusfeedAccountV1 = { endpoint: "https://classifier.example", mode: "required", userId: "subscriber", premium: true, validUntil: Date.now() + 60000 }; } },
    { action: "pending", change() { h.prefs.focusfeedCacheEpochV1 = 123; } },
  ];
  for (const change of changes) {
    change.change(); await h.runtime.reload(); assert.equal(card.action, change.action); await sleep(330);
  }
  assert.equal(h.calls.filter(message => message.type === "FF_AUTO_CLASSIFY").length, 4);
});
test("settings/navigation cancel old work and late results cannot hide a new page", async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const card = h.add("v1"); await h.runtime.reload(); await sleep(330);
  h.runtime.navigate(true);
  resolve({ ok: true, data: { ok: true, data: { assessments: [assessment("v1")] } } });
  await sleep(20); assert.equal(card.action, "show");
  assert.ok(h.calls.some(c => c.type === "FF_AUTO_CANCEL"));
  h.prefs.focusfeedSettingsV2.enabled = false; await h.runtime.reload();
  h.runtime.navigate(false); await sleep(20); assert.equal(card.action, "show");
  h.runtime.stop();
});
test("Focus failures keep unchecked recommendations covered while explicit blocks remain active", async () => {
  const h = harness(async () => { throw new Error("offline"); });
  h.prefs.focusfeedSettingsV2.focusSession = { active: true };
  const c = h.add("v1"); await h.runtime.reload(); await sleep(330);
  assert.equal(c.action, "pending"); assert.equal(c.reason, "check_retrying");
  assert.match(h.runtime.snapshot().status, /Backend unavailable/);
  h.prefs.focusFeedChannelBlocksV1 = [{ channelId: "@creator", scope: "global" }];
  await h.runtime.reload(); assert.equal(c.action, "hide"); assert.equal(c.reason, "channel_block");
  h.runtime.stop();
});
test("mismatched objective judgments remain covered while General retries", async () => {
  const h = harness(async m => {
    const a = assessment(m.request.videos[0].videoId); a.objectiveMatches[0].objectiveId = "wrong";
    return { ok: true, data: { ok: true, data: { assessments: [a] } } };
  });
  const c = h.add("v1"); await h.runtime.reload(); await sleep(330);
  assert.equal(c.action, "pending"); assert.equal(c.reason, "check_retrying"); h.runtime.stop();
});
test("expired Focus returns to saved General without opening popup", async () => {
  const h = harness(); const c = h.add("v1");
  h.prefs.focusfeedSettingsV2.focusSession = { active: true, endsAt: new Date(Date.now() + 500).toISOString() };
  await h.runtime.reload(); await sleep(350); assert.equal(c.action, "show", "Focus keeps a matching video");
  await sleep(250); assert.equal(c.action, "hide", "General avoids that same topic after Focus expires");
  assert.equal(h.runtime.snapshot().mode, "general"); h.runtime.stop();
});
test("provider request strips UI settings and identity aliases", () => {
  const request = FocusFeedVideo.cloudRequest({ requestId: "test-123", profile: { ...profile(), updatedAt: "x" },
    videos: [{ videoId: "v", title: "Title", aliases: ["@creator"] }] });
  assert.deepEqual(Object.keys(request.profile).sort(), ["id", "mode", "objectives", "version"]);
  assert.equal(request.videos[0].aliases, undefined);
});
test("Hide Shorts applies locally without topics and remains active across scans", async () => {
  const h = harness(() => { throw new Error("The provider must not be called"); });
  h.prefs.focusfeedSettingsV2.hideShorts = true;
  h.prefs.focusfeedSettingsV2.general.objectives = [];
  const c = h.add("short"); c.video.isShort = true;
  await h.runtime.reload(); assert.equal(c.action, "hide"); assert.equal(c.reason, "shorts_block");
  h.runtime.tick(); assert.equal(c.action, "hide"); assert.equal(h.calls.length, 0);
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
  c.video.isShort = false;
  await h.runtime.reload(); assert.equal(c.action, "show");
  await sleep(330); assert.equal(h.calls.length, 0); h.runtime.stop();
});
test("hung transport is cancelled within its deadline and unchecked cards stay covered", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const context = vm.createContext({ console, Date, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 680000 ? 10 : ms) });
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
  await runtime.reload(); assert.equal(action, "pending"); await sleep(350);
  assert.equal(action, "pending"); assert.equal(cancelled.length, 1); runtime.stop();
});
test("runtime supplies a bounded refill window without multiplying it by topic count", async t => {
  const h = harness();
  t.after(h.runtime.stop);
  for (let i = 0; i < 45; i++) h.add("v" + i);
  await h.runtime.reload(); await sleep(330);
  assert.equal(h.calls.find(c => c.type === "FF_AUTO_CLASSIFY").request.videos.length, 40);
  h.runtime.stop();
  const full = harness();
  t.after(full.runtime.stop);
  full.prefs.focusfeedSettingsV2.general.objectives = Array.from({ length: 12 }, (_v, i) => ({ ...topic, id: "topic-" + i, text: "Preference " + i }));
  for (let i = 0; i < 12; i++) full.add("v" + i);
  await full.runtime.reload(); await sleep(330);
  assert.equal(full.calls.find(c => c.type === "FF_AUTO_CLASSIFY").request.videos.length, 12);
  full.runtime.stop();
});
test("cached sources remain visible and expiry refreshes the existing card", async t => {
  const h = harness(async m => ({ ok: true, data: { ok: true, data: {
    assessments: m.request.videos.map(v => assessment(v.videoId)),
    diagnostics: { usage: { input_tokens: 0, output_tokens: 0 }, cache: {
      hits: 1, providerCalls: 0, providerQuestions: 0,
      byVideo: { v1: { source: "cache", expiresAt: Date.now() + 60 } } } }
  } } }));
  t.after(h.runtime.stop);
  const c = h.add("v1"); await h.runtime.reload(); await sleep(330);
  assert.equal(c.reason, "cache");
  assert.equal(h.runtime.snapshot().metrics.cacheHits, 1);
  await sleep(100); h.scan(); assert.equal(c.action, "hide", "settled visibility persists during refresh");
  const deadline = performance.now() + 2000;
  while (h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length < 2 && performance.now() < deadline) await sleep(25);
  assert.equal(h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 2);
  h.runtime.stop();
});
test("identity enrichment, timer edits and returning to Home reuse a settled video without a second request", async t => {
  const h = harness(); t.after(h.runtime.stop); const item = h.add("one");
  await h.runtime.reload(); await sleep(330);
  item.video.channelId = "UCresolved12345"; h.scan();
  h.prefs.focusfeedSettingsV2.general.sessionDurationMinutes = 60; h.prefs.focusfeedSettingsV2.general.version++;
  await h.runtime.reload(); assert.equal(item.action, "hide");
  h.runtime.navigate(true); h.runtime.navigate(false); await sleep(330);
  assert.equal(item.action, "hide");
  assert.equal(h.calls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 1);
});
test("semantic refresh and failure preserve a filtered card's visibility", async t => {
  let fail = false;
  const h = harness(async m => {
    if (fail) throw new Error("offline");
    return { ok: true, data: { ok: true, data: { assessments: m.request.videos.map(v => assessment(v.videoId)) } } };
  }); t.after(h.runtime.stop); const item = h.add("one");
  await h.runtime.reload(); await sleep(330); assert.equal(item.action, "hide");
  fail = true; item.video.description = "New relevant evidence"; h.scan(); assert.equal(item.action, "hide");
  await sleep(330); assert.equal(item.action, "hide");
  item.video.description = ""; h.scan(); assert.equal(item.action, "hide", "partial DOM observations cannot erase canonical metadata");
});
test("identified collections enter the normal classifier under their own identity", async t => {
  const h = harness(); t.after(h.runtime.stop); const item = h.add("seed-video");
  item.video.collection = true; item.video.collectionId = "RDmusic"; item.video.title = "Mix - Songs";
  h.prefs.focusFeedChannelBlocksV1 = [{ scope: "global", channelId: "@creator" }];
  await h.runtime.reload(); await sleep(330);
  const request = h.calls.find(m => m.type === "FF_AUTO_CLASSIFY").request;
  assert.equal(request.videos[0].videoId, "collection:RDmusic");
  assert.equal(request.videos[0].itemType, "collection"); assert.equal(request.videos[0].channelId, undefined);
  assert.equal(item.reason, "model"); assert.equal(item.action, "hide");
});
test("individual progress frees work-window capacity and rejects stale or malformed updates", async t => {
  const pending = [];
  const h = harness(message => new Promise(resolve => pending.push({ message, resolve })));
  t.after(h.runtime.stop);
  for (let i = 0; i < 60; i++) h.add("stream-" + i);
  await h.runtime.reload(); await sleep(350);
  const first = h.calls.find(c => c.type === "FF_AUTO_CLASSIFY");
  assert.equal(first.request.videos.length, 40);
  const a = assessment(first.request.videos[0].videoId);
  h.runtime.progress({ requestId: "stale", assessment: a });
  assert.equal(h.cards[0].action, "pending");
  h.runtime.progress({ requestId: first.request.requestId, assessment: { ...a, outcome: "no_match" } });
  assert.equal(h.cards[0].action, "pending", "inconsistent scores cannot admit a card");
  h.runtime.progress({ requestId: first.request.requestId, assessment: a, origin: { source: "model", expiresAt: Date.now() + 300000 } });
  assert.equal(h.cards[0].action, "hide", "the first settled card is rendered before the rest of its window");
  await sleep(350);
  const followup = h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY")[1];
  assert.equal(followup.request.videos.length, 1, "an eligible queued card fills the freed work slot");
  await h.runtime.reload(true);
  h.runtime.progress({ requestId: first.request.requestId, assessment: a });
  assert.equal(h.cards[0].action, "pending", "late progress cannot restore a cleared decision");
  h.runtime.stop();
  pending.forEach(({ message, resolve }) => resolve({ ok: true, data: { ok: true, data: {
    assessments: message.request.videos.map(v => assessment(v.videoId))
  } } }));
});
test("failed checks retry three times then allow an isolated manual Retry", async t => {
  let allow = false;
  const h = harness(async m => {
    if (m.request.videos.some(v => v.videoId === "failed") && !allow) throw new Error("offline");
    return { ok: true, data: { ok: true, data: { assessments: m.request.videos.map(v => assessment(v.videoId)) } } };
  }, { retryDelays: [1, 1, 1] });
  t.after(h.runtime.stop); const failed = h.add("failed");
  await h.runtime.reload();
  async function until(predicate) {
    const deadline = performance.now() + 5000;
    while (!predicate() && performance.now() < deadline) await sleep(10);
    assert.ok(predicate(), JSON.stringify({ calls: h.calls.map(m => m.type), status: h.runtime.snapshot().status, reason: failed.reason }));
  }
  await until(() => failed.reason === "check_failed");
  assert.equal(h.calls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 4);
  assert.equal(failed.action, "pending");
  const other = h.add("other"); h.scan(); await until(() => other.action === "hide");
  allow = true;
  assert.equal(h.runtime.retry("failed"), true); await until(() => failed.action === "hide");
  assert.deepEqual(h.calls.filter(m => m.type === "FF_AUTO_CLASSIFY").at(-1).request.videos.map(v => v.videoId), ["failed"]);
  assert.equal(other.action, "hide"); assert.equal(h.runtime.retry("other"), false);
});
test("late metadata on an already checked card must not announce a filter update", async t => {
  let complete;
  const h = harness(async m => {
    const response = { ok: true, data: { ok: true, data: { assessments: m.request.videos.map(v => assessment(v.videoId, "no_match")) } } };
    if (m.request.videos[0].duration) return new Promise(resolve => { complete = () => resolve(response); });
    return response;
  });
  t.after(() => { h.runtime.stop(); if (complete) complete(); });
  const item = h.add("checked"); await h.runtime.reload(); await sleep(330);
  assert.equal(item.action, "show"); assert.equal(item.reason, "model");
  item.video.duration = "12:34"; h.scan();
  assert.equal(item.action, "show");
  assert.notEqual(item.reason, "refreshing", "metadata arriving without topic changes is not a filter edit");
});
test("unchanged checked videos stay settled across rescans, duplicate cards and settings reloads", async t => {
  const h = harness(async m => ({ ok: true, data: { ok: true, data: {
    assessments: m.request.videos.map(v => assessment(v.videoId, "no_match"))
  } } }));
  t.after(h.runtime.stop); const item = h.add("checked");
  await h.runtime.reload(); await sleep(330);
  for (let i = 0; i < 5; i++) { h.scan(); h.runtime.tick(); }
  const duplicate = h.add("checked"); h.scan();
  h.prefs.focusfeedSettingsV2.general.version++; h.prefs.focusfeedSettingsV2.revision++;
  await h.runtime.reload(); await sleep(330);
  assert.equal(h.calls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 1);
  assert.equal(item.action, "show"); assert.equal(duplicate.action, "show");
  assert.equal(item.reason, "model"); assert.equal(duplicate.reason, "model");
});
test("cache expiry revalidates a shown card quietly without changing topics", async t => {
  let finish, count = 0, expiresAt;
  const h = harness(async m => {
    count++;
    expiresAt = Date.now() + 250;
    const response = { ok: true, data: { ok: true, data: {
      assessments: m.request.videos.map(v => assessment(v.videoId, "no_match")),
      diagnostics: { cache: { byVideo: { checked: { source: "cache", expiresAt } } } }
    } } };
    return count === 1 ? response : new Promise(resolve => { finish = () => resolve(response); });
  });
  t.after(() => { h.runtime.stop(); if (finish) finish(); });
  const item = h.add("checked"); await h.runtime.reload();
  const deadline = Date.now() + 2000;
  while (item.reason !== "cache" && Date.now() < deadline) await sleep(10);
  assert.equal(item.reason, "cache");
  await sleep(Math.max(0, expiresAt - Date.now()) + 20);
  h.scan(); assert.equal(item.action, "show"); assert.equal(item.reason, "background_refresh");
  await sleep(330); assert.equal(count, 2); assert.equal(item.reason, "background_refresh");
});
for (const rejected of [false, true]) test(`extension-context invalidation during settings reload stops stale work (rejected=${rejected})`, async t => {
  let invalid = false, reads = 0, invalidations = 0, runtime;
  const api = { storage: { local: { get() {
    reads++;
    if (invalid) {
      const error = new Error("Extension context invalidated.");
      if (rejected) return Promise.reject(error);
      throw error;
    }
    return Promise.resolve({ focusfeedSettingsV2: state() });
  } } }, runtime: { sendMessage: async () => ({ ok: true }) } };
  runtime = FocusFeedAutoRuntime.create({ scan() {}, render() {}, clear() {}, invalidated() { invalidations++; } }, api);
  t.after(runtime.stop);
  await runtime.reload(); invalid = true;
  await assert.doesNotReject(() => runtime.reload());
  assert.match(runtime.snapshot().status, /Reload YouTube/);
  const before = reads;
  runtime.navigate(true); runtime.navigate(false); runtime.tick(); await runtime.reload();
  await sleep(20);
  assert.equal(reads, before, "invalidated scripts stop calling extension storage");
  assert.equal(invalidations, 1);
});
for (const trigger of ["navigation", "reload"]) test(`extension-context invalidation during synchronous cancellation is contained (${trigger})`, async t => {
  let invalid = false, finish, runtime, invalidations = 0;
  const api = { storage: { local: { get: async () => ({ focusfeedSettingsV2: state() }) } }, runtime: { sendMessage(message) {
    if (invalid) throw new Error("Extension context invalidated.");
    if (message.type === "FF_AUTO_CANCEL") return Promise.resolve({ ok: true });
    return new Promise(resolve => { finish = () => resolve({ ok: false }); });
  } } };
  const card = { isConnected: true, dataset: {}, getBoundingClientRect: () => ({ top: 10, bottom: 200 }) };
  runtime = FocusFeedAutoRuntime.create({ scan() { runtime.observe(card, { videoId: "context1234", title: "A video" }); }, render() {}, clear() {}, invalidated() { invalidations++; } }, api);
  t.after(() => { invalid = false; runtime.stop(); if (finish) finish(); });
  await runtime.reload(); await sleep(330); invalid = true;
  if (trigger === "navigation") assert.doesNotThrow(() => runtime.navigate(true));
  else await assert.doesNotReject(() => runtime.reload(true));
  await sleep(20);
  assert.match(runtime.snapshot().status, /Reload YouTube/); assert.equal(invalidations, 1);
});
