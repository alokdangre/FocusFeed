"use strict";
const assert = require("node:assert/strict");
require("../workflow-core.js");
require("../workflow-scheduler.js");
require("../workflow-cache.js");
require("../live/engine.js");
require("../live/provider.js");
const W = global.FocusFeedWorkflow;
const E = global.FocusFeedLiveEngine;
const profile = { id: "test", version: 1, goal: "Learn algorithms", usefulTopics: ["algorithms"], unwantedTopics: ["gaming"], exceptions: [], languages: ["English"], mode: "focus" };
const classifier = { provider: "chrome-built-in-ai", model: "test", promptVersion: "v1" };
const video = (id, title = "Algorithms lesson") => ({ videoId: id, title, channel: "Lessons" });
const assessment = id => ({ videoId: id, topics: ["algorithms"], contentPurpose: "tutorial", goalRelevance: "directly_useful", unwantedMatch: "no", evidenceSufficiency: "sufficient", evidence: ["Algorithms"], reason: "Useful lesson." });
const response = request => ({ classifier, assessments: request.videos.map(v => assessment(v.videoId)) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0;i<200;i++) { if (fn()) return; await sleep(10); } assert.fail("Timed out waiting for engine"); }
const make = overrides => E.create(Object.assign({ runId: "live-test", profile, preferences: {}, classifier, provider: async request => response(request) }, overrides));
async function main() {
  const data = {};
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async values => Object.assign(data, structuredClone(values)), remove: async key => delete data[key] };
  const cache = global.FocusFeedAssessmentCache.create(storage, { storageKey: "live-test-cache" });
  const seed = make({ cache }); seed.offer(video("cached"));
  await until(() => seed.report().counts.model === 1);
  await until(() => Object.keys(data["live-test-cache"] || {}).length === 1);
  seed.stop();
  let requests = [];
  const engine = make({ cache, cacheEntries: await cache.getAll(), preferences: { blockedKeywords: ["gaming"] }, provider: async request => { requests.push(request); return response(request); } });
  engine.offer(video("rule", "Gaming highlights"));
  engine.offer(video("cached"));
  for (let i=0;i<10;i++) engine.offer(video("new-"+i));
  assert.equal(engine.offer(video("overflow")).status, "deferred");
  for (let i=0;i<100;i++) engine.offer(video("new-0"));
  await until(() => engine.report().counts.model === 10);
  const report = engine.report();
  assert.equal(report.counts.rule, 1); assert.equal(report.counts.cache, 1);
  assert.equal(report.records.find(r => r.video.videoId === "rule").action, "hide");
  assert.deepEqual(requests.map(r => r.videos.length), [4,4,2]);
  assert.equal(report.budget.calls,3); assert.equal(report.budget.modelVideos,10);
  assert.equal(requests.flatMap(r => r.videos).some(v => v.videoId === "cached" || v.videoId === "rule"),false);
  assert.equal(engine.offer(video("overflow")).status,"deferred", "hiding and completions must not replenish allowance");
  assert.equal(engine.loadMore(), true); engine.offer(video("overflow"));
  await until(() => engine.report().counts.model === 11);
  assert.equal(engine.report().budget.calls,4); engine.stop();
  assert.equal(data.focusFeedAssessmentCacheV2, undefined, "live records must never use replay storage");

  // Exact metadata, not case-folded cache equivalence, controls reuse.
  const changed = make({ cacheEntries: await cache.getAll() }); changed.offer(video("cached", "ALGORITHMS lesson"));
  assert.equal(changed.report().counts.cache || 0,0); changed.stop();

  let failedCalls=0;
  const fail = make({ provider: async () => { failedCalls++; throw new Error("synthetic provider outage"); } });
  fail.offer(video("failure")); await until(() => fail.report().counts.unresolved === 1);
  for(let i=0;i<30;i++) fail.offer(video("failure"));
  await sleep(170); assert.equal(failedCalls,1, "failure must not automatically retry"); fail.stop();

  const calls = [];
  const exhausted = make({ provider: async r => { calls.push(r); return response(r); } });
  for(let i=0;i<3;i++) { exhausted.offer(video("changing", "Title " + i)); await until(() => exhausted.report().counts.model === 1); }
  exhausted.offer(video("changing", "Title fourth")); await sleep(170);
  assert.equal(calls.length,3, "metadata churn cannot bypass the paid-call budget");
  assert.equal(exhausted.report().counts.deferred,1); exhausted.stop();

  let release, signal;
  const stale = make({ provider: (request, s) => { signal=s; return new Promise(resolve => { release=()=>resolve(response(request)); }); } });
  stale.offer(video("late")); await until(() => release);
  stale.stop(); assert.equal(signal.aborted,true); release(); await sleep(20);
  assert.equal(stale.report().counts.model || 0,0); assert.equal(stale.report().records[0].status,"canceled");

  const partial = make({ provider: async request => ({ assessments: request.videos.map(v=>assessment(v.videoId)), diagnostics: { missingVideoIds:[request.videos[0].videoId] } }) });
  partial.offer(video("missing")); await until(()=>partial.report().counts.unresolved===1);
  assert.equal(partial.report().records[0].failure,"missing_assessment"); partial.stop();

  const request={requestId:"test-request",profile,videos:[E.videoInput(video("one"))]};
  const validate = batch => global.FocusFeedLiveProvider.validateRaw({ diagnostics:{rawOutput:JSON.stringify(batch)} },request);
  assert.doesNotThrow(()=>validate({assessments:[assessment("one")]}));
  assert.throws(()=>validate({assessments:[assessment("one"),assessment("one")]}),/Duplicate/);
  assert.throws(()=>validate({assessments:[{...assessment("one"),goalRelevance:"bogus"}]}),/invalid/);
  assert.equal(global.FocusFeedLiveProvider.cloudRequest(request).videos[0].description,undefined);
  assert.equal(global.FocusFeedLiveProvider.cloudRequest(request).videos[0].descriptionSnippet,"");
  console.log("live workflow integration passed: fast paths, budgets, persistence, failure, cancellation, raw validation");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
