"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, homePage, videoCard } = require("./dom-harness");
require("../video-model.js"); require("../channel-policy.js"); require("../settings.js"); require("../learning-policy.js");
require("../channel-evidence.js"); require("../channel-investigations.js"); require("../channel-learning.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topic = { id: "korea", text: "K-dramas and Korea", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
function collection(id, name) {
  return `<ytd-rich-item-renderer data-collection="${name}"><a id="video-title-link" href="/watch?v=abcdefghijk&amp;list=${id}">Mixed collection ${id}</a><yt-collection-thumbnail-view-model></yt-collection-thumbnail-view-model><ytd-menu-renderer><button aria-haspopup="true">Menu</button></ytd-menu-renderer></ytd-rich-item-renderer>`;
}
async function setup(t, pathname = "/results", mode = "general", topics = true) {
  const cards = collection("PLkorea", "first") + collection("PLkorea", "copy") + collection("PLother", "other") + videoCard("abcdefghijk", "@seedcreator");
  const h = dom((pathname === "/" ? homePage(cards) : cards) + '<ytd-popup-container><ytd-menu-popup-renderer><div id="items"></div></ytd-menu-popup-renderer></ytd-popup-container>', pathname);
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  const state = FocusFeedSettings.migrate({}); state.general = { id: "general", version: topics ? 1 : 0, mode: "general", objectives: topics ? [topic] : [] };
  state.focus = { ...state.general, id: "focus", mode: "focus" }; state.focusSession = { active: mode === "focus" };
  const data = { focusfeedSettingsV2: state }, listeners = [], calls = []; let writes = Promise.resolve();
  const storage = { get: async defaults => ({ ...defaults, ...data }), set: async values => {
    Object.assign(data, values); listeners.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([k, newValue]) => [k, { newValue }])), "local"));
  } };
  const service = FocusFeedChannelLearning.create({ storage, write(operation) { const next = writes.then(operation); writes = next.catch(() => {}); return next; } });
  h.context.chrome = { storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } }, runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
    calls.push(message);
    if (message.type === "FF_COLLECTION_HIDE") return { ok: true, data: await service.hideCollection(message.video) };
    if (message.type === "FF_CORRECTION_ADD") return { ok: true, data: await service.correct(message, FocusFeedSettings.effective(state)) };
    if (message.type === "FF_CORRECTION_UNDO") return { ok: true, data: await service.undo(message.id) };
    if (message.type === "FF_AUTO_CLASSIFY") return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(v => ({
      videoId: v.videoId, outcome: mode === "focus" ? "match" : "no_match", reason: "fixture",
      objectiveMatches: [{ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: mode === "focus" ? .95 : .05 }]
    })) } } };
    return { ok: true, data: { status: "skipped" } };
  } } };
  h.load(...require("../manifest.json").content_scripts.find(g => g.world === "ISOLATED").js); await sleep(350);
  const first = h.document.querySelector('[data-collection="first"]'), copy = h.document.querySelector('[data-collection="copy"]');
  async function open(card = first) { card.querySelector("ytd-menu-renderer button").click(); await tick(); }
  return { ...h, first, copy, data, calls, open, other: h.document.querySelector('[data-collection="other"]'), seed: h.document.querySelector('[data-id="abcdefghijk"]') };
}
for (const pathname of ["/results", "/"]) test("Hide this collection hides copies and supports Undo without touching seed videos: " + pathname, async t => {
  const h = await setup(t, pathname); await h.open();
  assert.equal(h.document.querySelector(".focusfeed-menu-action"), null, "there is no single-channel block target");
  const button = h.document.querySelector(".focusfeed-collection-action"); assert.ok(button); assert.equal(button.disabled, false);
  const channelCalls = h.calls.filter(m => m.type === "FF_CHANNEL_LEARN").length;
  button.click(); await tick(); await tick();
  assert.equal(h.first.dataset.focusfeedAutoHidden, "true"); assert.equal(h.copy.dataset.focusfeedAutoHidden, "true");
  assert.equal(h.other.dataset.focusfeedAutoHidden, undefined); assert.equal(h.seed.dataset.focusfeedAutoHidden, undefined);
  assert.equal(h.calls.filter(m => m.type === "FF_CHANNEL_LEARN").length, channelCalls);
  h.document.querySelector(".focusfeed-toast button").click(); await tick(); await tick();
  assert.equal(h.first.dataset.focusfeedAutoHidden, undefined); assert.equal(h.copy.dataset.focusfeedAutoHidden, undefined);
});
test("a collection topic correction does not start channel learning and leaves the seed video alone", async t => {
  const h = await setup(t); await h.open(); const before = h.calls.filter(m => m.type === "FF_CHANNEL_LEARN").length;
  h.document.querySelector(".focusfeed-topic-action").click();
  h.document.querySelector(".focusfeed-topic-choice").click(); await tick(); await tick();
  assert.equal(h.first.dataset.focusfeedAutoHidden, "true"); assert.equal(h.copy.dataset.focusfeedAutoHidden, "true");
  assert.equal(h.seed.dataset.focusfeedAutoHidden, undefined); assert.equal(h.other.dataset.focusfeedAutoHidden, undefined);
  const item = h.data.focusfeedCorrectionsV1.items[0]; assert.equal(item.itemType, "collection"); assert.equal(item.topic, "K-dramas and Korea");
  assert.equal(h.calls.filter(m => m.type === "FF_CHANNEL_LEARN").length, before);
});
test("collections can be hidden in Focus without any confirmed topic", async t => {
  const h = await setup(t, "/results", "focus", false); await h.open();
  assert.equal(h.document.querySelector(".focusfeed-topic-action"), null);
  h.document.querySelector(".focusfeed-collection-action").click(); await tick(); await tick();
  assert.equal(h.first.dataset.focusfeedAutoHidden, "true"); assert.equal(h.calls.some(m => m.type === "FF_AUTO_CLASSIFY"), false);
});
test("a recycled collection's old menu cannot hide its replacement", async t => {
  const h = await setup(t); await h.open(); const button = h.document.querySelector(".focusfeed-collection-action");
  h.first.querySelector("a").setAttribute("href", "/watch?v=abcdefghijk&list=PLreplacement"); button.click(); await tick();
  assert.equal(h.calls.some(m => m.type === "FF_COLLECTION_HIDE"), false);
  assert.match(h.document.querySelector(".focusfeed-toast").textContent, /changed/);
});
