"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require("../video-model.js"); require("../score-cache.js");
const topic = text => ({ id: text, text, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" });
function request(id, topics = ["songs"], mode = "general", overrides = {}) {
  return { requestId: id, profile: { id: mode, version: 1, mode, objectives: topics.map(topic) },
    videos: [{ videoId: "abcdefghijk", title: "Music video", channel: "Creator", channelId: "", duration: "3:00", descriptionSnippet: "A song", ...overrides }] };
}
function result(req, probability = () => .95) {
  return { ok: true, data: { assessments: req.videos.map(video => {
    const matches = req.profile.objectives.filter(o => !req.pairs || req.pairs.some(p => p.videoId === video.videoId && p.objectiveId === o.id))
      .map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: probability(video, o) }));
    return { videoId: video.videoId, outcome: FocusFeedVideo.outcome(matches), reason: "fixture", objectiveMatches: matches };
  }), diagnostics: { cache: { providerCalls: 1, providerQuestions: req.pairs.length } } } };
}
test("scores reuse across owners, IDs, profile versions and modes; only new topics dispatch", async () => {
  const calls = [], cache = FocusFeedScoreCache.create(async (_id, req) => { calls.push(req); return result(req); });
  await cache.submit(1, request("first"), "endpoint-contract");
  const second = request("second", ["songs"], "focus", { channelId: "UCresolved12345" }); second.profile.version++;
  const reused = await cache.submit(2, second, "endpoint-contract");
  assert.equal(calls.length, 1); assert.equal(reused.data.assessments[0].outcome, "match");
  assert.equal(reused.data.diagnostics.cache.byVideo.abcdefghijk.source, "local_cache");
  await cache.submit(3, request("new-topic", ["songs", "gaming"]), "endpoint-contract");
  assert.equal(calls.length, 1, "an existing match skips the newly added topic");
  await cache.submit(3, request("only-gaming", ["gaming"]), "endpoint-contract");
  assert.deepEqual(calls[1].profile.objectives.map(o => o.text), ["gaming"]);
  await cache.submit(1, request("different-endpoint"), "new-endpoint"); assert.equal(calls.length, 3);
});
test("concurrent subscribers share work; cancellation of one preserves the other's result", async () => {
  let finish; const calls = [];
  const cache = FocusFeedScoreCache.create((_id, req) => { calls.push(req); return new Promise(resolve => { finish = () => resolve(result(req)); }); });
  const a = cache.submit(1, request("a"), "ns").catch(e => e.message), b = cache.submit(2, request("b"), "ns");
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
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
test("sequential topic checks refill twenty-card requests with other queued videos", async () => {
  const calls = [], req = request("refill", ["reviews", "gaming"]);
  req.videos = Array.from({ length: 30 }, (_, i) => ({ ...req.videos[0], videoId: "video-" + i }));
  const cache = FocusFeedScoreCache.create(async (_id, outbound) => {
    calls.push(outbound);
    return result(outbound, (v, o) => o.text === "reviews" && Number(v.videoId.split("-")[1]) % 2 === 0 ? .95 : .1);
  });
  const response = await cache.submit(1, req, "ns");
  assert.deepEqual(calls.map(c => c.videos.length), [20, 20, 5]);
  assert.ok(calls.every(c => c.pairs.length === c.videos.length));
  assert.equal(calls[1].profile.objectives.length, 2, "a batch mixes new videos with next-topic checks");
  assert.equal(calls.reduce((n, c) => n + c.pairs.length, 0), 45);
  assert.equal(response.data.assessments.filter(a => a.outcome === "match").length, 15);
  assert.ok(!calls.some(c => c.pairs.some(p => p.objectiveId === "gaming" && Number(p.videoId.split("-")[1]) % 2 === 0)));
});
test("adding a topic checks only unmatched videos and preserves scores for unchanged topics", async () => {
  const calls = [], cache = FocusFeedScoreCache.create(async (_id, req) => {
    calls.push(req); return result(req, v => v.videoId === "matched" ? .95 : .1);
  });
  const old = request("old", ["A", "B", "C"]);
  old.videos = ["matched", "remaining"].map(videoId => ({ ...old.videos[0], videoId }));
  await cache.submit(1, old, "ns"); const previous = calls.length;
  const added = { ...old, requestId: "new", profile: { ...old.profile, objectives: ["A", "B", "C", "D"].map(topic) } };
  const response = await cache.submit(1, added, "ns");
  assert.equal(calls.length, previous + 1);
  assert.deepEqual(calls.at(-1).pairs, [{ videoId: "remaining", objectiveId: "D" }]);
  assert.equal(response.data.assessments.find(a => a.videoId === "matched").objectiveMatches.length, 1);
  const removed = { ...old, requestId: "remove-match", profile: { ...old.profile, objectives: [topic("B")] }, videos: [old.videos[0]] };
  await cache.submit(1, removed, "ns");
  assert.equal(calls.at(-1).pairs[0].objectiveId, "B", "removing the winning topic requires checking a previously skipped topic");
});
test("a negative correction invalidates the cached winning label without replacing the raw score", async () => {
  const calls = [], cache = FocusFeedScoreCache.create(async (_id, req) => { calls.push(req); return result(req, (_v, o) => o.text === "A" ? .9 : .1); });
  const req = request("first", ["A", "B"]); await cache.submit(1, req, "ns");
  const corrected = { ...req, requestId: "corrected", corrections: [{ videoId: req.videos[0].videoId, topicKey: FocusFeedVideo.objectiveKey(topic("A")), match: false }] };
  const response = await cache.submit(1, corrected, "ns");
  assert.deepEqual(calls.at(-1).profile.objectives.map(o => o.text), ["B"]);
  assert.equal(response.data.assessments[0].objectiveMatches.find(m => m.objectiveId === "A").matchProbability, .9);
  const beforeUndo = calls.length; await cache.submit(1, { ...req, requestId: "undo" }, "ns"); assert.equal(calls.length, beforeUndo);
});
test("late responses after clearing cannot repopulate the raw score cache", async () => {
  let finish;
  const cache = FocusFeedScoreCache.create((_id, req) => new Promise(resolve => { finish = () => resolve(result(req)); }));
  const pending = cache.submit(1, request("old"), "ns");
  const failure = assert.rejects(pending, /cleared/);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  cache.clear(); await failure; finish(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cache.snapshot().cachedPairs, 0);
  assert.equal(cache.snapshot().inFlightPairs, 0);
});
test("a partial batch waits briefly for compatible new cards and dispatches once full", async () => {
  const calls = [], cache = FocusFeedScoreCache.create(async (_id, req) => { calls.push(req); return result(req); }, { fillDelay: 100 });
  function group(id, start, length) {
    const req = request(id);
    req.videos = Array.from({ length }, (_, i) => ({ ...req.videos[0], videoId: "coalesce-" + (start + i) }));
    return req;
  }
  const a = cache.submit(1, group("first-five", 0, 5), "ns");
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls.length, 0);
  const b = cache.submit(2, group("next-fifteen", 5, 15), "ns");
  await Promise.all([a, b]); assert.equal(calls.length, 1); assert.equal(calls[0].videos.length, 20);
});
