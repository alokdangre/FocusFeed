// FocusFeed provider-smoke scoring shared by the page and automated checks.

(function (root) {
  "use strict";

  var FIELDS = ["contentPurpose", "goalRelevance", "unwantedMatch", "evidenceSufficiency"];

  function copy(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function baseRecord(scenario, testCase) {
    var expected = copy(testCase.expected);
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      split: scenario.split,
      mode: scenario.profile.mode,
      profile: copy(scenario.profile),
      caseId: testCase.video.videoId,
      video: copy(testCase.video),
      expected: expected,
      labelNote: testCase.labelNote,
      tags: copy(testCase.tags || []),
      expectedDecision: root.FocusFeedWorkflow.policyDecision(expected, scenario.profile.mode),
      expectedFocusDecision: root.FocusFeedWorkflow.policyDecision(expected, "focus"),
    };
  }

  function resolvedRecord(scenario, testCase, schedulerResult) {
    var record = baseRecord(scenario, testCase);
    var actual = copy(schedulerResult.assessment);
    record.status = "resolved";
    record.actual = actual;
    record.actualDecision = root.FocusFeedWorkflow.policyDecision(actual, scenario.profile.mode);
    record.actualFocusDecision = root.FocusFeedWorkflow.policyDecision(actual, "focus");
    record.exactMatch = FIELDS.every(function (field) { return actual[field] === record.expected[field]; });
    record.decisionMatch = record.actualDecision === record.expectedDecision;
    record.focusDecisionMatch = record.actualFocusDecision === record.expectedFocusDecision;
    record.falseHide = record.expectedDecision === "show" && record.actualDecision === "hide";
    record.falseShow = record.expectedDecision === "hide" && record.actualDecision === "show";
    record.focusFalseHide = record.expectedFocusDecision === "show" && record.actualFocusDecision === "hide";
    record.focusFalseShow = record.expectedFocusDecision === "hide" && record.actualFocusDecision === "show";
    record.schedulerTiming = copy(schedulerResult.timing || null);
    record.failure = null;
    return record;
  }

  function failureRecord(scenario, testCase, failure) {
    var record = baseRecord(scenario, testCase);
    record.status = "failed";
    record.actual = null;
    record.actualDecision = "show";
    record.actualFocusDecision = "show";
    record.exactMatch = false;
    record.decisionMatch = false;
    record.focusDecisionMatch = false;
    record.falseHide = false;
    record.falseShow = false;
    record.focusFalseHide = false;
    record.focusFalseShow = false;
    record.schedulerTiming = null;
    record.failure = {
      code: failure && failure.code || "provider_error",
      message: failure && failure.message || "Classification failed.",
    };
    return record;
  }

  function ratio(numerator, denominator) {
    return denominator ? numerator / denominator : null;
  }

  function summarize(records, scenarioCalls, schedulerSnapshot, wallClockMs, stopped) {
    var resolved = records.filter(function (record) { return record.status === "resolved"; });
    var failed = records.filter(function (record) { return record.status === "failed"; });
    var stats = schedulerSnapshot && schedulerSnapshot.stats || {};
    var timing = schedulerSnapshot && schedulerSnapshot.timing || {};
    return {
      cases: records.length,
      resolved: resolved.length,
      failed: failed.length,
      coverage: ratio(resolved.length, records.length),
      exactMatches: resolved.filter(function (record) { return record.exactMatch; }).length,
      exactMatchAccuracy: ratio(resolved.filter(function (record) { return record.exactMatch; }).length, records.length),
      decisionMatches: resolved.filter(function (record) { return record.decisionMatch; }).length,
      decisionAccuracy: ratio(resolved.filter(function (record) { return record.decisionMatch; }).length, records.length),
      falseHides: resolved.filter(function (record) { return record.falseHide; }).length,
      falseShows: resolved.filter(function (record) { return record.falseShow; }).length,
      focusFalseHides: resolved.filter(function (record) { return record.focusFalseHide; }).length,
      focusFalseShows: resolved.filter(function (record) { return record.focusFalseShow; }).length,
      unresolvedExpectedHide: failed.filter(function (record) { return record.expectedDecision === "hide"; }).length,
      providerRequests: Number(stats.providerRequests || 0),
      providerVideos: Number(stats.providerVideos || 0),
      peakQueueDepth: Number(stats.peakQueueDepth || 0),
      peakInFlightRequests: Number(stats.peakInFlightRequests || 0),
      queueTiming: copy(timing.queueWaitMs || { count: 0, p50: null, p95: null, max: null }),
      providerTiming: copy(timing.providerMs || { count: 0, p50: null, p95: null, max: null }),
      totalTiming: copy(timing.totalMs || { count: 0, p50: null, p95: null, max: null }),
      providerReportedTotalMs: (scenarioCalls || []).reduce(function (total, call) {
        var value = call && call.timing && call.timing.totalMs;
        return total + (Number.isFinite(value) ? value : 0);
      }, 0),
      wallClockMs: wallClockMs,
      stopped: Boolean(stopped),
    };
  }

  function promotionGate(summary, configuration) {
    configuration = configuration || {};
    var cases = Number(configuration.cases || summary.cases || 0);
    var checks = {
      completed: !summary.stopped,
      outputCoverage: summary.resolved === cases && summary.failed === 0,
      providerCallBudget: summary.providerRequests === Number(configuration.requestBudget || 0),
      providerVideoCoverage: summary.providerVideos === cases,
      queueBound: summary.peakQueueDepth <= Number(configuration.batchSize || 0),
      inFlightBound: summary.peakInFlightRequests <= Number(configuration.maxInFlight || 0),
      selectedDecisionAgreement: summary.decisionMatches === cases,
      selectedFalseHideSafety: summary.falseHides === 0,
      focusFalseHideSafety: summary.focusFalseHides === 0,
    };
    var failedChecks = Object.keys(checks).filter(function (key) { return !checks[key]; });
    return {
      passed: failedChecks.length === 0,
      checks: checks,
      failedChecks: failedChecks,
    };
  }

  root.FocusFeedProviderSmokeCore = {
    fields: FIELDS.slice(),
    resolvedRecord: resolvedRecord,
    failureRecord: failureRecord,
    summarize: summarize,
    promotionGate: promotionGate,
  };
})(globalThis);
