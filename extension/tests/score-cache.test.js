"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require("../video-model.js"); require("../score-cache.js");
const topic = text => ({ id: text, text, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" });
function request(id, topics = ["songs"], mode = "general", overrides = {}) {
  return { requestId: id, profile: { id: mode, version: 1, mode, objectives: topics.map(topic) },
    videos: [{ videoId: "abcdefghijk", title: "Music video", channel: "Creator", channelId: "", duration: "3:00", descriptionSnippet: "A song", ...overrides }] };
}
function result(req) {
  return { ok: true, data: { assessments: req.videos.map(video => ({ videoId: video.videoId, outcome: "match", reason: "fixture",
    objectiveMatches: req.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: .95 })) })),
    diagnostics: { cache: { providerCalls: 1, providerQuestions: req.videos.length * req.profile.objectives.length } } } };
}
test("scores reuse across owners, IDs, profile versions and modes; only new topics dispatch", async () => {
  const calls = [], cache = FocusFeedScoreCache.create(async (_id, req) => { calls.push(req); return result(req); });
  await cache.submit(1, request("first"), "endpoint-contract");
  const second = request("second", ["songs"], "focus", { channelId: "UCresolved12345" }); second.profile.version++;
  const reused = await cache.submit(2, second, "endpoint-contract");
  assert.equal(calls.length, 1); assert.equal(reused.data.assessments[0].outcome, "match");
  assert.equal(reused.data.diagnostics.cache.byVideo.abcdefghijk.source, "local_cache");
  await cache.submit(3, request("new-topic", ["songs", "gaming"]), "endpoint-contract");
  assert.deepEqual(calls[1].profile.objectives.map(o => o.text), ["gaming"]);
  assert.equal(calls.reduce((n, req) => n + req.videos.length * req.profile.objectives.length, 0), 2);
  await cache.submit(1, request("different-endpoint"), "new-endpoint"); assert.equal(calls.length, 3);
});
test("concurrent subscribers share work; cancellation of one preserves the other's result", async () => {
  let finish; const calls = [];
  const cache = FocusFeedScoreCache.create((_id, req) => { calls.push(req); return new Promise(resolve => { finish = () => resolve(result(req)); }); });
  const a = cache.submit(1, request("a"), "ns").catch(e => e.message), b = cache.submit(2, request("b"), "ns");
  await new Promise(resolve => setImmediate(resolve));
  cache.cancel(1, "a"); assert.match(await a, /cancelled/); finish();
  assert.equal((await b).data.assessments.length, 1); assert.equal(calls.length, 1);
  assert.equal(cache.snapshot().metrics.sharedPairs, 1);
});
test("persisted scores survive worker reconstruction and expire without reusing changed evidence", async () => {
  const data = {}, storage = { get: async () => data, set: async values => Object.assign(data, values) };
  let count = 0; const dispatch = async (_id, req) => { count++; return result(req); };
  const first = FocusFeedScoreCache.create(dispatch, { storage }); await first.submit(1, request("first"), "ns");
  await new Promise(resolve => setTimeout(resolve, 70));
  const second = FocusFeedScoreCache.create(dispatch, { storage }); await second.submit(2, request("restart"), "ns"); assert.equal(count, 1);
  await second.submit(2, request("changed", ["songs"], "general", { title: "Different video title" }), "ns"); assert.equal(count, 2);
  second.clear(); await second.submit(2, request("cleared"), "ns"); assert.equal(count, 3);
});
test("collections use their own identity and mode-specific boundary; no seed score reuse", async () => {
  let count = 0; const cache = FocusFeedScoreCache.create(async (_id, req) => { count++; return result(req); });
  await cache.submit(1, request("video"), "ns");
  const mix = { videoId: "collection:RDmusic", itemType: "collection", collectionId: "RDmusic", title: "Mix - Songs", entries: [] };
  await cache.submit(1, request("mix", ["songs"], "general", mix), "ns");
  await cache.submit(1, request("focus-mix", ["songs"], "focus", mix), "ns");
  assert.equal(count, 3);
});
test("invalid responses do not poison the shared cache and dispatch failures release subscribers", async () => {
  let count = 0; const cache = FocusFeedScoreCache.create(async (_id, req) => { count++; return count === 1 ? { ok: true, data: { assessments: [] } } : result(req); });
  await assert.rejects(cache.submit(1, request("bad"), "ns"), /Incomplete classifier/);
  await cache.submit(1, request("retry"), "ns"); assert.equal(count, 2);
  assert.equal(cache.snapshot().inFlightPairs, 0);
});
test("relative freshness avoids repeated requests when browser and server clocks differ", async () => {
  let calls = 0;
  const cache = FocusFeedScoreCache.create(async (_id, req) => {
    calls++; const response = result(req);
    response.data.diagnostics.cache.byVideo = { abcdefghijk: { source: "model", expiresAt: Date.now() - 3600000, expiresInMs: 300000 } };
    return response;
  });
  await cache.submit(1, request("first"), "ns");
  await cache.submit(2, request("second"), "ns"); assert.equal(calls, 1);
});
test("cancellation during session restoration dispatches nothing", async () => {
  let restore, cancelled = false, calls = 0;
  const storage = { get: () => new Promise(resolve => { restore = resolve; }), set: async () => {} };
  const cache = FocusFeedScoreCache.create(async (_id, req) => { calls++; return result(req); }, { storage });
  const pending = cache.submit(1, request("navigation"), "ns", () => cancelled);
  cancelled = true; restore({}); await assert.rejects(pending, /cancelled/); assert.equal(calls, 0);
});
