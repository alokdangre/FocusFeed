(function (root) {
  "use strict";

  var FIELDS = ["contentPurpose", "goalRelevance", "unwantedMatch", "evidenceSufficiency"];
  var RELEVANCE_LABELS = ["directly_useful", "supporting", "unrelated", "unclear"];
  var UNWANTED_LABELS = ["yes", "no", "unclear"];
  if (!root.FocusFeedWorkflow) throw new Error("FocusFeedWorkflow must load before evaluation metrics.");
  var policyDecision = root.FocusFeedWorkflow.policyDecision;

  function ratio(numerator, denominator) {
    return denominator ? numerator / denominator : null;
  }

  function isMissingAssessment(record) {
    return record.assessmentStatus === "missing" ||
      (record.actual && record.actual.reason === "The local classifier did not return a usable assessment for this video.");
  }

  function accuracy(records, field) {
    var correct = records.filter(function (record) {
      return !isMissingAssessment(record) && record.actual[field] === record.expected[field];
    }).length;
    return ratio(correct, records.length);
  }

  function isAbstention(assessment) {
    return assessment.evidenceSufficiency === "insufficient" ||
      assessment.goalRelevance === "unclear" ||
      assessment.unwantedMatch === "unclear";
  }

  function percentile(values, percentileValue) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
    return sorted[index];
  }

  function summarizeTiming(calls, wallClockMs) {
    var stageKeys = ["availabilityMs", "sessionCreateMs", "inferenceMs", "parsingMs", "validationMs"];
    var pipelineMs = calls.reduce(function (sum, call) {
      return sum + Number(call.timing.totalMs || 0);
    }, 0);
    var measuredWallMs = typeof wallClockMs === "number" ? wallClockMs : pipelineMs;
    var stages = {};
    stageKeys.forEach(function (key) {
      var total = calls.reduce(function (sum, call) {
        return sum + Number(call.timing[key] || 0);
      }, 0);
      stages[key] = {
        totalMs: total,
        averageMs: calls.length ? Math.round(total / calls.length) : null,
        shareOfWall: ratio(total, measuredWallMs),
      };
    });
    return {
      wallClockMs: measuredWallMs,
      pipelineMs: pipelineMs,
      overheadMs: Math.max(0, measuredWallMs - pipelineMs),
      inferenceShareOfWall: stages.inferenceMs.shareOfWall,
      sessionShareOfWall: stages.sessionCreateMs.shareOfWall,
      stages: stages,
      calls: calls.map(function (call) {
        var totalMs = Number(call.timing.totalMs || 0);
        var sessionMs = Number(call.timing.sessionCreateMs || 0);
        var inferenceMs = Number(call.timing.inferenceMs || 0);
        return {
          scenarioId: call.scenarioId,
          scenarioName: call.scenarioName,
          repeat: call.repeat,
          totalMs: totalMs,
          sessionMs: sessionMs,
          inferenceMs: inferenceMs,
          otherMs: Math.max(0, totalMs - sessionMs - inferenceMs),
        };
      }),
    };
  }

  function summarizeReliability(calls) {
    var totals = calls.reduce(function (summary, call) {
      var diagnostics = call.diagnostics || {};
      summary.requested += Number(diagnostics.requestedAssessmentCount || 0);
      summary.returned += Number(diagnostics.returnedAssessmentCount || 0);
      summary.accepted += Number(diagnostics.acceptedAssessmentCount || 0);
      summary.missing += Number(diagnostics.missingAssessmentCount || 0);
      summary.duplicates += Number(diagnostics.duplicateAssessmentCount || 0);
      summary.unexpected += Number(diagnostics.unexpectedAssessmentCount || 0);
      return summary;
    }, { requested: 0, returned: 0, accepted: 0, missing: 0, duplicates: 0, unexpected: 0 });
    totals.coverage = ratio(totals.accepted, totals.requested);
    return totals;
  }

  function confusion(records, field, labels) {
    var matrix = {};
    labels.forEach(function (expected) {
      matrix[expected] = {};
      labels.forEach(function (actual) { matrix[expected][actual] = 0; });
    });
    records.forEach(function (record) {
      var expected = record.expected[field];
      var actual = record.actual[field];
      if (!matrix[expected]) matrix[expected] = {};
      matrix[expected][actual] = (matrix[expected][actual] || 0) + 1;
    });
    return { labels: labels, values: matrix };
  }

  function unwantedPrf(records) {
    var truePositive = 0;
    var falsePositive = 0;
    var falseNegative = 0;
    records.forEach(function (record) {
      var expectedPositive = record.expected.unwantedMatch === "yes";
      var actualPositive = record.actual.unwantedMatch === "yes";
      if (expectedPositive && actualPositive) truePositive += 1;
      if (!expectedPositive && actualPositive) falsePositive += 1;
      if (expectedPositive && !actualPositive) falseNegative += 1;
    });
    var precision = ratio(truePositive, truePositive + falsePositive);
    var recall = ratio(truePositive, truePositive + falseNegative);
    var f1 = precision !== null && recall !== null && precision + recall
      ? (2 * precision * recall) / (precision + recall)
      : null;
    return {
      truePositive: truePositive,
      falsePositive: falsePositive,
      falseNegative: falseNegative,
      precision: precision,
      recall: recall,
      f1: f1,
    };
  }

  function consistency(records, repeats) {
    if (repeats < 2) return null;
    var grouped = {};
    records.forEach(function (record) {
      var key = record.scenarioId + ":" + record.caseId;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(FIELDS.map(function (field) { return record.actual[field]; }).join("|"));
    });
    var keys = Object.keys(grouped);
    var stable = keys.filter(function (key) {
      var groupedRecords = records.filter(function (record) {
        return record.scenarioId + ":" + record.caseId === key;
      });
      return grouped[key].length === repeats &&
        groupedRecords.every(function (record) { return !isMissingAssessment(record); }) &&
        new Set(grouped[key]).size === 1;
    }).length;
    return ratio(stable, keys.length);
  }

  function evaluate(records, latencies, repeats) {
    var exactMatches = records.filter(function (record) {
      return !isMissingAssessment(record) && FIELDS.every(function (field) {
        return record.actual[field] === record.expected[field];
      });
    }).length;

    var falseHide = 0;
    var falseShow = 0;
    var expectedShow = 0;
    var expectedHide = 0;
    var expectedAbstentions = 0;
    var correctAbstentions = 0;
    var unnecessaryAbstentions = 0;
    var expectedDecisive = 0;

    records.forEach(function (record) {
      var expectedDecision = policyDecision(record.expected, record.mode);
      var actualDecision = policyDecision(record.actual, record.mode);
      record.expectedDecision = expectedDecision;
      record.actualDecision = actualDecision;
      if (expectedDecision === "show") {
        expectedShow += 1;
        if (actualDecision === "hide") falseHide += 1;
      } else {
        expectedHide += 1;
        if (actualDecision === "show") falseShow += 1;
      }

      if (isAbstention(record.expected)) {
        expectedAbstentions += 1;
        if (!isMissingAssessment(record) && isAbstention(record.actual)) correctAbstentions += 1;
      } else {
        expectedDecisive += 1;
        if (!isMissingAssessment(record) && isAbstention(record.actual)) unnecessaryAbstentions += 1;
      }
    });

    return {
      predictions: records.length,
      uniqueCases: new Set(records.map(function (record) { return record.scenarioId + ":" + record.caseId; })).size,
      exactMatchAccuracy: ratio(exactMatches, records.length),
      purposeAccuracy: accuracy(records, "contentPurpose"),
      relevanceAccuracy: accuracy(records, "goalRelevance"),
      unwantedAccuracy: accuracy(records, "unwantedMatch"),
      evidenceAccuracy: accuracy(records, "evidenceSufficiency"),
      unwanted: unwantedPrf(records),
      decisionAccuracy: ratio(records.length - falseHide - falseShow, records.length),
      falseHideRate: ratio(falseHide, expectedShow),
      falseShowRate: ratio(falseShow, expectedHide),
      falseHideCount: falseHide,
      falseShowCount: falseShow,
      abstentionRecall: ratio(correctAbstentions, expectedAbstentions),
      unnecessaryAbstentionRate: ratio(unnecessaryAbstentions, expectedDecisive),
      consistencyRate: consistency(records, repeats),
      latency: {
        calls: latencies.length,
        p50Ms: percentile(latencies, 0.50),
        p95Ms: percentile(latencies, 0.95),
        averageMs: latencies.length
          ? Math.round(latencies.reduce(function (sum, value) { return sum + value; }, 0) / latencies.length)
          : null,
      },
      confusion: {
        goalRelevance: confusion(records, "goalRelevance", RELEVANCE_LABELS),
        unwantedMatch: confusion(records, "unwantedMatch", UNWANTED_LABELS),
      },
    };
  }

  root.FocusFeedEvalMetrics = {
    evaluate: evaluate,
    policyDecision: policyDecision,
    isAbstention: isAbstention,
    summarizeTiming: summarizeTiming,
    summarizeReliability: summarizeReliability,
    isMissingAssessment: isMissingAssessment,
  };
})(globalThis);
