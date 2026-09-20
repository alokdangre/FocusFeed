(function () {
  "use strict";

  var fixtures = FocusFeedProviderSmokeFixtures;
  var core = FocusFeedProviderSmokeCore;
  var classifier = FocusFeedLocalClassifier;
  var runButton = document.getElementById("runProviderSmoke");
  var stopButton = document.getElementById("stopProviderSmoke");
  var checkButton = document.getElementById("checkProviderSmoke");
  var exportButton = document.getElementById("exportProviderSmoke");
  var runState = document.getElementById("providerSmokeRunState");
  var statusText = document.getElementById("providerSmokeStatus");
  var stageText = document.getElementById("providerSmokeStage");
  var progressText = document.getElementById("providerSmokeProgress");
  var progressTrack = document.getElementById("providerSmokeProgressTrack");
  var progressBar = document.getElementById("providerSmokeProgressBar");
  var fixtureRows = document.getElementById("providerSmokeFixtureRows");
  var resultRows = document.getElementById("providerSmokeResultRows");
  var callRows = document.getElementById("providerSmokeCallRows");
  var modelReady = false;
  var activeRun = null;
  var latestReport = null;

  var scenarioById = {};
  var caseBySubscriber = {};
  var orderedSubscribers = [];
  fixtures.scenarios.forEach(function (scenario) {
    scenarioById[scenario.id] = scenario;
    scenario.cases.forEach(function (testCase) {
      var subscriberId = scenario.id + "::" + testCase.video.videoId;
      caseBySubscriber[subscriberId] = { scenario: scenario, testCase: testCase };
      orderedSubscribers.push(subscriberId);
    });
  });

  function copy(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function appendText(parent, tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function percent(value) {
    return typeof value === "number" ? (value * 100).toFixed(1) + "%" : "—";
  }

  function duration(value) {
    if (!Number.isFinite(value)) return "—";
    if (value < 1000) return Math.round(value) + " ms";
    if (value < 60000) return (value / 1000).toFixed(1) + " s";
    return Math.floor(value / 60000) + "m " + ((value % 60000) / 1000).toFixed(1) + "s";
  }

  function renderLabels(parent, assessment) {
    var stack = document.createElement("div");
    stack.className = "label-stack";
    if (!assessment) {
      appendText(stack, "span", "", "No validated assessment");
    } else {
      core.fields.forEach(function (field) {
        var line = document.createElement("span");
        appendText(line, "strong", "", field + ": ");
        line.appendChild(document.createTextNode(String(assessment[field])));
        stack.appendChild(line);
      });
    }
    parent.appendChild(stack);
  }

  function decisionPill(parent, label, decision, extraClass) {
    return appendText(parent, "span", "decision-pill " + (extraClass || decision), label + ": " + decision);
  }

  function renderFixtures() {
    document.getElementById("providerSmokeFixtureVersion").textContent =
      "Smoke " + fixtures.version + " · dataset " + fixtures.datasetVersion + " · " + fixtures.totalCases + " cases";
    fixtureRows.textContent = "";
    fixtures.scenarios.forEach(function (scenario) {
      scenario.cases.forEach(function (testCase, caseIndex) {
        var row = document.createElement("tr");
        var scenarioCell = document.createElement("td");
        if (caseIndex === 0) {
          appendText(scenarioCell, "strong", "case-name", scenario.name);
          appendText(scenarioCell, "span", "case-id", scenario.id + " · " + scenario.profile.mode);
          appendText(scenarioCell, "span", "case-note", scenario.profile.goal);
        } else {
          appendText(scenarioCell, "span", "case-id", scenario.id);
        }
        row.appendChild(scenarioCell);

        var videoCell = document.createElement("td");
        appendText(videoCell, "strong", "case-name", testCase.video.title);
        appendText(videoCell, "span", "case-id", testCase.video.videoId);
        appendText(videoCell, "span", "input-line", testCase.video.channel + " · " + (testCase.video.duration || "duration unknown"));
        row.appendChild(videoCell);

        var expectedCell = document.createElement("td");
        renderLabels(expectedCell, testCase.expected);
        row.appendChild(expectedCell);

        var decisions = document.createElement("td");
        decisions.className = "decision-pair";
        decisionPill(decisions, scenario.profile.mode, FocusFeedWorkflow.policyDecision(testCase.expected, scenario.profile.mode));
        decisionPill(decisions, "focus", FocusFeedWorkflow.policyDecision(testCase.expected, "focus"));
        row.appendChild(decisions);

        var rationale = document.createElement("td");
        appendText(rationale, "span", "case-note", testCase.labelNote);
        appendText(rationale, "span", "case-id", (testCase.tags || []).join(" · "));
        row.appendChild(rationale);
        fixtureRows.appendChild(row);
      });
    });
  }

  function updateProgress(run) {
    var completed = run ? run.recordsBySubscriber.size : 0;
    var value = Math.round((completed / fixtures.totalCases) * 100);
    progressText.textContent = completed + " / " + fixtures.totalCases + " videos";
    progressTrack.setAttribute("aria-valuenow", String(value));
    progressBar.style.width = value + "%";
    if (run) {
      var snapshot = run.scheduler.snapshot();
      document.getElementById("providerCallMetric").textContent = snapshot.stats.providerRequests + " / " + fixtures.requestBudget;
      document.getElementById("providerBoundMetric").textContent = snapshot.stats.peakQueueDepth + " / " + snapshot.stats.peakInFlightRequests;
    }
  }

  function orderedRecords(run) {
    return orderedSubscribers.map(function (id) { return run.recordsBySubscriber.get(id); }).filter(Boolean);
  }

  function renderResults(run) {
    resultRows.textContent = "";
    orderedSubscribers.forEach(function (subscriberId) {
      var fixture = caseBySubscriber[subscriberId];
      var record = run && run.recordsBySubscriber.get(subscriberId);
      var row = document.createElement("tr");
      var video = document.createElement("td");
      appendText(video, "strong", "case-name", fixture.testCase.video.title);
      appendText(video, "span", "case-id", fixture.testCase.video.videoId + " · " + fixture.scenario.name);
      appendText(video, "span", "case-id", record ? record.status : "pending");
      row.appendChild(video);

      var expected = document.createElement("td");
      renderLabels(expected, fixture.testCase.expected);
      row.appendChild(expected);

      var actual = document.createElement("td");
      if (!record) appendText(actual, "span", "case-note", "Pending");
      else if (record.status === "failed") appendText(actual, "span", "comparison-fail", record.failure.code + " · " + record.failure.message);
      else {
        renderLabels(actual, record.actual);
        appendText(actual, "span", record.exactMatch ? "comparison-pass" : "comparison-fail", record.exactMatch ? "Exact labels" : "Label mismatch");
      }
      row.appendChild(actual);

      var selected = document.createElement("td");
      selected.className = "decision-pair";
      if (!record) appendText(selected, "span", "case-note", "Pending");
      else {
        decisionPill(selected, "expected", record.expectedDecision);
        decisionPill(selected, "actual", record.actualDecision, record.status === "failed" ? "failed" : record.actualDecision);
        appendText(selected, "span", record.decisionMatch ? "comparison-pass" : "comparison-fail", record.decisionMatch ? "MATCH" : (record.status === "failed" ? "UNRESOLVED" : "MISMATCH"));
      }
      row.appendChild(selected);

      var focus = document.createElement("td");
      focus.className = "decision-pair";
      if (!record) appendText(focus, "span", "case-note", "Pending");
      else {
        decisionPill(focus, "expected", record.expectedFocusDecision);
        decisionPill(focus, "actual", record.actualFocusDecision, record.status === "failed" ? "failed" : record.actualFocusDecision);
        appendText(focus, "span", record.focusDecisionMatch ? "comparison-pass" : "comparison-fail", record.focusFalseHide ? "FALSE HIDE" : (record.focusDecisionMatch ? "MATCH" : "MISMATCH"));
      }
      row.appendChild(focus);

      var timing = document.createElement("td");
      timing.className = "timing-stack";
      if (record && record.schedulerTiming) {
        appendText(timing, "span", "", "queue " + duration(record.schedulerTiming.queueWaitMs));
        appendText(timing, "span", "", "provider " + duration(record.schedulerTiming.providerMs));
        appendText(timing, "span", "", "total " + duration(record.schedulerTiming.totalMs));
      } else appendText(timing, "span", "", "—");
      row.appendChild(timing);
      resultRows.appendChild(row);
    });
  }

  function renderCalls(run) {
    callRows.textContent = "";
    if (!run || !run.scenarioCalls.length) {
      var empty = document.createElement("tr");
      appendText(empty, "td", "empty-row", "No provider calls yet.").colSpan = 8;
      callRows.appendChild(empty);
      return;
    }
    run.scenarioCalls.forEach(function (call, index) {
      var row = document.createElement("tr");
      appendText(row, "td", "case-id", String(index + 1));
      appendText(row, "td", "case-name", call.scenarioName);
      appendText(row, "td", call.status === "complete" ? "comparison-pass" : (call.status === "running" ? "provider-stage-current" : "comparison-fail"), call.status);
      appendText(row, "td", "", duration(call.timing && call.timing.totalMs));
      appendText(row, "td", "", duration(call.timing && call.timing.sessionCreateMs));
      appendText(row, "td", "", duration(call.timing && call.timing.inferenceMs));
      appendText(row, "td", "", duration(call.timing && call.timing.validationMs));
      var diagnostics = call.diagnostics;
      appendText(row, "td", "case-note", diagnostics
        ? "accepted " + diagnostics.acceptedAssessmentCount + "/" + diagnostics.requestedAssessmentCount +
          " · missing " + diagnostics.missingAssessmentCount + " · duplicate " + diagnostics.duplicateAssessmentCount +
          " · unexpected " + diagnostics.unexpectedAssessmentCount
        : (call.error ? call.error.code + " · " + call.error.message : "Waiting"));
      callRows.appendChild(row);
    });
  }

  function renderSummary(summary) {
    document.getElementById("providerGateMetric").textContent = summary.promotionGate.passed
      ? "PASS"
      : "FAIL · " + summary.promotionGate.failedChecks.length;
    document.getElementById("providerCoverageMetric").textContent = summary.resolved + " / " + summary.cases + " · " + percent(summary.coverage);
    document.getElementById("providerExactMetric").textContent = summary.exactMatches + " / " + summary.cases + " · " + percent(summary.exactMatchAccuracy);
    document.getElementById("providerDecisionMetric").textContent = summary.decisionMatches + " / " + summary.cases + " · " + percent(summary.decisionAccuracy);
    document.getElementById("providerFocusFalseHideMetric").textContent = String(summary.focusFalseHides);
    document.getElementById("providerCallMetric").textContent = summary.providerRequests + " / " + fixtures.requestBudget;
    document.getElementById("providerBoundMetric").textContent = summary.peakQueueDepth + " / " + summary.peakInFlightRequests;
    document.getElementById("providerLatencyMetric").textContent = duration(summary.providerTiming.p95);
    document.getElementById("providerWallMetric").textContent = duration(summary.wallClockMs);
  }

  function completeRecord(run, subscriberId, record) {
    if (run.recordsBySubscriber.has(subscriberId)) return;
    run.recordsBySubscriber.set(subscriberId, record);
    if (run.currentGroup && run.currentGroup.remaining.has(subscriberId)) {
      run.currentGroup.remaining.delete(subscriberId);
      if (!run.currentGroup.remaining.size) {
        var resolve = run.currentGroup.resolve;
        run.currentGroup = null;
        resolve();
      }
    }
    updateProgress(run);
    renderResults(run);
  }

  function schedulerFor(run) {
    var contentPurposes = ["tutorial", "practice", "news", "commentary", "entertainment", "music", "other", "unclear"];
    return FocusFeedWorkflowScheduler.create({
      autoDispatch: false,
      initialContextId: fixtures.scenarios[0].id,
      queueCap: fixtures.queueCap,
      maxInFlight: fixtures.maxInFlight,
      batchSize: fixtures.batchSize,
      timeoutMs: fixtures.timeoutMs,
      validateAssessment: function (assessment, entry) {
        return FocusFeedWorkflow.isValidDecisionAssessment(assessment, entry.videoId) &&
          contentPurposes.indexOf(assessment.contentPurpose) !== -1;
      },
      provider: async function (request, context) {
        var scenario = scenarioById[request.contextId];
        var call = {
          requestId: request.requestId,
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          videoIds: request.videos.map(function (video) { return video.videoId; }),
          startedAt: new Date().toISOString(),
          status: "running",
          stages: [],
          timing: null,
          diagnostics: null,
          classifier: null,
          error: null,
        };
        run.scenarioCalls.push(call);
        renderCalls(run);
        try {
          var response = await classifier.classify({
            requestId: request.requestId,
            profile: copy(scenario.profile),
            videos: copy(request.videos),
          }, {
            promptVariant: fixtures.promptVariant,
            signal: context.signal,
            onStage: function (stage) {
              call.stages.push(copy(stage));
              stageText.textContent = "Call " + run.scenarioCalls.length + "/" + fixtures.requestBudget +
                " · " + scenario.name + " · " + stage.id + " " + stage.status;
              renderCalls(run);
            },
          });
          call.completedAt = new Date().toISOString();
          call.status = "complete";
          call.timing = copy(response.timing);
          call.diagnostics = copy(response.diagnostics);
          call.classifier = copy(response.classifier);
          if (response.diagnostics.duplicateAssessmentCount || response.diagnostics.unexpectedAssessmentCount) {
            var invalidError = new Error("Local provider returned duplicate or unexpected video IDs.");
            invalidError.code = "invalid_provider_output";
            throw invalidError;
          }
          var missing = new Set(response.diagnostics.missingVideoIds || []);
          return {
            assessments: response.assessments.filter(function (assessment) {
              return !missing.has(assessment.videoId);
            }),
          };
        } catch (error) {
          call.completedAt = new Date().toISOString();
          if (!(run.stopped && call.status === "stopped")) call.status = run.stopped ? "stopped" : "failed";
          call.error = {
            code: error && error.code || error && error.name || "provider_error",
            message: error && error.message || "Local provider failed.",
          };
          throw error;
        } finally {
          renderCalls(run);
        }
      },
      onResult: function (result) {
        var fixture = caseBySubscriber[result.subscriberId];
        completeRecord(run, result.subscriberId, core.resolvedRecord(fixture.scenario, fixture.testCase, result));
      },
      onFailure: function (failure) {
        var fixture = caseBySubscriber[failure.subscriberId];
        completeRecord(run, failure.subscriberId, core.failureRecord(fixture.scenario, fixture.testCase, failure));
      },
      onEvent: function (event) {
        run.schedulerEvents.push(copy(event));
        updateProgress(run);
      },
    });
  }

  function runScenarioGroup(run, scenario) {
    if (run.scheduler.snapshot().contextId !== scenario.id) run.scheduler.setContext(scenario.id);
    return new Promise(function (resolve) {
      var remaining = new Set();
      run.currentGroup = { remaining: remaining, resolve: resolve };
      scenario.cases.forEach(function (testCase) {
        var subscriberId = scenario.id + "::" + testCase.video.videoId;
        remaining.add(subscriberId);
        var admission = run.scheduler.enqueue({
          key: scenario.id + ":" + testCase.video.videoId,
          videoId: testCase.video.videoId,
          subscriberId: subscriberId,
          contextId: scenario.id,
          payload: copy(testCase.video),
          priority: 100,
        });
        if (admission.status !== "queued" && admission.status !== "deduplicated") {
          completeRecord(run, subscriberId, core.failureRecord(scenario, testCase, {
            code: admission.reason || admission.status,
            message: "The scheduler did not admit this video.",
          }));
        }
      });
      if (!remaining.size) {
        run.currentGroup = null;
        resolve();
        return;
      }
      stageText.textContent = scenario.name + " · queued " + remaining.size + " videos";
      run.scheduler.flush();
    });
  }

  function markUnfinished(run, code, message) {
    orderedSubscribers.forEach(function (subscriberId) {
      if (run.recordsBySubscriber.has(subscriberId)) return;
      var fixture = caseBySubscriber[subscriberId];
      completeRecord(run, subscriberId, core.failureRecord(fixture.scenario, fixture.testCase, {
        code: code,
        message: message,
      }));
    });
  }

  function finalizeRun(run) {
    clearInterval(run.wallTimer);
    var wallClockMs = Math.max(0, performance.now() - run.startedAtMs);
    var records = orderedRecords(run);
    var snapshot = run.scheduler.snapshot();
    var summary = core.summarize(records, run.scenarioCalls, snapshot, wallClockMs, run.stopped);
    summary.promotionGate = core.promotionGate(summary, {
      cases: fixtures.totalCases,
      requestBudget: fixtures.requestBudget,
      batchSize: fixtures.batchSize,
      maxInFlight: fixtures.maxInFlight,
    });
    var prompt = classifier.promptVariants.find(function (variant) { return variant.id === fixtures.promptVariant; });
    latestReport = {
      schemaVersion: "focusfeed-provider-smoke-report-v1",
      exportedAt: new Date().toISOString(),
      runStartedAt: run.startedAt,
      runCompletedAt: new Date().toISOString(),
      fixtureVersion: fixtures.version,
      datasetVersion: fixtures.datasetVersion,
      schedulerVersion: FocusFeedWorkflowScheduler.SCHEDULER_VERSION,
      workflowVersion: FocusFeedWorkflow.WORKFLOW_VERSION,
      classifier: {
        provider: "chrome-built-in-ai",
        model: classifier.modelName,
        promptVariant: fixtures.promptVariant,
        promptVersion: prompt && prompt.version,
      },
      configuration: {
        queueCap: fixtures.queueCap,
        maxInFlight: fixtures.maxInFlight,
        batchSize: fixtures.batchSize,
        timeoutMs: fixtures.timeoutMs,
        requestBudget: fixtures.requestBudget,
      },
      environment: { userAgent: navigator.userAgent },
      summary: summary,
      scheduler: { snapshot: snapshot, events: copy(run.schedulerEvents) },
      scenarioCalls: copy(run.scenarioCalls),
      testSet: copy(fixtures.scenarios),
      records: copy(records),
    };
    renderSummary(summary);
    renderResults(run);
    renderCalls(run);
    exportButton.disabled = false;
    stopButton.disabled = true;
    runButton.disabled = !modelReady;
    checkButton.disabled = false;
    if (run.stopped) {
      runState.className = "run-chip failed";
      runState.textContent = "Stopped";
      statusText.textContent = "Run stopped. Unfinished videos remain visible and are reported as unresolved.";
    } else if (summary.promotionGate.passed) {
      runState.className = "run-chip passed";
      runState.textContent = "Gate passed";
      statusText.textContent = summary.resolved + "/" + summary.cases + " validated outputs · " +
        summary.decisionMatches + "/" + summary.cases + " selected decisions · zero Focus false hides.";
    } else {
      runState.className = "run-chip failed";
      runState.textContent = "Gate failed";
      statusText.textContent = "Run completed, but promotion is blocked by: " +
        summary.promotionGate.failedChecks.join(", ") + ". Inspect the affected rows before changing the workflow.";
    }
    stageText.textContent = run.stopped ? "Stopped by user." : "All bounded provider calls finished.";
    activeRun = null;
  }

  async function startRun() {
    if (activeRun || !modelReady) return;
    latestReport = null;
    exportButton.disabled = true;
    runButton.disabled = true;
    checkButton.disabled = true;
    stopButton.disabled = false;
    runState.className = "run-chip running";
    runState.textContent = "Running";
    statusText.textContent = "Keep this tab open. You may close the extension popup.";
    var run = {
      startedAt: new Date().toISOString(),
      startedAtMs: performance.now(),
      stopped: false,
      recordsBySubscriber: new Map(),
      scenarioCalls: [],
      schedulerEvents: [],
      currentGroup: null,
      scheduler: null,
      wallTimer: null,
    };
    activeRun = run;
    run.scheduler = schedulerFor(run);
    run.wallTimer = setInterval(function () {
      document.getElementById("providerWallMetric").textContent = duration(performance.now() - run.startedAtMs);
    }, 1000);
    updateProgress(run);
    renderResults(run);
    renderCalls(run);
    try {
      var index;
      for (index = 0; index < fixtures.scenarios.length; index += 1) {
        if (run.stopped) break;
        await runScenarioGroup(run, fixtures.scenarios[index]);
      }
      if (!run.stopped && run.recordsBySubscriber.size < fixtures.totalCases) {
        markUnfinished(run, "incomplete_run", "The provider smoke ended before every video produced an outcome.");
      }
    } catch (error) {
      markUnfinished(run, error && error.code || "run_failed", error && error.message || "Provider smoke failed.");
    }
    finalizeRun(run);
  }

  function stopRun() {
    var run = activeRun;
    if (!run || run.stopped) return;
    run.stopped = true;
    run.scheduler.stop("user_stop");
    run.scenarioCalls.forEach(function (call) {
      if (call.status === "running") {
        call.status = "stopped";
        call.completedAt = new Date().toISOString();
        call.error = { code: "user_stop", message: "Stopped by the user." };
      }
    });
    markUnfinished(run, "user_stop", "Stopped by the user before classification completed.");
    renderCalls(run);
  }

  async function checkModel(prepare) {
    checkButton.disabled = true;
    runButton.disabled = true;
    runState.className = "run-chip running";
    runState.textContent = "Checking model";
    try {
      var availability = await classifier.availability();
      if (availability !== "available" && prepare) {
        statusText.textContent = "Preparing Chrome built-in AI…";
        await classifier.prepare(function (progress) {
          statusText.textContent = "Preparing Chrome built-in AI · " + progress.toFixed(1) + "%";
        });
        availability = await classifier.availability();
      }
      modelReady = availability === "available";
      runState.className = "run-chip " + (modelReady ? "passed" : "failed");
      runState.textContent = modelReady ? "Local AI ready" : availability;
      statusText.textContent = modelReady
        ? "Local AI is ready. The smoke uses exactly three bounded provider calls."
        : "Local AI status: " + availability + ". Select Check local AI to prepare it.";
    } catch (error) {
      modelReady = false;
      runState.className = "run-chip failed";
      runState.textContent = "Local AI unavailable";
      statusText.textContent = error && error.message || "Could not check local AI.";
    } finally {
      checkButton.disabled = false;
      runButton.disabled = !modelReady || Boolean(activeRun);
    }
  }

  runButton.addEventListener("click", startRun);
  stopButton.addEventListener("click", stopRun);
  checkButton.addEventListener("click", function () { checkModel(true); });
  exportButton.addEventListener("click", function () {
    if (!latestReport) return;
    var blob = new Blob([JSON.stringify(latestReport, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "focusfeed-provider-smoke-" + Date.now() + ".json";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  });
  window.addEventListener("beforeunload", function () {
    if (activeRun) activeRun.scheduler.stop("page_closed");
  });

  renderFixtures();
  renderResults(null);
  renderCalls(null);
  checkModel(false);
})();
