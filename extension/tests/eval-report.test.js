"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

delete global.FocusFeedEvalMetrics;
require("../eval/metrics.js");

const reportPath = path.resolve(__dirname, "../../eval_reports/focusfeed-evaluation-1789893371682.json");
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const records = structuredClone(report.records);
const latencies = report.scenarioCalls.map((call) => call.timing.totalMs);
const recomputed = global.FocusFeedEvalMetrics.evaluate(records, latencies, report.repeats);

assert.equal(recomputed.predictions, 16);
assert.equal(recomputed.exactMatchAccuracy, 0.75);
assert.equal(recomputed.unwanted.f1, 1);
assert.equal(recomputed.decisionAccuracy, 15 / 16);
assert.equal(recomputed.falseHideRate, 1 / 12);
assert.equal(recomputed.falseHideCount, 1);
assert.equal(recomputed.falseShowCount, 0);
assert.equal(recomputed.abstentionRecall, 1);
assert.deepEqual(recomputed.confusion, report.metrics.confusion);

const wallClockMs = Date.parse(report.completedAt) - Date.parse(report.startedAt);
const timing = global.FocusFeedEvalMetrics.summarizeTiming(report.scenarioCalls, wallClockMs);
assert.equal(timing.wallClockMs, 274135);
assert.equal(timing.pipelineMs, 274122);
assert.equal(timing.stages.inferenceMs.totalMs, 254076);
assert.equal(timing.stages.sessionCreateMs.totalMs, 20023);
assert.equal(timing.inferenceShareOfWall, 254076 / 274135);

const baselineReliability = global.FocusFeedEvalMetrics.summarizeReliability(report.scenarioCalls);
assert.equal(baselineReliability.coverage, 1);
assert.equal(baselineReliability.missing, 0);

const rejectedPath = path.resolve(__dirname, "../../eval_reports/focusfeed-evaluation-1789894516881.json");
const rejected = JSON.parse(fs.readFileSync(rejectedPath, "utf8"));
const rejectedReliability = global.FocusFeedEvalMetrics.summarizeReliability(rejected.scenarioCalls);
assert.equal(rejected.classifier.promptVersion, "local-2026-09-20.1");
assert.equal(rejectedReliability.requested, 16);
assert.equal(rejectedReliability.accepted, 4);
assert.equal(rejectedReliability.missing, 12);
assert.equal(rejectedReliability.coverage, 0.25);
// This stored metric came from the previous scorer, which accidentally let a
// missing-output fallback match an expected abstention case.
assert.equal(rejected.metrics.exactMatchAccuracy, 1 / 16);
assert.equal(rejected.metrics.falseShowRate, 1);

const rejectedRecords = structuredClone(rejected.records);
const rejectedLatencies = rejected.scenarioCalls.map((call) => call.timing.totalMs);
const correctedRejected = global.FocusFeedEvalMetrics.evaluate(
  rejectedRecords,
  rejectedLatencies,
  rejected.repeats
);
assert.equal(correctedRejected.exactMatchAccuracy, 0);
assert.equal(correctedRejected.abstentionRecall, 0);
assert.equal(rejectedRecords.filter(global.FocusFeedEvalMetrics.isMissingAssessment).length, 12);

const v3Path = path.resolve(__dirname, "../../eval_reports/focusfeed-evaluation-1789897231586.json");
const v3 = JSON.parse(fs.readFileSync(v3Path, "utf8"));
const v3Records = structuredClone(v3.records);
const v3Latencies = v3.scenarioCalls.map((call) => call.timing.totalMs);
const v3Metrics = global.FocusFeedEvalMetrics.evaluate(v3Records, v3Latencies, v3.repeats);
const v3Reliability = global.FocusFeedEvalMetrics.summarizeReliability(v3.scenarioCalls);
const v3WallClockMs = Date.parse(v3.completedAt) - Date.parse(v3.startedAt);
const v3Timing = global.FocusFeedEvalMetrics.summarizeTiming(v3.scenarioCalls, v3WallClockMs);

assert.equal(v3.classifier.promptVersion, "local-2026-09-20.2");
assert.equal(v3.evaluator.version, "eval-2026-09-20.2");
assert.equal(v3.testSet.length, 4);
assert.equal(v3Metrics.predictions, 16);
assert.equal(v3Metrics.exactMatchAccuracy, 15 / 16);
assert.equal(v3Metrics.purposeAccuracy, 1);
assert.equal(v3Metrics.relevanceAccuracy, 15 / 16);
assert.equal(v3Metrics.unwanted.f1, 1);
assert.equal(v3Metrics.decisionAccuracy, 1);
assert.equal(v3Metrics.falseHideCount, 0);
assert.equal(v3Metrics.falseShowCount, 0);
assert.equal(v3Reliability.coverage, 1);
assert.equal(v3Reliability.missing, 0);
assert.equal(v3Timing.wallClockMs, 197003);
assert.equal(v3Timing.stages.inferenceMs.totalMs, 159887);
assert.deepEqual(
  v3Records.filter((record) => ["contentPurpose", "goalRelevance", "unwantedMatch", "evidenceSufficiency"]
    .some((field) => record.expected[field] !== record.actual[field]))
    .map((record) => record.caseId),
  ["eval-design-figma"]
);

const heldoutPath = path.resolve(__dirname, "../../eval_reports/focusfeed-evaluation-1789897743605.json");
const heldout = JSON.parse(fs.readFileSync(heldoutPath, "utf8"));
const heldoutRecords = structuredClone(heldout.records);
const heldoutLatencies = heldout.scenarioCalls.map((call) => call.timing.totalMs);
const heldoutMetrics = global.FocusFeedEvalMetrics.evaluate(
  heldoutRecords,
  heldoutLatencies,
  heldout.repeats
);
const heldoutReliability = global.FocusFeedEvalMetrics.summarizeReliability(heldout.scenarioCalls);

assert.equal(heldout.split, "heldout");
assert.equal(heldout.classifier.promptVersion, "local-2026-09-20.2");
assert.equal(heldoutMetrics.predictions, 8);
assert.equal(heldoutMetrics.exactMatchAccuracy, 3 / 8);
assert.equal(heldoutMetrics.decisionAccuracy, 7 / 8);
assert.equal(heldoutMetrics.falseHideCount, 1);
assert.equal(heldoutMetrics.falseShowCount, 0);
assert.equal(heldoutMetrics.unwanted.f1, 0.8);
assert.equal(heldoutReliability.coverage, 1);
assert.deepEqual(
  heldoutRecords.filter((record) => record.expectedDecision !== record.actualDecision)
    .map((record) => record.caseId),
  ["eval-finance-loss"]
);

const v4Path = path.resolve(__dirname, "../../eval_reports/focusfeed-evaluation-1789898627686.json");
const v4 = JSON.parse(fs.readFileSync(v4Path, "utf8"));
const v4Records = structuredClone(v4.records);
const v4Metrics = global.FocusFeedEvalMetrics.evaluate(
  v4Records, v4.scenarioCalls.map((call) => call.timing.totalMs), v4.repeats
);
assert.deepEqual(v4Metrics, v4.metrics, "v4 exported metrics must reproduce from case records");
assert.equal(v4Metrics.exactMatchAccuracy, 20 / 24);
assert.equal(v4Metrics.decisionAccuracy, 1);
assert.equal(global.FocusFeedEvalMetrics.summarizeReliability(v4.scenarioCalls).coverage, 1);

// Audit against the saved scenario snapshot, not today's potentially revised dataset.
for (const scenario of v4.testSet) {
  const scenarioRecords = v4Records.filter((record) => record.scenarioId === scenario.id);
  assert.equal(scenarioRecords.length, scenario.cases.length);
  for (const testCase of scenario.cases) {
    const matches = scenarioRecords.filter((record) => record.caseId === testCase.video.videoId);
    assert.equal(matches.length, 1, "each snapshot case must appear exactly once in this single-repeat report");
    assert.deepEqual(matches[0].video, testCase.video);
    assert.deepEqual(matches[0].expected, testCase.expected);
    assert.equal(matches[0].mode, scenario.profile.mode);
    assert.equal(matches[0].assessmentStatus, "returned");
  }
}

// Perfect recorded decisions are not proof of correct relevance under another mode.
const lossStory = v4Records.find((record) => record.caseId === "eval-finance-loss");
assert.equal(global.FocusFeedEvalMetrics.policyDecision(lossStory.expected, "balanced"), "show");
assert.equal(global.FocusFeedEvalMetrics.policyDecision(lossStory.actual, "balanced"), "show");
assert.equal(global.FocusFeedEvalMetrics.policyDecision(lossStory.expected, "focus"), "show");
assert.equal(global.FocusFeedEvalMetrics.policyDecision(lossStory.actual, "focus"), "hide");

console.log("exported evaluation reports verified");
