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
test("only uncertain automatic results investigate channels; no-match results stop", async t => {
  for (const [outcome, probability, expected] of [["no_match", .1, 0], ["uncertain", .35, 1]]) {
    const h = harness(message => {
      if (message.type !== "FF_AUTO_CLASSIFY") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true, data: { ok: true, data: {
        assessments: message.request.videos.map(v => ({ videoId: v.videoId, outcome, reason: "fixture",
          objectiveMatches: message.request.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: probability })) }))
      } } });
    });
    t.after(h.runtime.stop); h.add(1); await h.runtime.reload(); await sleep(350);
    assert.equal(h.calls.filter(c => c.type === "FF_CHANNEL_LEARN").length, expected);
  }
});
test("an existing video match skips channel mapping when another topic is added", async t => {
  const h = harness(message => message.type !== "FF_AUTO_CLASSIFY" ? Promise.resolve({ ok: true }) : Promise.resolve({
    ok: true, data: { ok: true, data: { assessments: message.request.videos.map(v => ({ videoId: v.videoId, outcome: "match", reason: "fixture",
      objectiveMatches: [{ objectiveId: "movie roasting", text: "movie roasting", contentType: "topic", matchProbability: .9 }] })) } }
  }));
  t.after(h.runtime.stop); const item = h.add(1); await h.runtime.reload(); await sleep(350);
  h.known(); h.prefs[P.PROFILES][0].judgments = [h.mapping(topic("celebrity gossip"))];
  h.prefs.focusfeedSettingsV2.general.objectives.push(topic("anything about movies")); h.prefs.focusfeedSettingsV2.revision++;
  await h.runtime.reload(); await sleep(300);
  assert.equal(item.action, "hide");
  assert.equal(h.calls.filter(c => c.type === "FF_CHANNEL_LEARN").length, 0);
  assert.equal(h.calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 1);
});
test("Undo of a user-only negative label requests the previously skipped raw judgment", async t => {
  let requests = 0;
  const h = harness(message => {
    if (message.type !== "FF_AUTO_CLASSIFY") return Promise.resolve({ ok: true });
    requests++;
    return Promise.resolve({ ok: true, data: { ok: true, data: { assessments: message.request.videos.map(v => ({
      videoId: v.videoId, outcome: requests === 1 ? "no_match" : "match", reason: "fixture",
      objectiveMatches: message.request.profile.objectives.map((o, i) => ({
        objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: requests === 1 ? .1 : .9,
        ...(requests === 1 && i === 0 ? { labelSource: "user" } : {})
      }))
    })) } } });
  });
  t.after(h.runtime.stop); const item = h.add(1), original = h.prefs.focusfeedSettingsV2.general.objectives[0];
  h.prefs.focusfeedSettingsV2.general.objectives.push(topic("gaming"));
  h.prefs[P.CORRECTIONS] = { ...P.empty(), items: [{ videoId: item.video.videoId, topicKey: FocusFeedVideo.objectiveKey(original), match: false }] };
  await h.runtime.reload(); await sleep(350); assert.equal(item.action, "show"); assert.equal(requests, 1);
  h.prefs[P.CORRECTIONS].items = []; await h.runtime.reload(); await sleep(350);
  assert.equal(requests, 2); assert.equal(item.action, "hide");
});
