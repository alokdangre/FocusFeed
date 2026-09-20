"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedWorkflowScheduler;
delete global.FocusFeedLifecycleFixtures;
require("../workflow-scheduler.js");
require("../workflow/lifecycle-fixtures.js");

const lifecycle = global.FocusFeedLifecycleFixtures;

async function burstBackpressure() {
  const record = await lifecycle.runScenario("burst-backpressure");
  assert.equal(record.pass, true);
  assert.deepEqual(record.actual, {
    appearances: 100,
    queueDepth: 24,
    peakQueueDepth: 24,
    duplicateJoins: 70,
    overloadDeferred: 6,
    priorityEvictions: 1,
    visibleOverflowAdmitted: true,
  });
  assert.equal(record.events.filter((event) => event.type === "deferred").length, 6);
}

async function dedupeAndScrollAway() {
  const record = await lifecycle.runScenario("dedupe-and-scroll-away");
  assert.equal(record.pass, true);
  assert.deepEqual(record.actual, {
    appearances: 7,
    duplicateJoins: 1,
    providerRequests: 2,
    providerVideos: 5,
    duplicateProviderVideos: 0,
    completedItems: 5,
    resultsApplied: 5,
    canceledSubscribers: 2,
    obsoleteApplications: 0,
    peakInFlightRequests: 1,
    queueDepth: 0,
    inFlightRequests: 0,
    queueP95Ms: 60,
    providerP95Ms: 40,
    totalP95Ms: 80,
  });
}

async function goalChangeRejectsLateWork() {
  const record = await lifecycle.runScenario("goal-change-stale-result");
  assert.equal(record.pass, true);
  assert.deepEqual(record.actual, {
    oldRequestAborted: true,
    staleResultsIgnored: 1,
    oldContextApplications: 0,
    currentContextApplications: 1,
    canceledSubscribers: 1,
    providerRequests: 2,
    providerVideos: 2,
    queueDepth: 0,
    inFlightRequests: 0,
  });
}

async function pauseAndResumePreservesCurrentWork() {
  const record = await lifecycle.runScenario("pause-resume");
  assert.equal(record.pass, true);
  assert.deepEqual(record.actual, {
    pausedRequestAborted: true,
    queueDepthWhilePaused: 3,
    providerRequestsWhilePaused: 1,
    pauseCount: 1,
    resumeCount: 1,
    staleResultsIgnored: 1,
    providerRequests: 3,
    providerVideos: 5,
    completedItems: 3,
    resultsApplied: 3,
    queueDepth: 0,
    inFlightRequests: 0,
  });
}

async function failuresRemainVisibleAndBounded() {
  const record = await lifecycle.runScenario("timeout-error-validation");
  assert.equal(record.pass, true);
  assert.deepEqual(record.actual, {
    failureCodes: ["missing_assessment", "provider_error", "timeout"],
    providerRequests: 3,
    providerVideos: 3,
    failedItems: 3,
    timedOutItems: 1,
    validationFailedItems: 1,
    completedItems: 0,
    resultsApplied: 0,
    retries: 0,
    visibleFallbacks: 3,
    queueDepth: 0,
    inFlightRequests: 0,
  });
}

async function exportsCompleteLifecycleReport() {
  const report = await lifecycle.runAll();
  assert.equal(report.schemaVersion, "focusfeed-lifecycle-report-v1");
  assert.equal(report.fixtureVersion, lifecycle.version);
  assert.equal(report.schedulerVersion, global.FocusFeedWorkflowScheduler.SCHEDULER_VERSION);
  assert.deepEqual(report.summary, {
    scenarios: 5,
    passed: 5,
    failed: 0,
    maxQueueDepth: 24,
    maxInFlightRequests: 1,
    duplicateProviderVideos: 0,
    staleApplications: 0,
    unresolvedFailures: 3,
  });
  assert.deepEqual(report.records.map((record) => record.id), lifecycle.scenarios.map((scenario) => scenario.id));
}

burstBackpressure()
  .then(dedupeAndScrollAway)
  .then(goalChangeRejectsLateWork)
  .then(pauseAndResumePreservesCurrentWork)
  .then(failuresRemainVisibleAndBounded)
  .then(exportsCompleteLifecycleReport)
  .then(() => {
  console.log("workflow lifecycle tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
