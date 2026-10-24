"use strict";
const assert = require("node:assert/strict");
require("../workflow-core.js");
require("../channel-policy.js");
require("../workflow-scheduler.js");
require("../live/engine.js");
require("../live/provider.js");

const E = global.FocusFeedLiveEngine;
const profile = {
  id: "test",
  version: 1,
  mode: "focus",
  objectives: [{
    id: "topic.education",
    text: "Education & Careers",
    contentType: "topic",
    taxonomyId: "topic.education",
    taxonomyVersion: "focusfeed-topics-v1",
    sourceText: "algorithms tutorials",
  }],
};
const classifier = {
  provider: "typesafe-jev",
  model: "jev-1.13.0",
  promptVersion: "video-v1",
  assessmentSchemaVersion: "taxonomy-match-v2",
};
const video = (id, title = "Algorithms lesson") => ({
  videoId: id,
  title,
  channel: "Lessons",
  channelId: "@lessons",
});
const assessment = (id, probability = 0.95) => ({
  videoId: id,
  objectiveMatches: [{
    objectiveId: "topic.education",
    text: "Education & Careers",
    contentType: "topic",
    matchProbability: probability,
  }],
  evidenceProbability: 0.94,
  outcome: probability >= 0.6 ? "match" : probability <= 0.2 ? "no_match" : "uncertain",
  evidence: ["Algorithms lesson"],
  reason: "Observable Jev judgment.",
});
const response = request => ({
  classifier,
  assessments: request.videos.map(video => assessment(video.videoId)),
  diagnostics: {
    thresholds: { matchYes: 0.6, matchNo: 0.2, evidence: 0.7 },
    usage: { input_tokens: 120, output_tokens: 32 },
    judgments: { sample: { evidenceProbability: 0.94 } },
  },
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i += 1) {
    if (fn()) return;
    await sleep(10);
  }
  assert.fail("Timed out waiting for engine");
}
const make = overrides => E.create(Object.assign({
  runId: "live-test",
  profile,
  preferences: {},
  classifier,
  provider: async request => response(request),
}, overrides));

async function main() {
  const requests = [];
  const engine = make({
    preferences: { blockedKeywords: ["gaming"] },
    provider: async request => {
      requests.push(request);
      return response(request);
    },
  });
  engine.offer(video("rule", "Gaming highlights"));
  engine.offer(video("cached"));
  for (let i = 0; i < 10; i += 1) engine.offer(video("new-" + i));
  assert.equal(engine.offer(video("overflow")).status, "deferred");
  for (let i = 0; i < 100; i += 1) engine.offer(video("new-0"));
  await until(() => engine.report().counts.model === 12);
  const report = engine.report();
  assert.equal(report.counts.rule || 0, 0);
  assert.equal(report.counts.cache || 0, 0);
  const providerResponse = report.events.find(event => event.type === "provider_response");
  assert.equal(providerResponse.diagnostics.thresholds.matchYes, 0.6);
  assert.equal(providerResponse.diagnostics.usage.input_tokens, 120);
  assert.equal(providerResponse.diagnostics.judgments.sample.evidenceProbability, 0.94);
  assert.equal(report.records.find(record => record.video.videoId === "rule").action, "show");
  assert.equal(report.records.find(record => record.video.videoId === "cached").action, "show");
  assert.deepEqual(requests.map(request => request.videos.length), [4, 4, 4]);
  assert.equal(report.budget.calls, 3);
  assert.equal(report.budget.modelVideos, 12);
  assert.equal(requests.flatMap(request => request.videos)
    .some(item => item.videoId === "cached" || item.videoId === "rule"), true);
  assert.equal(engine.offer(video("overflow")).status, "deferred");
  assert.equal(engine.loadMore(), true);
  engine.offer(video("overflow"));
  await until(() => engine.report().counts.model === 13);
  assert.equal(engine.report().budget.calls, 4);
  engine.stop();

  let blockedProviderCalls = 0;
  const blocked = make({
    channelBlocks: [{
      id: "block-1",
      channelId: "@lessons",
      channelLabel: "Lessons",
      scope: "topics",
      mode: "focus",
      taxonomyIds: ["topic.education"],
    }],
    provider: async request => {
      blockedProviderCalls += 1;
      return response(request);
    },
  });
  const blockedRecord = blocked.offer(video("user-blocked"));
  assert.equal(blockedRecord.route, "channel_block");
  assert.equal(blockedRecord.action, "hide");
  await sleep(180);
  assert.equal(blockedProviderCalls, 0, "confirmed channel blocks bypass Jev");
  blocked.stop();

  let failedCalls = 0;
  const fail = make({
    provider: async () => {
      failedCalls += 1;
      throw new Error("synthetic provider outage");
    },
  });
  fail.offer(video("failure"));
  await until(() => fail.report().counts.unresolved === 1);
  assert.equal(fail.report().records[0].action, "hide", "Focus uncertainty must collapse reversibly");
  for (let i = 0; i < 30; i += 1) fail.offer(video("failure"));
  await sleep(170);
  assert.equal(failedCalls, 1);
  fail.stop();

  const calls = [];
  const exhausted = make({
    provider: async request => {
      calls.push(request);
      return response(request);
    },
  });
  for (let i = 0; i < 3; i += 1) {
    exhausted.offer(video("changing", "Title " + i));
    await until(() => exhausted.report().counts.model === 1);
  }
  exhausted.offer(video("changing", "Title fourth"));
  await sleep(170);
  assert.equal(calls.length, 3);
  assert.equal(exhausted.report().counts.deferred, 1);
  exhausted.stop();

  let release;
  let signal;
  const stale = make({
    provider: (request, providerSignal) => {
      signal = providerSignal;
      return new Promise(resolve => {
        release = () => resolve(response(request));
      });
    },
  });
  stale.offer(video("late"));
  await until(() => release);
  stale.stop();
  assert.equal(signal.aborted, true);
  release();
  await sleep(20);
  assert.equal(stale.report().counts.model || 0, 0);

  const partial = make({
    provider: async request => ({
      assessments: request.videos.map(item => assessment(item.videoId)),
      diagnostics: { missingVideoIds: [request.videos[0].videoId] },
    }),
  });
  partial.offer(video("missing"));
  await until(() => partial.report().counts.unresolved === 1);
  assert.equal(partial.report().records[0].failure, "missing_assessment");
  partial.stop();

  const request = {
    requestId: "test-request",
    profile,
    videos: [E.videoInput(video("one"))],
  };
  const validate = batch => global.FocusFeedLiveProvider.validateRaw({
    diagnostics: { rawOutput: JSON.stringify(batch) },
  }, request);
  assert.doesNotThrow(() => validate({ assessments: [assessment("one")] }));
  assert.throws(
    () => validate({ assessments: [assessment("one"), assessment("one")] }),
    /Duplicate/
  );
  const invalid = assessment("one");
  invalid.objectiveMatches[0].matchProbability = 2;
  assert.throws(() => validate({ assessments: [invalid] }), /invalid/);
  assert.equal(global.FocusFeedLiveProvider.cloudRequest(request).videos[0].description, undefined);
  assert.equal(global.FocusFeedLiveProvider.cloudRequest(request).videos[0].descriptionSnippet, "");
  assert.equal(global.FocusFeedLiveProvider.cloudRequest(request).videos[0].channelId, "@lessons");
  console.log("live workflow passed: Jev-only routing, two-mode policy, budgets, failure, cancellation");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
