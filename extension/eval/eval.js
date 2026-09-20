(function () {
  "use strict";

  var dataset = globalThis.FocusFeedEvalDataset;
  var requestBuilder = globalThis.FocusFeedEvalRequest;
  var metricsApi = globalThis.FocusFeedEvalMetrics;
  var classifier = globalThis.FocusFeedLocalClassifier;
  var LABEL_FIELDS = ["contentPurpose", "goalRelevance", "unwantedMatch", "evidenceSufficiency"];
  var HISTORY_KEY = "classifierEvalRuns";
  var EVALUATOR_VERSION = "eval-2026-09-20.2";
  var currentReport = null;
  var activeController = null;
  var modelReady = false;
  var history = [];

  var elements = {
    modelState: document.getElementById("modelState"),
    runEvaluation: document.getElementById("runEvaluation"),
    stopEvaluation: document.getElementById("stopEvaluation"),
    datasetVersion: document.getElementById("datasetVersion"),
    iterationStatus: document.getElementById("iterationStatus"),
    iterationTitle: document.getElementById("iterationTitle"),
    iterationSummary: document.getElementById("iterationSummary"),
    iterationChanges: document.getElementById("iterationChanges"),
    iterationFinding: document.getElementById("iterationFinding"),
    testSetSummary: document.getElementById("testSetSummary"),
    testSetVersion: document.getElementById("testSetVersion"),
    testSetScenarios: document.getElementById("testSetScenarios"),
    promptVariant: document.getElementById("promptVariant"),
    evaluationSplit: document.getElementById("evaluationSplit"),
    repeatCount: document.getElementById("repeatCount"),
    runStatus: document.getElementById("runStatus"),
    runProgressText: document.getElementById("runProgressText"),
    progressTrack: document.getElementById("progressTrack"),
    progressBar: document.getElementById("progressBar"),
    stageDetail: document.getElementById("stageDetail"),
    exactMetric: document.getElementById("exactMetric"),
    decisionMetric: document.getElementById("decisionMetric"),
    relevanceMetric: document.getElementById("relevanceMetric"),
    unwantedMetric: document.getElementById("unwantedMetric"),
    falseHideMetric: document.getElementById("falseHideMetric"),
    falseHideDetail: document.getElementById("falseHideDetail"),
    falseShowMetric: document.getElementById("falseShowMetric"),
    falseShowDetail: document.getElementById("falseShowDetail"),
    abstentionMetric: document.getElementById("abstentionMetric"),
    latencyMetric: document.getElementById("latencyMetric"),
    latencyDetail: document.getElementById("latencyDetail"),
    consistencyMetric: document.getElementById("consistencyMetric"),
    wallTimeMetric: document.getElementById("wallTimeMetric"),
    inferenceShareMetric: document.getElementById("inferenceShareMetric"),
    coverageMetric: document.getElementById("coverageMetric"),
    coverageDetail: document.getElementById("coverageDetail"),
    timingSummary: document.getElementById("timingSummary"),
    timingRows: document.getElementById("timingRows"),
    comparisonContent: document.getElementById("comparisonContent"),
    relevanceMatrix: document.getElementById("relevanceMatrix"),
    unwantedMatrix: document.getElementById("unwantedMatrix"),
    resultFilter: document.getElementById("resultFilter"),
    caseSummary: document.getElementById("caseSummary"),
    caseRows: document.getElementById("caseRows"),
    reportOutput: document.getElementById("reportOutput"),
    copyReport: document.getElementById("copyReport"),
    exportReport: document.getElementById("exportReport"),
    clearHistory: document.getElementById("clearHistory"),
    historySummary: document.getElementById("historySummary"),
    historyList: document.getElementById("historyList"),
  };

  function selectedScenarios() {
    var split = elements.evaluationSplit.value;
    return dataset.scenarios.filter(function (scenario) {
      return split === "all" || scenario.split === split;
    });
  }

  function selectedRepeats() {
    return Number(elements.repeatCount.value) === 3 ? 3 : 1;
  }

  function scenarioCaseCount(scenarios) {
    return scenarios.reduce(function (total, scenario) {
      return total + scenario.cases.length;
    }, 0);
  }

  function updateDatasetSummary() {
    var scenarios = selectedScenarios();
    var repeats = selectedRepeats();
    var cases = scenarioCaseCount(scenarios);
    elements.datasetVersion.textContent = "Dataset " + dataset.version + " · " + cases + " labeled cases";
    if (!activeController) {
      elements.runProgressText.textContent = "0 / " + (scenarios.length * repeats) + " scenario calls";
    }
    renderTestSet();
  }

  function selectedIteration() {
    return (classifier.promptVariants || []).find(function (variant) {
      return variant.id === elements.promptVariant.value;
    }) || null;
  }

  function renderIteration() {
    var iteration = selectedIteration();
    if (!iteration) return;
    elements.iterationStatus.textContent = iteration.status;
    elements.iterationStatus.className = "iteration-badge " + iteration.status;
    elements.iterationTitle.textContent = iteration.label + " · " + iteration.version;
    elements.iterationSummary.textContent = iteration.summary;
    elements.iterationChanges.textContent = "";
    iteration.changes.forEach(function (change) {
      var item = document.createElement("li");
      item.textContent = change;
      elements.iterationChanges.appendChild(item);
    });
    elements.iterationFinding.className = "iteration-finding " + iteration.status;
    elements.iterationFinding.hidden = !iteration.finding;
    elements.iterationFinding.textContent = iteration.finding || "";
  }

  function profileField(label, value) {
    var wrapper = document.createElement("div");
    var heading = document.createElement("b");
    heading.textContent = label;
    var content = document.createElement("span");
    content.textContent = Array.isArray(value) ? (value.length ? value.join(", ") : "None") : value;
    wrapper.append(heading, content);
    return wrapper;
  }

  function renderTestSet() {
    var scenarios = selectedScenarios();
    var cases = scenarioCaseCount(scenarios);
    var split = elements.evaluationSplit.value;
    elements.testSetSummary.textContent = scenarios.length + " scenario(s) · " + cases +
      " cases · inputs and expected results are visible before inference" +
      (split === "heldout" ? " · inspect only after freezing the candidate prompt" : "");
    elements.testSetVersion.textContent = "Dataset " + dataset.version + " · " + elements.evaluationSplit.value;
    elements.testSetScenarios.textContent = "";

    scenarios.forEach(function (scenario, scenarioIndex) {
      var details = document.createElement("details");
      details.className = "test-scenario";
      details.open = scenarioIndex === 0;
      var summary = document.createElement("summary");
      var name = document.createElement("strong");
      name.textContent = scenario.name;
      var meta = document.createElement("span");
      meta.textContent = scenario.split + " · " + scenario.profile.mode + " mode · " + scenario.cases.length + " cases";
      summary.append(name, meta);
      details.appendChild(summary);

      var profile = document.createElement("div");
      profile.className = "test-profile";
      profile.append(
        profileField("Goal", scenario.profile.goal),
        profileField("Useful topics", scenario.profile.usefulTopics),
        profileField("Unwanted topics", scenario.profile.unwantedTopics),
        profileField("Explicit exceptions", scenario.profile.exceptions)
      );
      details.appendChild(profile);

      var scroll = document.createElement("div");
      scroll.className = "table-scroll";
      var table = document.createElement("table");
      table.className = "test-case-table";
      var head = document.createElement("thead");
      var headRow = document.createElement("tr");
      ["Video input", "Purpose", "Relevance", "Unwanted", "Evidence", "Expected feed", "Why / tags"].forEach(function (text) {
        var cell = document.createElement("th");
        cell.textContent = text;
        headRow.appendChild(cell);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      var body = document.createElement("tbody");
      scenario.cases.forEach(function (testCase) {
        var row = document.createElement("tr");
        var videoCell = document.createElement("td");
        videoCell.className = "video-cell";
        var title = document.createElement("strong");
        title.textContent = testCase.video.title;
        var metadata = document.createElement("span");
        metadata.textContent = testCase.video.videoId + " · " + testCase.video.channel +
          (testCase.video.duration ? " · " + testCase.video.duration : "") +
          (testCase.video.isLive ? " · live" : "");
        videoCell.append(title, metadata);
        row.appendChild(videoCell);

        ["contentPurpose", "goalRelevance", "unwantedMatch", "evidenceSufficiency"].forEach(function (field) {
          var cell = document.createElement("td");
          cell.textContent = testCase.expected[field];
          row.appendChild(cell);
        });

        var decision = metricsApi.policyDecision(testCase.expected, scenario.profile.mode);
        var decisionCell = document.createElement("td");
        decisionCell.className = "expected-decision " + decision;
        decisionCell.textContent = decision;
        row.appendChild(decisionCell);

        var rationaleCell = document.createElement("td");
        rationaleCell.className = "test-rationale";
        var rationale = document.createElement("div");
        rationale.textContent = testCase.labelNote;
        var tags = document.createElement("span");
        tags.className = "case-tags";
        tags.textContent = testCase.tags.join(" · ");
        rationaleCell.append(rationale, tags);
        row.appendChild(rationaleCell);
        body.appendChild(row);
      });
      table.appendChild(body);
      scroll.appendChild(table);
      details.appendChild(scroll);
      elements.testSetScenarios.appendChild(details);
    });
  }

  function setProgress(completed, total) {
    var percent = total ? Math.round((completed / total) * 100) : 0;
    elements.runProgressText.textContent = completed + " / " + total + " scenario calls";
    elements.progressTrack.setAttribute("aria-valuenow", String(percent));
    elements.progressBar.style.width = percent + "%";
  }

  function setRunning(running) {
    elements.runEvaluation.disabled = running || !modelReady;
    elements.stopEvaluation.disabled = !running;
    elements.promptVariant.disabled = running;
    elements.evaluationSplit.disabled = running;
    elements.repeatCount.disabled = running;
  }

  function percentage(value) {
    return typeof value === "number" ? (value * 100).toFixed(1) + "%" : "—";
  }

  function milliseconds(value) {
    return typeof value === "number" ? Math.round(value).toLocaleString() + " ms" : "—";
  }

  function humanDuration(value) {
    if (typeof value !== "number") return "—";
    if (value < 1000) return Math.round(value) + " ms";
    if (value < 60000) return (value / 1000).toFixed(1) + " s";
    var minutes = Math.floor(value / 60000);
    var seconds = ((value % 60000) / 1000).toFixed(1);
    return minutes + "m " + seconds + "s";
  }

  function signedDuration(value) {
    if (typeof value !== "number") return "—";
    if (value === 0) return humanDuration(0);
    return (value > 0 ? "+" : "-") + humanDuration(Math.abs(value));
  }

  function missingRecord(record) {
    return metricsApi.isMissingAssessment(record);
  }

  function exactMatch(record) {
    return !missingRecord(record) && LABEL_FIELDS.every(function (field) {
      return record.actual[field] === record.expected[field];
    });
  }

  function recordPredictions(scenario, repeat, response) {
    var assessments = {};
    response.assessments.forEach(function (assessment) {
      assessments[assessment.videoId] = assessment;
    });
    return scenario.cases.map(function (testCase) {
      var missing = response.diagnostics.missingVideoIds.indexOf(testCase.video.videoId) !== -1;
      return {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        split: scenario.split,
        mode: scenario.profile.mode,
        repeat: repeat,
        caseId: testCase.video.videoId,
        video: Object.assign({}, testCase.video),
        tags: testCase.tags.slice(),
        labelNote: testCase.labelNote,
        assessmentStatus: missing ? "missing" : "returned",
        expected: Object.assign({}, testCase.expected),
        actual: Object.assign({}, assessments[testCase.video.videoId]),
      };
    });
  }

  function compactDiagnostics(diagnostics) {
    return {
      requestedAssessmentCount: diagnostics.requestedAssessmentCount,
      returnedAssessmentCount: diagnostics.returnedAssessmentCount,
      acceptedAssessmentCount: diagnostics.acceptedAssessmentCount,
      missingAssessmentCount: diagnostics.missingAssessmentCount,
      duplicateAssessmentCount: diagnostics.duplicateAssessmentCount,
      unexpectedAssessmentCount: diagnostics.unexpectedAssessmentCount,
      missingVideoIds: diagnostics.missingVideoIds.slice(),
      unexpectedVideoIds: diagnostics.unexpectedVideoIds.slice(),
      schemaConstrained: diagnostics.schemaConstrained,
      contextBeforePrompt: diagnostics.contextBeforePrompt,
      contextAfterPrompt: diagnostics.contextAfterPrompt,
      contextWindow: diagnostics.contextWindow,
    };
  }

  async function runEvaluation() {
    if (activeController) return;
    var scenarios = selectedScenarios();
    var repeats = selectedRepeats();
    var totalCalls = scenarios.length * repeats;
    var records = [];
    var latencies = [];
    var calls = [];
    var classifierIdentity = null;
    var startedAt = new Date().toISOString();
    var runStarted = performance.now();
    var completedCalls = 0;
    var promptVariant = elements.promptVariant.value;

    activeController = new AbortController();
    setRunning(true);
    setProgress(0, totalCalls);
    elements.runStatus.textContent = "Evaluation running";
    elements.stageDetail.textContent = "Starting the first isolated classifier session…";

    try {
      var status = await classifier.availability();
      if (status !== "available") {
        modelReady = false;
        var readinessError = new Error("The local model is not ready. Current status: " + status + ".");
        readinessError.code = "local_ai_not_ready";
        throw readinessError;
      }

      for (var repeat = 1; repeat <= repeats; repeat += 1) {
        for (var index = 0; index < scenarios.length; index += 1) {
          if (activeController.signal.aborted) throw new DOMException("Evaluation stopped", "AbortError");
          var scenario = scenarios[index];
          var request = requestBuilder.build(scenario, repeat, Date.now() + "-" + Math.random().toString(16).slice(2));
          elements.runStatus.textContent = "Evaluating " + scenario.name;
          elements.stageDetail.textContent = "Repeat " + repeat + " of " + repeats + " · preparing " + scenario.cases.length + " videos";

          var response = await classifier.classify(request, {
            signal: activeController.signal,
            promptVariant: promptVariant,
            onStage: function (event) {
              elements.stageDetail.textContent = scenario.name + " · repeat " + repeat + " · " + event.id + ": " + event.detail;
            },
          });

          classifierIdentity = response.classifier;
          records = records.concat(recordPredictions(scenario, repeat, response));
          latencies.push(response.timing.totalMs);
          calls.push({
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            split: scenario.split,
            repeat: repeat,
            timing: Object.assign({}, response.timing),
            diagnostics: compactDiagnostics(response.diagnostics),
          });
          completedCalls += 1;
          setProgress(completedCalls, totalCalls);
        }
      }

      var completedAt = new Date().toISOString();
      var wallClockMs = Math.max(0, Math.round(performance.now() - runStarted));
      var measured = metricsApi.evaluate(records, latencies, repeats);
      var timing = metricsApi.summarizeTiming(calls, wallClockMs);
      var reliability = metricsApi.summarizeReliability(calls);
      var report = {
        id: "evaluation-" + Date.now(),
        evaluator: {
          version: EVALUATOR_VERSION,
          missingOutputPolicy: "A missing assessment fails all label checks and cannot count as a correct abstention.",
        },
        datasetVersion: dataset.version,
        iteration: JSON.parse(JSON.stringify(selectedIteration())),
        testSet: JSON.parse(JSON.stringify(scenarios)),
        split: elements.evaluationSplit.value,
        repeats: repeats,
        startedAt: startedAt,
        completedAt: completedAt,
        classifier: classifierIdentity,
        scenarioCalls: calls,
        timing: timing,
        reliability: reliability,
        metrics: measured,
        records: records,
      };
      currentReport = report;
      renderReport(report);
      await saveHistory(report);
      elements.runStatus.textContent = "Evaluation complete";
      elements.stageDetail.textContent = measured.predictions + " predictions scored across " + measured.uniqueCases + " unique labeled cases.";
    } catch (error) {
      if (activeController && activeController.signal.aborted) {
        elements.runStatus.textContent = "Evaluation stopped";
        elements.stageDetail.textContent = "The partial run was discarded so it cannot be mistaken for a complete score.";
      } else {
        elements.runStatus.textContent = "Evaluation failed";
        elements.stageDetail.textContent = (error && error.message) || "The local evaluation failed.";
        console.error("FocusFeed evaluation failed", error);
      }
    } finally {
      activeController = null;
      setRunning(false);
    }
  }

  function renderMetrics(metrics, timing, reliability) {
    elements.exactMetric.textContent = percentage(metrics.exactMatchAccuracy);
    elements.decisionMetric.textContent = percentage(metrics.decisionAccuracy);
    elements.relevanceMetric.textContent = percentage(metrics.relevanceAccuracy);
    elements.unwantedMetric.textContent = percentage(metrics.unwanted.f1);
    elements.falseHideMetric.textContent = percentage(metrics.falseHideRate);
    elements.falseHideDetail.textContent = metrics.falseHideCount + " useful prediction(s) hidden";
    elements.falseShowMetric.textContent = percentage(metrics.falseShowRate);
    elements.falseShowDetail.textContent = metrics.falseShowCount + " distracting prediction(s) shown";
    elements.abstentionMetric.textContent = percentage(metrics.abstentionRecall);
    elements.latencyMetric.textContent = milliseconds(metrics.latency.p50Ms) + " / " + milliseconds(metrics.latency.p95Ms);
    elements.latencyDetail.textContent = metrics.latency.calls + " scenario calls · average " + milliseconds(metrics.latency.averageMs);
    elements.consistencyMetric.textContent = percentage(metrics.consistencyRate);
    elements.wallTimeMetric.textContent = humanDuration(timing && timing.wallClockMs);
    elements.inferenceShareMetric.textContent = percentage(timing && timing.inferenceShareOfWall);
    elements.coverageMetric.textContent = percentage(reliability && reliability.coverage);
    elements.coverageDetail.textContent = reliability
      ? reliability.accepted + "/" + reliability.requested + " accepted · " + reliability.missing + " missing"
      : "accepted assessments";
  }

  function timingForReport(report) {
    if (report.timing) return report.timing;
    var started = Date.parse(report.startedAt);
    var completed = Date.parse(report.completedAt);
    var wallClockMs = Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started)
      : null;
    return metricsApi.summarizeTiming(report.scenarioCalls || [], wallClockMs);
  }

  function renderTiming(report, timing) {
    elements.timingSummary.textContent = humanDuration(timing.wallClockMs) + " wall time · " +
      humanDuration(timing.stages.inferenceMs.totalMs) + " inference · " +
      humanDuration(timing.stages.sessionCreateMs.totalMs) + " session setup";
    elements.timingRows.textContent = "";
    timing.calls.forEach(function (call) {
      var row = document.createElement("tr");
      [
        call.scenarioName + (report.repeats > 1 ? " · run " + call.repeat : ""),
        humanDuration(call.totalMs),
        humanDuration(call.sessionMs),
        humanDuration(call.inferenceMs),
        humanDuration(call.otherMs),
      ].forEach(function (value) {
        var cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      elements.timingRows.appendChild(row);
    });

    var totalRow = document.createElement("tr");
    totalRow.className = "total-row";
    [
      "Pipeline total",
      humanDuration(timing.pipelineMs),
      humanDuration(timing.stages.sessionCreateMs.totalMs),
      humanDuration(timing.stages.inferenceMs.totalMs),
      humanDuration(Math.max(0, timing.pipelineMs - timing.stages.sessionCreateMs.totalMs - timing.stages.inferenceMs.totalMs)),
    ].forEach(function (value) {
      var cell = document.createElement("td");
      cell.textContent = value;
      totalRow.appendChild(cell);
    });
    elements.timingRows.appendChild(totalRow);
  }

  function promptLabel(report) {
    if (!report.classifier) return "unknown prompt";
    return report.classifier.promptVersion || report.classifier.promptVariant || "unknown prompt";
  }

  function compatibleComparison(report) {
    var candidates = history.filter(function (candidate) {
      return candidate.id !== report.id &&
        candidate.datasetVersion === report.datasetVersion &&
        candidate.split === report.split &&
        candidate.repeats === report.repeats &&
        promptLabel(candidate) !== promptLabel(report);
    });
    var reportVariant = report.classifier && report.classifier.promptVariant;
    if (reportVariant && reportVariant !== "baseline") {
      return candidates.find(function (candidate) {
        return candidate.classifier && (
          candidate.classifier.promptVariant === "baseline" ||
          candidate.classifier.promptVersion === "local-2026-09-18.1"
        );
      }) || candidates[0] || null;
    }
    return candidates[0] || null;
  }

  function signedPoints(value) {
    if (typeof value !== "number") return "—";
    var points = value * 100;
    return (points > 0 ? "+" : "") + points.toFixed(1) + " pp";
  }

  function renderComparison(report, timing, reportMetrics, reliability) {
    var baseline = compatibleComparison(report);
    elements.comparisonContent.textContent = "";
    if (!baseline) {
      elements.comparisonContent.textContent = "No compatible run with another prompt is retained yet. Run the baseline and candidate on the same split and repeat count.";
      return;
    }

    var baselineScoring = scoreReport(baseline);
    var baselineTiming = timingForReport(baseline);
    var baselineMetrics = baselineScoring.metrics;
    var baselineReliability = baselineScoring.reliability;
    var title = document.createElement("div");
    title.className = "comparison-title";
    title.textContent = promptLabel(report) + " compared with " + promptLabel(baseline);
    var grid = document.createElement("div");
    grid.className = "comparison-deltas";
    var items = [
      {
        label: "Exact match",
        value: (reportMetrics.exactMatchAccuracy - baselineMetrics.exactMatchAccuracy),
        text: signedPoints(reportMetrics.exactMatchAccuracy - baselineMetrics.exactMatchAccuracy),
        lowerIsBetter: false,
      },
      {
        label: "Decision accuracy",
        value: (reportMetrics.decisionAccuracy - baselineMetrics.decisionAccuracy),
        text: signedPoints(reportMetrics.decisionAccuracy - baselineMetrics.decisionAccuracy),
        lowerIsBetter: false,
      },
      {
        label: "False-hide rate",
        value: (reportMetrics.falseHideRate - baselineMetrics.falseHideRate),
        text: signedPoints(reportMetrics.falseHideRate - baselineMetrics.falseHideRate),
        lowerIsBetter: true,
      },
      {
        label: "Evaluation time",
        value: timing.wallClockMs - baselineTiming.wallClockMs,
        text: signedDuration(timing.wallClockMs - baselineTiming.wallClockMs),
        lowerIsBetter: true,
      },
      {
        label: "p50 batch latency",
        value: reportMetrics.latency.p50Ms - baselineMetrics.latency.p50Ms,
        text: signedDuration(reportMetrics.latency.p50Ms - baselineMetrics.latency.p50Ms),
        lowerIsBetter: true,
      },
      {
        label: "Output coverage",
        value: reliability.coverage - baselineReliability.coverage,
        text: signedPoints(reliability.coverage - baselineReliability.coverage),
        lowerIsBetter: false,
      },
    ];
    items.forEach(function (item) {
      var card = document.createElement("div");
      var label = document.createElement("span");
      label.textContent = item.label;
      var value = document.createElement("strong");
      var improved = item.lowerIsBetter ? item.value < 0 : item.value > 0;
      var regressed = item.lowerIsBetter ? item.value > 0 : item.value < 0;
      value.className = improved ? "delta-good" : (regressed ? "delta-bad" : "");
      value.textContent = item.text;
      card.append(label, value);
      grid.appendChild(card);
    });
    elements.comparisonContent.append(title, grid);
    if (reliability.coverage < 1) {
      var warning = document.createElement("div");
      warning.className = "comparison-warning";
      warning.textContent = "This run has incomplete model output. Accuracy and speed deltas are diagnostic only and cannot qualify the prompt.";
      elements.comparisonContent.appendChild(warning);
    }
  }

  function renderMatrix(container, confusion) {
    container.textContent = "";
    var table = document.createElement("table");
    table.className = "confusion-table";
    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    var axis = document.createElement("th");
    axis.textContent = "Expected ↓ / Actual →";
    headRow.appendChild(axis);
    confusion.labels.forEach(function (label) {
      var cell = document.createElement("th");
      cell.textContent = label;
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement("tbody");
    confusion.labels.forEach(function (expected) {
      var row = document.createElement("tr");
      var rowLabel = document.createElement("td");
      rowLabel.textContent = expected;
      row.appendChild(rowLabel);
      confusion.labels.forEach(function (actual) {
        var cell = document.createElement("td");
        cell.textContent = String((confusion.values[expected] && confusion.values[expected][actual]) || 0);
        cell.className = expected === actual ? "diagonal" : "off-diagonal";
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
    table.appendChild(body);
    container.appendChild(table);
  }

  function appendLabelStack(cell, assessment) {
    var stack = document.createElement("div");
    stack.className = "result-stack";
    LABEL_FIELDS.forEach(function (field) {
      var item = document.createElement("span");
      var name = document.createElement("b");
      name.textContent = field + ": ";
      item.append(name, document.createTextNode(assessment[field]));
      stack.appendChild(item);
    });
    cell.appendChild(stack);
  }

  function filteredRecords(records) {
    var filter = elements.resultFilter.value;
    if (filter === "all") return records;
    if (filter === "false-hides") {
      return records.filter(function (record) {
        return record.expectedDecision === "show" && record.actualDecision === "hide";
      });
    }
    if (filter === "false-shows") {
      return records.filter(function (record) {
        return record.expectedDecision === "hide" && record.actualDecision === "show";
      });
    }
    if (filter === "missing") {
      return records.filter(missingRecord);
    }
    return records.filter(function (record) { return !exactMatch(record); });
  }

  function renderCases(records) {
    var visible = filteredRecords(records);
    var missing = records.filter(missingRecord).length;
    var mismatches = records.filter(function (record) {
      return !missingRecord(record) && !exactMatch(record);
    }).length;
    elements.caseSummary.textContent = mismatches + " semantic mismatch(es) · " + missing +
      " missing output(s) · " + records.length + " expected predictions · showing " + visible.length;
    elements.caseRows.textContent = "";
    if (!visible.length) {
      var emptyRow = document.createElement("tr");
      emptyRow.className = "empty-row";
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 6;
      emptyCell.textContent = "No cases match this filter.";
      emptyRow.appendChild(emptyCell);
      elements.caseRows.appendChild(emptyRow);
      return;
    }

    visible.forEach(function (record) {
      var row = document.createElement("tr");
      var videoCell = document.createElement("td");
      videoCell.className = "video-cell";
      var title = document.createElement("strong");
      title.textContent = record.video.title;
      var metadata = document.createElement("span");
      metadata.textContent = record.scenarioName + " · repeat " + record.repeat + " · " + record.caseId;
      var tags = document.createElement("span");
      tags.className = "case-tags";
      tags.textContent = record.tags.join(" · ");
      videoCell.append(title, metadata, tags);
      row.appendChild(videoCell);

      var expectedCell = document.createElement("td");
      appendLabelStack(expectedCell, record.expected);
      row.appendChild(expectedCell);

      var actualCell = document.createElement("td");
      appendLabelStack(actualCell, record.actual);
      row.appendChild(actualCell);

      var decisionCell = document.createElement("td");
      decisionCell.className = "decision-pair";
      var decisionClass = record.expectedDecision === record.actualDecision ? "good" : "bad";
      var decision = document.createElement("span");
      decision.className = decisionClass;
      decision.textContent = record.expectedDecision + " → " + record.actualDecision;
      decisionCell.appendChild(decision);
      row.appendChild(decisionCell);

      var verdictCell = document.createElement("td");
      var missing = missingRecord(record);
      var passed = !missing && exactMatch(record);
      verdictCell.className = "verdict " + (passed ? "pass" : "fail");
      verdictCell.textContent = missing ? "MISSING OUTPUT" : (passed ? "PASS" : "MISMATCH");
      row.appendChild(verdictCell);

      var reasonCell = document.createElement("td");
      var modelReason = document.createElement("div");
      modelReason.textContent = record.actual.reason || "No model reason returned.";
      var goldReason = document.createElement("span");
      goldReason.className = "case-tags";
      goldReason.textContent = "Gold note: " + record.labelNote;
      reasonCell.append(modelReason, goldReason);
      row.appendChild(reasonCell);
      elements.caseRows.appendChild(row);
    });
  }

  function cloneRecord(record) {
    return Object.assign({}, record, {
      assessmentStatus: missingRecord(record) ? "missing" : (record.assessmentStatus || "returned"),
      expected: Object.assign({}, record.expected),
      actual: Object.assign({}, record.actual),
    });
  }

  function scoreReport(report) {
    var records = (report.records || []).map(cloneRecord);
    var latencies = (report.scenarioCalls || []).map(function (call) {
      return Number(call.timing && call.timing.totalMs || 0);
    });
    return {
      records: records,
      metrics: metricsApi.evaluate(records, latencies, report.repeats),
      reliability: metricsApi.summarizeReliability(report.scenarioCalls || []),
    };
  }

  function renderReport(report) {
    var scored = scoreReport(report);
    var timing = timingForReport(report);
    currentReport = Object.assign({}, report, {
      evaluator: report.evaluator || {
        version: EVALUATOR_VERSION,
        missingOutputPolicy: "Metrics recomputed on display: missing assessments fail all label checks and cannot count as correct abstentions.",
        recomputedLegacyReport: true,
      },
      timing: timing,
      reliability: scored.reliability,
      metrics: scored.metrics,
      records: scored.records,
    });
    renderMetrics(scored.metrics, timing, scored.reliability);
    renderTiming(currentReport, timing);
    renderComparison(currentReport, timing, scored.metrics, scored.reliability);
    renderMatrix(elements.relevanceMatrix, scored.metrics.confusion.goalRelevance);
    renderMatrix(elements.unwantedMatrix, scored.metrics.confusion.unwantedMatch);
    renderCases(scored.records);
    elements.reportOutput.textContent = JSON.stringify(currentReport, null, 2);
  }

  async function saveHistory(report) {
    history.unshift(report);
    history = history.slice(0, 10);
    await chrome.storage.local.set({ classifierEvalRuns: history });
    renderHistory();
  }

  function renderHistory() {
    elements.historyList.textContent = "";
    elements.historySummary.textContent = history.length + " stored locally · latest 10";
    if (!history.length) {
      var empty = document.createElement("p");
      empty.className = "empty-message";
      empty.textContent = "No retained evaluations.";
      elements.historyList.appendChild(empty);
      return;
    }
    history.forEach(function (report) {
      var scored = scoreReport(report);
      var item = document.createElement("div");
      item.className = "history-run";
      var copy = document.createElement("div");
      var title = document.createElement("strong");
      title.textContent = report.split + " · " + promptLabel(report) + " · " + percentage(scored.metrics.exactMatchAccuracy);
      var detail = document.createElement("span");
      detail.textContent = new Date(report.completedAt).toLocaleString() + " · " + report.metrics.predictions + " predictions · " + report.repeats + " run(s)";
      copy.append(title, detail);
      var view = document.createElement("button");
      view.type = "button";
      view.textContent = "View";
      view.addEventListener("click", function () { renderReport(report); });
      item.append(copy, view);
      elements.historyList.appendChild(item);
    });
  }

  async function checkAvailability() {
    try {
      var status = await classifier.availability();
      modelReady = status === "available";
      elements.modelState.textContent = "Local model: " + status;
      elements.modelState.className = "model-state " + (status === "available" ? "available" : "unavailable");
      elements.runEvaluation.disabled = status !== "available";
    } catch (error) {
      modelReady = false;
      elements.modelState.textContent = "Local model unavailable";
      elements.modelState.className = "model-state unavailable";
      elements.runEvaluation.disabled = true;
      elements.stageDetail.textContent = (error && error.message) || "Chrome's built-in model API is unavailable.";
    }
  }

  async function copyReport(event) {
    event.preventDefault();
    if (!currentReport) return;
    await navigator.clipboard.writeText(JSON.stringify(currentReport, null, 2));
    elements.copyReport.textContent = "Copied";
    setTimeout(function () { elements.copyReport.textContent = "Copy"; }, 1200);
  }

  function exportReport(event) {
    event.preventDefault();
    if (!currentReport) return;
    var blob = new Blob([JSON.stringify(currentReport, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "focusfeed-" + currentReport.id + ".json";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  elements.runEvaluation.addEventListener("click", runEvaluation);
  elements.stopEvaluation.addEventListener("click", function () {
    if (activeController) activeController.abort();
  });
  elements.evaluationSplit.addEventListener("change", updateDatasetSummary);
  elements.promptVariant.addEventListener("change", function () {
    updateDatasetSummary();
    renderIteration();
  });
  elements.repeatCount.addEventListener("change", updateDatasetSummary);
  elements.resultFilter.addEventListener("change", function () {
    if (currentReport) renderCases(currentReport.records);
  });
  elements.copyReport.addEventListener("click", function (event) {
    copyReport(event).catch(function (error) {
      elements.stageDetail.textContent = "Could not copy report: " + error.message;
    });
  });
  elements.exportReport.addEventListener("click", exportReport);
  elements.clearHistory.addEventListener("click", async function () {
    history = [];
    await chrome.storage.local.remove(HISTORY_KEY);
    renderHistory();
  });

  updateDatasetSummary();
  renderIteration();
  chrome.storage.local.get(HISTORY_KEY).then(function (stored) {
    history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
    renderHistory();
  });
  checkAvailability();
})();
