"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require("../video-model.js"); require("../channel-policy.js"); require("../settings.js"); require("../learning-policy.js"); require("../auto-runtime.js");
const P = FocusFeedLearningPolicy, endpoint = "http://127.0.0.1:3000", sleep = ms => new Promise(r => setTimeout(r, ms));
const topic = text => ({ id: text, text, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" });
function harness(handler) {
  const initial = { id: "general", version: 1, mode: "general", objectives: [topic("movie roasting")] };
  const prefs = { focusfeedSettingsV2: FocusFeedSettings.update(FocusFeedSettings.migrate({}), { type: "saveProfile", profile: initial }) };
  const cards = [], calls = []; let runtime;
  const api = { storage: { local: { get: async () => prefs } }, runtime: { sendMessage: async message => {
    calls.push(message); if (handler) return handler(message);
    return { ok: true };
  } } };
  runtime = FocusFeedAutoRuntime.create({ scan: () => cards.forEach(c => runtime.observe(c.card, c.video)), clear() {},
    render(card, _video, action, reason) { const item = cards.find(c => c.card === card); item.action = action; item.reason = reason; } }, api);
  function add(i) {
    const item = { card: { isConnected: true, dataset: {}, getBoundingClientRect: () => ({ top: 10, bottom: 200 }) },
      video: { videoId: String(i).padStart(11, "a"), title: "Movie " + i, channelId: "@reviewer", channel: "Reviewer" } };
    cards.push(item); return item;
  }
  function mapping(objective) { return { key: FocusFeedVideo.objectiveKey(objective), text: objective.text,
    contract: "contract", promptVersion: P.PROMPT, blockChannel: true, expiresAt: Date.now() + 10000 }; }
  function known() {
    prefs[P.PROFILES] = [{ channelId: "UCreviewer12345", aliases: ["@reviewer"], endpoint, contract: "contract", expiresAt: Date.now() + 10000,
      judgments: [mapping(initial.objectives[0])] }];
  }
  return { prefs, calls, cards, runtime, add, known, mapping };
}
test("twenty cards from a known channel wait for one broader-topic mapping and make zero video requests", async t => {
  let finish;
  const h = harness(message => message.type === "FF_CHANNEL_LEARN" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
  t.after(h.runtime.stop); h.known(); for (let i = 0; i < 20; i++) h.add(i);
  await h.runtime.reload(); assert.ok(h.cards.every(c => c.action === "hide")); assert.equal(h.calls.length, 0);
  const broad = topic("movies and anything about them"); h.prefs.focusfeedSettingsV2.general.objectives = [broad]; h.prefs.focusfeedSettingsV2.revision++;
  await h.runtime.reload();
  assert.equal(h.calls.filter(c => c.type === "FF_CHANNEL_LEARN").length, 1);
  assert.ok(h.cards.every(c => c.action === "pending"));
  h.prefs[P.PROFILES][0].judgments.push(h.mapping(broad)); finish({ ok: true }); await h.runtime.reload(); await sleep(300);
  assert.ok(h.cards.every(c => c.action === "hide")); assert.equal(h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 0);
});
test("an old no-match response cannot undo a correction, and Undo reuses that raw response", async t => {
  let finish;
  const h = harness(message => {
    if (message.type !== "FF_AUTO_CLASSIFY") return Promise.resolve({ ok: true });
    return new Promise(resolve => { finish = () => resolve({ ok: true, data: { ok: true, data: { assessments: message.request.videos.map(v => ({
      videoId: v.videoId, reason: "fixture", outcome: "no_match", objectiveMatches: message.request.profile.objectives.map(o => ({
        objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: .05
      }))
    })) } } }); });
  });
  t.after(h.runtime.stop); const card = h.add(1); await h.runtime.reload(); await sleep(300);
  const objective = h.prefs.focusfeedSettingsV2.general.objectives[0];
  h.prefs[P.CORRECTIONS] = { ...P.empty(), items: [{ videoId: card.video.videoId, topicKey: FocusFeedVideo.objectiveKey(objective), match: true }] };
  await h.runtime.reload(); assert.equal(card.action, "hide"); finish(); await sleep(20); assert.equal(card.action, "hide");
  h.prefs[P.CORRECTIONS].items = []; await h.runtime.reload();
  assert.equal(card.action, "show"); assert.equal(h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 1);
});
test("learned channel policy never interrupts active playback", async t => {
  const h = harness(); t.after(h.runtime.stop); h.known(); const card = h.add(1); card.video.playback = true;
  await h.runtime.reload(); assert.equal(card.action, "show"); assert.equal(card.reason, "user_playback"); assert.equal(h.calls.length, 0);
});
