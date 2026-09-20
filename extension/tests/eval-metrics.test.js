"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedEvalMetrics;
require("../eval/metrics.js");

const metricsApi = global.FocusFeedEvalMetrics;

function assessment(contentPurpose, goalRelevance, unwantedMatch, evidenceSufficiency) {
  return { contentPurpose, goalRelevance, unwantedMatch, evidenceSufficiency };
}

function record(caseId, mode, expected, actual) {
  return { scenarioId: "scenario", caseId, mode, expected, actual };
}

const records = [
  record("a", "focus", assessment("tutorial", "directly_useful", "no", "sufficient"), assessment("tutorial", "directly_useful", "no", "sufficient")),
  record("b", "focus", assessment("entertainment", "unrelated", "yes", "sufficient"), assessment("entertainment", "unrelated", "yes", "sufficient")),
  record("c", "balanced", assessment("news", "supporting", "no", "sufficient"), assessment("news", "supporting", "yes", "sufficient")),
  record("d", "focus", assessment("commentary", "unrelated", "no", "sufficient"), assessment("commentary", "supporting", "no", "sufficient")),
  record("e", "focus", assessment("unclear", "unclear", "unclear", "insufficient"), assessment("unclear", "unclear", "unclear", "insufficient")),
];

const metrics = metricsApi.evaluate(records, [100, 200, 500], 1);
assert.equal(metrics.predictions, 5);
assert.equal(metrics.uniqueCases, 5);
assert.equal(metrics.exactMatchAccuracy, 3 / 5);
assert.equal(metrics.purposeAccuracy, 1);
assert.equal(metrics.relevanceAccuracy, 4 / 5);
assert.equal(metrics.unwantedAccuracy, 4 / 5);
assert.equal(metrics.evidenceAccuracy, 1);
assert.equal(metrics.unwanted.precision, 1 / 2);
assert.equal(metrics.unwanted.recall, 1);
assert.equal(metrics.unwanted.f1, 2 / 3);
assert.equal(metrics.decisionAccuracy, 3 / 5);
assert.equal(metrics.falseHideRate, 1 / 3);
assert.equal(metrics.falseShowRate, 1 / 2);
assert.equal(metrics.falseHideCount, 1);
assert.equal(metrics.falseShowCount, 1);
assert.equal(metrics.abstentionRecall, 1);
assert.equal(metrics.unnecessaryAbstentionRate, 0);
assert.equal(metrics.consistencyRate, null);
assert.deepEqual(metrics.latency, { calls: 3, p50Ms: 200, p95Ms: 500, averageMs: 267 });
assert.equal(metrics.confusion.goalRelevance.values.unrelated.supporting, 1);
assert.equal(metrics.confusion.unwantedMatch.values.no.yes, 1);
assert.equal(records[2].expectedDecision, "show");
assert.equal(records[2].actualDecision, "hide");
assert.equal(records[3].expectedDecision, "hide");
assert.equal(records[3].actualDecision, "show");

assert.equal(metricsApi.policyDecision(assessment("entertainment", "unrelated", "yes", "insufficient"), "focus"), "show");
assert.equal(metricsApi.policyDecision(assessment("other", "unrelated", "no", "sufficient"), "focus"), "hide");
assert.equal(metricsApi.policyDecision(assessment("other", "unrelated", "no", "sufficient"), "balanced"), "show");

const repeated = [];
for (let repeat = 1; repeat <= 3; repeat += 1) {
  repeated.push(record("stable", "focus", records[0].expected, records[0].actual));
  repeated.push(record("variable", "focus", records[0].expected,
    repeat === 3
      ? assessment("tutorial", "supporting", "no", "sufficient")
      : records[0].actual));
}
assert.equal(metricsApi.evaluate(repeated, [], 3).consistencyRate, 1 / 2);

const missingFallback = assessment("unclear", "unclear", "unclear", "insufficient");
missingFallback.reason = "The local classifier did not return a usable assessment for this video.";
const missingRecords = [
  Object.assign(
    record("missing-abstention", "focus", assessment("unclear", "unclear", "unclear", "insufficient"), missingFallback),
    { assessmentStatus: "missing" }
  ),
];
const missingMetrics = metricsApi.evaluate(missingRecords, [], 1);
assert.equal(metricsApi.isMissingAssessment(missingRecords[0]), true);
assert.equal(missingMetrics.exactMatchAccuracy, 0);
assert.equal(missingMetrics.purposeAccuracy, 0);
assert.equal(missingMetrics.relevanceAccuracy, 0);
assert.equal(missingMetrics.unwantedAccuracy, 0);
assert.equal(missingMetrics.evidenceAccuracy, 0);
assert.equal(missingMetrics.abstentionRecall, 0);

const repeatedWithMissing = [
  Object.assign(record("missing-stable", "focus", records[0].expected, missingFallback), { assessmentStatus: "missing" }),
  Object.assign(record("missing-stable", "focus", records[0].expected, missingFallback), { assessmentStatus: "missing" }),
  Object.assign(record("missing-stable", "focus", records[0].expected, missingFallback), { assessmentStatus: "missing" }),
];
assert.equal(metricsApi.evaluate(repeatedWithMissing, [], 3).consistencyRate, 0);

const timing = metricsApi.summarizeTiming([
  {
    scenarioId: "one",
    scenarioName: "One",
    repeat: 1,
    timing: { totalMs: 1000, availabilityMs: 10, sessionCreateMs: 190, inferenceMs: 790, parsingMs: 5, validationMs: 5 },
  },
  {
    scenarioId: "two",
    scenarioName: "Two",
    repeat: 1,
    timing: { totalMs: 2000, availabilityMs: 10, sessionCreateMs: 390, inferenceMs: 1580, parsingMs: 10, validationMs: 10 },
  },
], 3100);
assert.equal(timing.wallClockMs, 3100);
assert.equal(timing.pipelineMs, 3000);
assert.equal(timing.overheadMs, 100);
assert.equal(timing.stages.inferenceMs.totalMs, 2370);
assert.equal(timing.stages.sessionCreateMs.averageMs, 290);
assert.equal(timing.inferenceShareOfWall, 2370 / 3100);
assert.deepEqual(timing.calls[0], {
  scenarioId: "one",
  scenarioName: "One",
  repeat: 1,
  totalMs: 1000,
  sessionMs: 190,
  inferenceMs: 790,
  otherMs: 20,
});

const reliability = metricsApi.summarizeReliability([
  { diagnostics: { requestedAssessmentCount: 4, returnedAssessmentCount: 1, acceptedAssessmentCount: 1, missingAssessmentCount: 3, duplicateAssessmentCount: 0, unexpectedAssessmentCount: 0 } },
  { diagnostics: { requestedAssessmentCount: 4, returnedAssessmentCount: 5, acceptedAssessmentCount: 4, missingAssessmentCount: 0, duplicateAssessmentCount: 1, unexpectedAssessmentCount: 0 } },
]);
assert.deepEqual(reliability, {
  requested: 8,
  returned: 6,
  accepted: 5,
  missing: 3,
  duplicates: 1,
  unexpected: 0,
  coverage: 5 / 8,
});

console.log("evaluation metrics test passed");
