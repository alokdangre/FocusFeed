"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, videoCard, homePage } = require("./dom-harness");
require("../video-model.js"); require("../channel-policy.js"); require("../settings.js");
require("../learning-policy.js"); require("../channel-evidence.js"); require("../channel-investigations.js"); require("../channel-learning.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topic = { id: "reviews", text: "Movie reviews except documentaries", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
const endpoint = "http://127.0.0.1:3000", P = FocusFeedLearningPolicy;
async function setup(t, pathname = "/results", mode = "general") {
  const markup = videoCard("abcdefghijk", "@reviewer") + videoCard("lmnopqrstuv", "@reviewer");
  const h = dom((pathname === "/" ? homePage(markup) : markup) + '<ytd-popup-container><ytd-menu-popup-renderer><div id="items"></div></ytd-menu-popup-renderer></ytd-popup-container>', pathname);
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  let state = FocusFeedSettings.migrate({});
  state = FocusFeedSettings.update(state, { type: "saveProfile", profile: { id: "general", version: 1, mode: "general", objectives: [topic] } });
  if (mode === "focus") { state.focus = { ...state.general, id: "focus", mode: "focus" }; state.focusSession = { active: true }; }
  const data = { focusfeedSettingsV2: state }, changed = [], messages = [], contentMessages = [];
  let writing = Promise.resolve(), release, modelMatch = false;
  const storage = { get: async defaults => ({ ...defaults, ...data }), set: async values => {
    Object.assign(data, values); changed.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([k, newValue]) => [k, { newValue }])), "local"));
  } };
  const service = FocusFeedChannelLearning.create({ storage,
    write(operation) { const next = writing.then(operation); writing = next.catch(() => {}); return next; },
    endpoint: async () => endpoint, contract: async () => ({ model: "jev-1.13.0", channelPromptVersion: P.PROMPT }),
    fetch: async () => ({ ok: true, text: async () => '<script>var ytInitialData=' + JSON.stringify({
      metadata: { channelMetadataRenderer: { externalId: "UCreviewer12345", title: "Reviewer", description: "Movie reviews", vanityChannelUrl: "https://www.youtube.com/@reviewer" } },
      contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { title: "Videos", selected: true, content: Array.from({ length: 12 }, (_, i) => ({
        videoRenderer: { videoId: String(i).padStart(11, "a"), title: { simpleText: "Movie " + i + " review" } }
      })) } }] } }
    }) + '</script>' }),
    request: (_path, options) => new Promise(resolve => {
      const request = JSON.parse(options.body);
      release = () => resolve({ requestId: request.requestId, channelId: request.channel.channelId, classifier: { model: "jev-1.13.0", promptVersion: P.PROMPT },
        matches: request.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, blockChannel: true, dominantProbability: .98 })) });
    })
  });
  h.context.chrome = { storage: { local: storage, onChanged: { addListener: fn => changed.push(fn) } }, runtime: {
    onMessage: { addListener: fn => contentMessages.push(fn) }, sendMessage: async message => {
      messages.push(message);
      if (message.type === "FF_CORRECTION_ADD") return { ok: true, data: await service.correct(message, FocusFeedSettings.effective(data.focusfeedSettingsV2)) };
      if (message.type === "FF_CORRECTION_UNDO") return { ok: true, data: await service.undo(message.id) };
      if (message.type === "FF_CHANNEL_LEARN") return { ok: true, data: message.triggerId ? await service.learn(message.video, FocusFeedSettings.effective(data.focusfeedSettingsV2), message.triggerId) : { status: "cached" } };
      if (message.type === "FF_AUTO_CLASSIFY") return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => ({
        videoId: video.videoId, reason: "fixture", outcome: modelMatch ? "match" : "no_match",
        objectiveMatches: message.request.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: modelMatch ? .95 : .05 }))
      })) } } };
      return { ok: true };
    }
  } };
  h.load(...require("../manifest.json").content_scripts.find(g => g.world === "ISOLATED").js);
  await sleep(350);
  const cards = Array.from(h.document.querySelectorAll("ytd-rich-item-renderer"));
  async function open(card = cards[0]) { card.querySelector("ytd-menu-renderer button").click(); await tick(); }
  return { ...h, data, messages, cards, service, open, contentMessages, storage,
    release: async () => { while (!release) await tick(); release(); await tick(); await tick(); },
    setModelMatch: value => { modelMatch = value; } };
}
for (const pathname of ["/results", "/"]) test("correction hides immediately, learns the channel across cards, and Undo restores: " + pathname, async t => {
  const h = await setup(t, pathname);
  assert.equal(h.cards[0].dataset.focusfeedAutoHidden, undefined); await h.open();
  const button = h.document.querySelector(".focusfeed-topic-action"); assert.match(button.textContent, /Hide as topic/);
  button.click();
  assert.equal(h.messages.some(m => m.type === "FF_CORRECTION_ADD"), false, "opening the picker does not label the video");
  h.document.querySelector(".focusfeed-topic-choice").click(); await tick(); await tick();
  assert.equal(h.cards[0].dataset.focusfeedAutoHidden, "true", "correction applies before channel inference finishes");
  assert.equal(h.cards[1].dataset.focusfeedAutoHidden, undefined);
  await h.release();
  assert.equal(h.cards[1].dataset.focusfeedAutoHidden, "true", "the old wrong show decision is overridden");
  const requests = h.messages.filter(m => m.type === "FF_AUTO_CLASSIFY").length;
  h.document.querySelector(".focusfeed-toast button").click(); await tick(); await tick();
  assert.equal(h.cards[0].dataset.focusfeedAutoHidden, undefined); assert.equal(h.cards[1].dataset.focusfeedAutoHidden, undefined);
  assert.equal(h.messages.filter(m => m.type === "FF_AUTO_CLASSIFY").length, requests, "Undo reuses the original raw scores");
});

test("losing Pro access closes review and removes topic actions while keeping manual channel controls", async t => {
  const h = await setup(t); await h.open();
  assert.ok(h.document.querySelector(".focusfeed-topic-action"));
  h.contentMessages.forEach(fn => fn({ type: "FF_REVIEW_HIDDEN" }, {}, () => {}));
  assert.equal(h.document.documentElement.hasAttribute("data-focusfeed-review-hidden"), true);
  const before = h.messages.filter(message => message.type === "FF_AUTO_CLASSIFY").length;
  await h.storage.set({ focusfeedAccountV1: { endpoint, mode: "required", userId: "expired", premium: false, validUntil: 0 } });
  await sleep(150); await h.open();
  assert.equal(h.document.documentElement.hasAttribute("data-focusfeed-review-hidden"), false);
  assert.equal(h.document.querySelector(".focusfeed-topic-action"), null);
  assert.ok(h.document.querySelector(".focusfeed-menu-action"));
  assert.equal(h.messages.filter(message => message.type === "FF_AUTO_CLASSIFY").length, before);
});
test("review mode offers the reverse correction and restores a video despite its channel rule", async t => {
  const h = await setup(t); await h.open(); h.document.querySelector(".focusfeed-topic-action").click();
  h.document.querySelector(".focusfeed-topic-choice").click(); await tick(); await h.release();
  const listener = h.contentMessages.find(fn => { let found = false; fn({ type: "FF_REVIEW_HIDDEN" }, {}, result => { found = !!result.reviewing; }); return found; });
  assert.ok(listener); assert.equal(h.document.documentElement.hasAttribute("data-focusfeed-review-hidden"), true);
  await h.open(); const restore = h.document.querySelector(".focusfeed-topic-action"); assert.match(restore.textContent, /This isn.t/);
  restore.click(); h.document.querySelector(".focusfeed-topic-choice").click(); await tick(); await tick();
  assert.equal(h.cards[0].dataset.focusfeedAutoHidden, undefined); assert.equal(h.cards[1].dataset.focusfeedAutoHidden, "true");
  h.document.querySelector(".focusfeed-review-banner button").click(); assert.equal(h.document.documentElement.hasAttribute("data-focusfeed-review-hidden"), false);
});
test("a recycled card's old feedback action cannot label its replacement", async t => {
  const h = await setup(t); await h.open(); const button = h.document.querySelector(".focusfeed-topic-action");
  h.cards[0].querySelector("#video-title-link").setAttribute("href", "/watch?v=zyxwvutsrqp"); button.click(); await tick();
  assert.equal(h.messages.some(m => m.type === "FF_CORRECTION_ADD"), false);
  assert.match(h.document.querySelector(".focusfeed-toast").textContent, /changed/);
});
test("Focus does not expose General correction actions", async t => {
  const h = await setup(t, "/results", "focus"); await h.open();
  assert.equal(h.document.querySelector(".focusfeed-topic-action"), null);
});
test("many preferences expose one menu entry and search selects only the requested topic", async t => {
  const h = await setup(t);
  const topics = [topic, ...Array.from({ length: 7 }, (_, i) => ({ ...topic, id: "intent-" + i, text: "Topic " + i }))];
  h.data.focusfeedSettingsV2.general.objectives = topics; h.data.focusfeedSettingsV2.revision++;
  await h.storage.set({ focusfeedSettingsV2: h.data.focusfeedSettingsV2 }); await tick();
  const deadline = performance.now() + 3000;
  while ((!h.messages.some(m => m.type === "FF_AUTO_CLASSIFY" && m.request.profile.objectives.length === 8) ||
      h.cards[0].hasAttribute("data-focusfeed-refreshing")) && performance.now() < deadline) await sleep(10);
  await h.open();
  assert.equal(h.document.querySelectorAll(".focusfeed-topic-action").length, 1);
  const count = h.messages.length; h.document.querySelector(".focusfeed-topic-action").click();
  assert.equal(h.messages.length, count, "opening the picker is local");
  const search = h.document.querySelector(".focusfeed-topic-picker-search"); search.value = "Topic 6"; search.dispatchEvent(new h.window.Event("input"));
  assert.equal(h.document.querySelectorAll(".focusfeed-topic-choice").length, 1);
  assert.equal(h.messages.length, count, "searching is local");
  h.document.querySelector(".focusfeed-topic-choice").click(); await tick(); await tick();
  assert.equal(h.data.focusfeedCorrectionsV1.items[0].topic, "Topic 6");
  assert.equal(h.document.querySelector(".focusfeed-topic-picker"), null);
  await h.release();
});
test("recycling the card after opening the picker cannot label the replacement", async t => {
  const h = await setup(t); await h.open(); h.document.querySelector(".focusfeed-topic-action").click();
  h.cards[0].querySelector("#video-title-link").setAttribute("href", "/watch?v=zyxwvutsrqp");
  h.document.querySelector(".focusfeed-topic-choice").click(); await tick();
  assert.equal(h.messages.some(m => m.type === "FF_CORRECTION_ADD"), false);
  assert.match(h.document.querySelector(".focusfeed-toast").textContent, /changed/);
});
test("changing preferences dismisses the picker and old rows cannot save feedback", async t => {
  const h = await setup(t); await h.open(); h.document.querySelector(".focusfeed-topic-action").click();
  const old = h.document.querySelector(".focusfeed-topic-choice");
  h.data.focusfeedSettingsV2.revision++; await h.storage.set({ focusfeedSettingsV2: h.data.focusfeedSettingsV2 }); await tick(); await tick();
  assert.equal(h.document.querySelector(".focusfeed-topic-picker"), null);
  old.click(); await tick(); assert.equal(h.messages.some(m => m.type === "FF_CORRECTION_ADD"), false);
});
