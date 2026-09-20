"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedEvalDataset;
delete global.FocusFeedProviderSmokeFixtures;
delete global.FocusFeedWorkflow;
delete global.FocusFeedProviderSmokeCore;
require("../workflow-core.js");
require("../eval/dataset.js");
require("../workflow/provider-smoke-fixtures.js");
require("../workflow/provider-smoke-core.js");

const smoke = global.FocusFeedProviderSmokeFixtures;

assert.equal(smoke.version, "2026-09-20.1");
assert.equal(smoke.datasetVersion, global.FocusFeedEvalDataset.version);
assert.equal(smoke.promptVariant, "few-shot-v4");
assert.equal(smoke.batchSize, 4);
assert.equal(smoke.requestBudget, 3);
assert.equal(smoke.totalCases, 12);
assert.deepEqual(
  smoke.scenarios.map((scenario) => scenario.id),
  ["dev-interview-focus", "dev-product-design", "heldout-finance"]
);
assert.ok(smoke.scenarios.every((scenario) => scenario.split === "development"));
assert.ok(smoke.scenarios.every((scenario) => scenario.cases.length === 4));

const caseIds = smoke.scenarios.flatMap((scenario) => scenario.cases.map((item) => item.video.videoId));
assert.equal(new Set(caseIds).size, 12);
assert.ok(caseIds.includes("eval-finance-loss"), "the critical cautionary-finance regression must remain in the smoke set");

const core = global.FocusFeedProviderSmokeCore;
const interview = smoke.scenarios[0];
const finance = smoke.scenarios.find((scenario) => scenario.id === "heldout-finance");
const exactCase = interview.cases[0];
const lossCase = finance.cases.find((item) => item.video.videoId === "eval-finance-loss");
const negativeCase = interview.cases[1];

const records = [
  core.resolvedRecord(interview, exactCase, {
    assessment: Object.assign({ videoId: exactCase.video.videoId, evidence: [] }, exactCase.expected),
    timing: { queueWaitMs: 10, providerMs: 40, totalMs: 50 },
  }),
  core.resolvedRecord(finance, lossCase, {
    assessment: {
      videoId: lossCase.video.videoId,
      contentPurpose: "commentary",
      goalRelevance: "unrelated",
      unwantedMatch: "no",
      evidenceSufficiency: "sufficient",
      evidence: ["How I Lost Everything Day Trading"],
    },
    timing: { queueWaitMs: 5, providerMs: 50, totalMs: 55 },
  }),
  core.failureRecord(interview, negativeCase, {
    code: "timeout",
    message: "Synthetic timeout",
  }),
];

assert.equal(records[0].exactMatch, true);
assert.equal(records[1].decisionMatch, true, "Balanced policy masks the known finance relevance error");
assert.equal(records[1].focusDecisionMatch, false);
assert.equal(records[1].focusFalseHide, true, "Focus counterfactual must expose the unsafe finance result");

const summary = core.summarize(records, [{ timing: { totalMs: 90 } }], {
  stats: { providerRequests: 2, providerVideos: 3, peakQueueDepth: 3, peakInFlightRequests: 1 },
  timing: {
    queueWaitMs: { count: 2, p50: 5, p95: 10, max: 10 },
    providerMs: { count: 2, p50: 40, p95: 50, max: 50 },
    totalMs: { count: 2, p50: 50, p95: 55, max: 55 },
  },
}, 100, false);

assert.deepEqual(summary, {
  cases: 3,
  resolved: 2,
  failed: 1,
  coverage: 2 / 3,
  exactMatches: 1,
  exactMatchAccuracy: 1 / 3,
  decisionMatches: 2,
  decisionAccuracy: 2 / 3,
  falseHides: 0,
  falseShows: 0,
  focusFalseHides: 1,
  focusFalseShows: 0,
  unresolvedExpectedHide: 1,
  providerRequests: 2,
  providerVideos: 3,
  peakQueueDepth: 3,
  peakInFlightRequests: 1,
  queueTiming: { count: 2, p50: 5, p95: 10, max: 10 },
  providerTiming: { count: 2, p50: 40, p95: 50, max: 50 },
  totalTiming: { count: 2, p50: 50, p95: 55, max: 55 },
  providerReportedTotalMs: 90,
  wallClockMs: 100,
  stopped: false,
});

const gate = core.promotionGate(summary, {
  cases: 3,
  requestBudget: 2,
  batchSize: 3,
  maxInFlight: 1,
});
assert.equal(gate.passed, false);
assert.equal(gate.checks.completed, true);
assert.equal(gate.checks.outputCoverage, false);
assert.equal(gate.checks.providerCallBudget, true);
assert.equal(gate.checks.providerVideoCoverage, true);
assert.equal(gate.checks.queueBound, true);
assert.equal(gate.checks.inFlightBound, true);
assert.equal(gate.checks.selectedDecisionAgreement, false);
assert.equal(gate.checks.selectedFalseHideSafety, true);
assert.equal(gate.checks.focusFalseHideSafety, false);
assert.deepEqual(gate.failedChecks, [
  "outputCoverage",
  "selectedDecisionAgreement",
  "focusFalseHideSafety",
]);

const passingSummary = Object.assign({}, summary, {
  resolved: 3,
  failed: 0,
  coverage: 1,
  exactMatches: 3,
  exactMatchAccuracy: 1,
  decisionMatches: 3,
  decisionAccuracy: 1,
  focusFalseHides: 0,
});
assert.deepEqual(core.promotionGate(passingSummary, {
  cases: 3,
  requestBudget: 2,
  batchSize: 3,
  maxInFlight: 1,
}), {
  passed: true,
  checks: {
    completed: true,
    outputCoverage: true,
    providerCallBudget: true,
    providerVideoCoverage: true,
    queueBound: true,
    inFlightBound: true,
    selectedDecisionAgreement: true,
    selectedFalseHideSafety: true,
    focusFalseHideSafety: true,
  },
  failedChecks: [],
});

console.log("workflow provider smoke fixtures test passed");
