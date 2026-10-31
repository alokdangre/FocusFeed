"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require("../video-model.js"); require("../channel-policy.js"); require("../settings.js"); require("../score-cache.js"); require("../auto-runtime.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await sleep(10);
  assert.ok(predicate(), "classification did not settle");
}
const topic = id => ({ id, text: id, sourceText: id, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" });
for (const mode of ["general", "focus"]) test(`${mode}: adding a topic keeps settled cards and sends only the missing judgment for undecided videos`, async t => {
  const initial = topic("songs"), added = topic("gaming");
  const state = { schemaVersion: 2, revision: 1, enabled: true,
    general: { id: "general", mode: "general", version: 1, objectives: [initial] },
    focus: { id: "focus", mode: "focus", version: 1, objectives: [initial] }, focusSession: { active: mode === "focus" } };
  const cards = ["already-matching", "other-video"].map(videoId => ({ video: { videoId, title: videoId },
    card: { isConnected: true, dataset: {}, getBoundingClientRect: () => ({ top: 10, bottom: 200 }) } }));
  const outbound = []; let finishNew, runtime;
  const scores = FocusFeedScoreCache.create(async (_id, request) => {
    outbound.push(request);
    const response = { ok: true, data: { assessments: request.videos.map(v => {
      const matches = request.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic",
        matchProbability: o.id === "gaming" || v.videoId === "already-matching" ? .95 : .05 }));
      return { videoId: v.videoId, objectiveMatches: matches, outcome: FocusFeedVideo.outcome(matches), reason: "fixture" };
    }) } };
    if (request.profile.objectives.some(o => o.id === "gaming")) return new Promise(resolve => { finishNew = () => resolve(response); });
    return response;
  });
  const api = { storage: { local: { get: async () => ({ focusfeedSettingsV2: state }) } }, runtime: { sendMessage: async message => {
    if (message.type === "FF_AUTO_CANCEL") { scores.cancel(1, message.requestId); return { ok: true }; }
    return { ok: true, data: await scores.submit(1, message.request, "test-contract") };
  } } };
  runtime = FocusFeedAutoRuntime.create({ scan: () => cards.forEach(v => runtime.observe(v.card, v.video)), clear() {},
    render(card, video, action) { cards.find(v => v.card === card).action = action; } }, api);
  t.after(runtime.stop);
  await runtime.reload(); await until(() => cards.every(v => v.action !== "pending"));
  const previous = cards.map(v => v.action);
  state[mode].objectives = [initial, added]; state[mode].version++; state.revision++;
  await runtime.reload();
  assert.deepEqual(cards.map(v => v.action), previous, "adding a preference must not blank or reveal the settled feed");
  await until(() => !!finishNew);
  assert.deepEqual(outbound[1].profile.objectives.map(o => o.id), ["gaming"]);
  assert.deepEqual(outbound[1].videos.map(v => v.videoId), ["other-video"], "a positive retained match needs no additional inference");
  assert.deepEqual(cards.map(v => v.action), previous, "keep decisions while the new topic response is pending");
  finishNew(); await until(() => cards[1].action === (mode === "general" ? "hide" : "show"));
  assert.equal(outbound.length, 2);
});

for (const mode of ["general", "focus"]) test(`${mode}: removing a topic applies the remaining cached scores immediately without blanking cards`, async t => {
  const songs = topic("songs"), science = topic("science"), renamed = { ...science, id: "new-science-tag" };
  const state = { schemaVersion: 2, revision: 1, enabled: true,
    general: { id: "general", mode: "general", version: 1, objectives: [songs, science] },
    focus: { id: "focus", mode: "focus", version: 1, objectives: [songs, science] }, focusSession: { active: mode === "focus" } };
  const cards = ["songs-only", "science-only", "neither"].map(videoId => ({ video: { videoId, title: videoId },
    card: { isConnected: true, dataset: {}, getBoundingClientRect: () => ({ top: 10, bottom: 200 }) } }));
  let requests = 0, runtime; const transitions = [];
  const api = { storage: { local: { get: async () => ({ focusfeedSettingsV2: state }) } }, runtime: { sendMessage: async message => {
    if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
    requests++;
    return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => {
      const matches = message.request.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic",
        matchProbability: video.videoId === o.text + "-only" ? .95 : .05 }));
      return { videoId: video.videoId, outcome: FocusFeedVideo.outcome(matches), objectiveMatches: matches, reason: "fixture" };
    }) } } };
  } } };
  runtime = FocusFeedAutoRuntime.create({ scan: () => cards.forEach(v => runtime.observe(v.card, v.video)), clear() {},
    render(card, video, action) { cards.find(v => v.card === card).action = action; transitions.push(action); } }, api);
  t.after(runtime.stop);
  await runtime.reload(); await until(() => cards.every(v => v.action && v.action !== "pending"));
  transitions.length = 0;
  state[mode].objectives = [renamed]; state[mode].version++; state.revision++;
  await runtime.reload();
  assert.deepEqual(cards.map(v => v.action), mode === "general" ? ["show", "hide", "show"] : ["hide", "show", "hide"]);
  assert.ok(!transitions.includes("pending"), "topic removal must not replace settled cards with skeletons");
  assert.equal(requests, 1, "removing a topic needs neither another worker classification nor a provider request");
  const snapshots = runtime.snapshot().records;
  assert.ok(snapshots.every(r => r.assessment.objectiveMatches.length === 1 && r.assessment.objectiveMatches[0].objectiveId === renamed.id), "scores follow semantic topic identity rather than UI tag IDs");
});
