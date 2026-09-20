(function () {
  "use strict";

  var STAGES = [
    { id: "availability", label: "Model availability", detail: "Check Chrome's built-in model" },
    { id: "session", label: "Session creation", detail: "Create an isolated inference session" },
    { id: "inference", label: "Inference", detail: "Classify the controlled video batch" },
    { id: "parsing", label: "JSON parsing", detail: "Parse schema-constrained output" },
    { id: "validation", label: "Validation", detail: "Check IDs, duplicates, and missing results" },
    { id: "complete", label: "Complete", detail: "Finish and retain the local trace" },
  ];

  var FIXTURES = {
    interview: {
      profile: {
        goal: "Prepare for software engineering coding interviews over the next two weeks.",
        usefulTopics: ["data structures", "algorithms", "system design", "mock interviews"],
        unwantedTopics: ["gaming", "celebrity news", "creator drama"],
        exceptions: ["background music"],
        mode: "focus",
      },
      videos: [
        { videoId: "lab-dsa", title: "Sliding Window: Solve These 5 Interview Problems", channel: "Algorithm Academy", duration: "12:30", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-gaming", title: "I Played GTA 6 Early — Here's What Happened", channel: "Game Drop", duration: "18:42", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-music", title: "Deep Focus Music for Coding — 90 Minutes", channel: "Quiet Keys", duration: "1:30:00", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-system", title: "Designing a URL Shortener: System Design Interview", channel: "Backend Brief", duration: "24:10", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-vague", title: "We Need to Talk", channel: "Daily Notes", duration: "8:05", isShort: false, isLive: false, isPremiere: false }
      ],
    },
    upsc: {
      profile: {
        goal: "Prepare for the UPSC civil services examination with reliable conceptual lessons and current affairs analysis.",
        usefulTopics: ["Indian polity", "history", "geography", "economics", "current affairs"],
        unwantedTopics: ["film gossip", "gaming", "prank videos"],
        exceptions: ["short study breaks with instrumental music"],
        mode: "focus",
      },
      videos: [
        { videoId: "lab-polity", title: "Fundamental Rights Explained for UPSC", channel: "Civil Service Classroom", duration: "22:10", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-news", title: "India's New Energy Policy: Context and Analysis", channel: "Policy Desk", duration: "16:20", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-gossip", title: "Biggest Bollywood Breakups This Year", channel: "Star Flash", duration: "9:11", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-map", title: "Indian Monsoon Map Practice", channel: "Geography Studio", duration: "13:45", isShort: false, isLive: false, isPremiere: false }
      ],
    },
    design: {
      profile: {
        goal: "Improve my product design skills by studying interaction patterns, research methods, and accessible interfaces.",
        usefulTopics: ["UX research", "interaction design", "accessibility", "design systems"],
        unwantedTopics: ["AI art compilations", "celebrity content", "gaming streams"],
        exceptions: ["software release news for design tools"],
        mode: "balanced",
      },
      videos: [
        { videoId: "lab-research", title: "How to Plan a Usability Study", channel: "Research Practice", duration: "15:12", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-a11y", title: "Keyboard Navigation Patterns That Actually Work", channel: "Inclusive Interfaces", duration: "19:08", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-tools", title: "Figma's New Prototyping Features Explained", channel: "Design Tool News", duration: "10:33", isShort: false, isLive: false, isPremiere: false },
        { videoId: "lab-stream", title: "Late Night Ranked Gaming Stream", channel: "Level Up Live", duration: "2:04:10", isShort: false, isLive: true, isPremiere: false }
      ],
    },
  };

  var elements = {
    modelState: document.getElementById("modelState"),
    runTest: document.getElementById("runTest"),
    resetFixture: document.getElementById("resetFixture"),
    scenario: document.getElementById("scenario"),
    goal: document.getElementById("goal"),
    usefulTopics: document.getElementById("usefulTopics"),
    unwantedTopics: document.getElementById("unwantedTopics"),
    exceptions: document.getElementById("exceptions"),
    mode: document.getElementById("mode"),
    videosJson: document.getElementById("videosJson"),
    videoCount: document.getElementById("videoCount"),
    formError: document.getElementById("formError"),
    traceList: document.getElementById("traceList"),
    traceNote: document.getElementById("traceNote"),
    runState: document.getElementById("runState"),
    totalLatency: document.getElementById("totalLatency"),
    sessionLatency: document.getElementById("sessionLatency"),
    inferenceLatency: document.getElementById("inferenceLatency"),
    validationLatency: document.getElementById("validationLatency"),
    assessmentSummary: document.getElementById("assessmentSummary"),
    classifierMeta: document.getElementById("classifierMeta"),
    assessmentRows: document.getElementById("assessmentRows"),
    requestOutput: document.getElementById("requestOutput"),
    rawOutput: document.getElementById("rawOutput"),
    historySummary: document.getElementById("historySummary"),
    historyList: document.getElementById("historyList"),
    clearHistory: document.getElementById("clearHistory"),
  };

  var history = [];
  var activeTrace = {};
  var activeProfile = null;

  function parseList(value) {
    var seen = {};
    return String(value || "").split(",").map(function (item) {
      return item.trim();
    }).filter(function (item) {
      var key = item.toLowerCase();
      if (!item || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function formatJson(value) {
    return JSON.stringify(value, null, 2);
  }

  function formatDuration(value) {
    return typeof value === "number" ? value.toLocaleString() + " ms" : "—";
  }

  function scenarioLabel(value) {
    var option = Array.prototype.find.call(elements.scenario.options, function (item) {
      return item.value === value;
    });
    return option ? option.textContent : value;
  }

  function applyFixture(fixture) {
    elements.goal.value = fixture.profile.goal || "";
    elements.usefulTopics.value = (fixture.profile.usefulTopics || []).join(", ");
    elements.unwantedTopics.value = (fixture.profile.unwantedTopics || []).join(", ");
    elements.exceptions.value = (fixture.profile.exceptions || []).join(", ");
    elements.mode.value = fixture.profile.mode === "balanced" ? "balanced" : "focus";
    elements.videosJson.value = formatJson(fixture.videos || []);
    elements.formError.textContent = "";
    updateVideoCount();
  }

  function activeProfileFixture() {
    var profile = activeProfile || FIXTURES.interview.profile;
    return {
      profile: {
        goal: profile.goal || FIXTURES.interview.profile.goal,
        usefulTopics: profile.usefulTopics || [],
        unwantedTopics: profile.unwantedTopics || [],
        exceptions: profile.exceptions || [],
        mode: profile.mode || "focus",
      },
      videos: FIXTURES.interview.videos,
    };
  }

  function selectedFixture() {
    return elements.scenario.value === "active"
      ? activeProfileFixture()
      : FIXTURES[elements.scenario.value] || FIXTURES.interview;
  }

  function updateVideoCount() {
    try {
      var parsed = JSON.parse(elements.videosJson.value);
      elements.videoCount.textContent = Array.isArray(parsed) ? parsed.length + " videos" : "Invalid JSON";
    } catch (_error) {
      elements.videoCount.textContent = "Invalid JSON";
    }
  }

  function buildRequest() {
    var goal = elements.goal.value.trim();
    if (goal.length < 3) throw new Error("Enter a goal with at least 3 characters.");

    var videos;
    try {
      videos = JSON.parse(elements.videosJson.value);
    } catch (error) {
      throw new Error("Video candidates must be valid JSON: " + error.message);
    }
    if (!Array.isArray(videos) || videos.length < 1 || videos.length > 12) {
      throw new Error("Video candidates must be an array containing 1–12 videos.");
    }

    var ids = {};
    videos.forEach(function (video, index) {
      if (!video || typeof video.videoId !== "string" || !video.videoId.trim()) {
        throw new Error("Video " + (index + 1) + " needs a videoId.");
      }
      if (ids[video.videoId]) throw new Error("Duplicate videoId: " + video.videoId);
      ids[video.videoId] = true;
      if (typeof video.title !== "string" || !video.title.trim()) {
        throw new Error("Video " + (index + 1) + " needs a title.");
      }
    });

    return {
      requestId: "lab-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      profile: {
        id: "classifier-lab",
        version: 1,
        goal: goal,
        usefulTopics: parseList(elements.usefulTopics.value),
        unwantedTopics: parseList(elements.unwantedTopics.value),
        exceptions: parseList(elements.exceptions.value),
        languages: ["English"],
        mode: elements.mode.value === "balanced" ? "balanced" : "focus",
      },
      videos: videos,
    };
  }

  function resetTrace() {
    activeTrace = {};
    elements.traceList.textContent = "";
    STAGES.forEach(function (definition, index) {
      var item = document.createElement("li");
      item.className = "trace-item pending";
      item.dataset.stage = definition.id;

      var marker = document.createElement("span");
      marker.className = "trace-marker";
      marker.textContent = String(index + 1);

      var copy = document.createElement("div");
      copy.className = "trace-copy";
      var label = document.createElement("strong");
      label.textContent = definition.label;
      var detail = document.createElement("span");
      detail.textContent = definition.detail;
      copy.append(label, detail);

      var duration = document.createElement("span");
      duration.className = "trace-duration";
      duration.textContent = "—";
      item.append(marker, copy, duration);
      elements.traceList.appendChild(item);
    });
    elements.traceNote.textContent = "Waiting for a controlled run.";
  }

  function handleStage(event) {
    activeTrace[event.id] = Object.assign({}, activeTrace[event.id] || {}, event);
    var item = elements.traceList.querySelector('[data-stage="' + event.id + '"]');
    if (!item) return;
    item.className = "trace-item " + event.status;
    item.querySelector(".trace-copy span").textContent = event.detail || "";
    item.querySelector(".trace-duration").textContent = formatDuration(event.durationMs);
    elements.traceNote.textContent = event.status === "failed"
      ? "Stopped at " + event.id + ": " + event.detail
      : "Current stage: " + event.id;
  }

  function setRunState(value, text) {
    elements.runState.className = "run-state " + value;
    elements.runState.textContent = text;
  }

  function clearLatestResult() {
    elements.totalLatency.textContent = "—";
    elements.sessionLatency.textContent = "—";
    elements.inferenceLatency.textContent = "—";
    elements.validationLatency.textContent = "—";
    elements.assessmentSummary.textContent = "Classification is running…";
    elements.classifierMeta.textContent = "Provider — · Model — · Prompt —";
    elements.assessmentRows.textContent = "";
    var row = document.createElement("tr");
    row.className = "empty-row";
    var cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "Waiting for structured model output…";
    row.appendChild(cell);
    elements.assessmentRows.appendChild(row);
    elements.rawOutput.textContent = "Waiting for model output…";
  }

  function semanticClass(value) {
    if (["directly_useful", "supporting", "no", "sufficient"].indexOf(value) !== -1) return "good";
    if (["unrelated", "yes"].indexOf(value) !== -1) return "bad";
    return "warn";
  }

  function renderAssessments(request, response) {
    var videos = {};
    request.videos.forEach(function (video) { videos[video.videoId] = video; });
    elements.assessmentRows.textContent = "";

    response.assessments.forEach(function (assessment) {
      var video = videos[assessment.videoId] || { title: assessment.videoId, channel: "" };
      var row = document.createElement("tr");

      var videoCell = document.createElement("td");
      videoCell.className = "video-cell";
      var title = document.createElement("strong");
      title.textContent = video.title;
      var metadata = document.createElement("span");
      metadata.textContent = assessment.videoId + (video.channel ? " · " + video.channel : "");
      videoCell.append(title, metadata);
      row.appendChild(videoCell);

      [assessment.contentPurpose, assessment.goalRelevance, assessment.unwantedMatch].forEach(function (value) {
        var cell = document.createElement("td");
        var label = document.createElement("span");
        label.className = "semantic-value " + semanticClass(value);
        label.textContent = value;
        cell.appendChild(label);
        row.appendChild(cell);
      });

      var evidenceCell = document.createElement("td");
      if (assessment.evidence.length) {
        var evidenceList = document.createElement("ul");
        evidenceList.className = "evidence-list";
        assessment.evidence.forEach(function (evidence) {
          var item = document.createElement("li");
          item.textContent = evidence;
          evidenceList.appendChild(item);
        });
        evidenceCell.appendChild(evidenceList);
      } else {
        evidenceCell.textContent = "No evidence returned";
      }
      row.appendChild(evidenceCell);

      var reasonCell = document.createElement("td");
      reasonCell.textContent = assessment.reason;
      row.appendChild(reasonCell);
      elements.assessmentRows.appendChild(row);
    });
  }

  function renderResult(request, response) {
    elements.totalLatency.textContent = formatDuration(response.timing.totalMs);
    elements.sessionLatency.textContent = formatDuration(response.timing.sessionCreateMs);
    elements.inferenceLatency.textContent = formatDuration(response.timing.inferenceMs);
    elements.validationLatency.textContent = formatDuration(response.timing.validationMs);
    elements.classifierMeta.textContent = "Provider " + response.classifier.provider +
      " · Model " + response.classifier.model +
      " · Prompt " + response.classifier.promptVersion;

    var diagnostics = response.diagnostics;
    var issues = diagnostics.missingAssessmentCount + diagnostics.duplicateAssessmentCount + diagnostics.unexpectedAssessmentCount;
    elements.assessmentSummary.textContent = diagnostics.acceptedAssessmentCount + "/" +
      diagnostics.requestedAssessmentCount + " accepted · " +
      (issues ? issues + " validation issue(s)" : "no validation fallbacks");
    elements.rawOutput.textContent = diagnostics.rawOutput || "No raw output retained.";
    renderAssessments(request, response);
  }

  function traceEvents() {
    return STAGES.map(function (stageDefinition) {
      return activeTrace[stageDefinition.id];
    }).filter(Boolean);
  }

  function saveHistory(record) {
    history.unshift(record);
    history = history.slice(0, 20);
    return chrome.storage.local.set({ classifierLabRuns: history }).then(renderHistory);
  }

  function renderHistory() {
    elements.historyList.textContent = "";
    if (!history.length) {
      var empty = document.createElement("p");
      empty.className = "empty-message";
      empty.textContent = "No retained runs.";
      elements.historyList.appendChild(empty);
      elements.historySummary.textContent = "Stored locally · latest 20";
      return;
    }

    var successful = history.filter(function (record) { return record.status === "complete"; });
    var average = successful.length
      ? Math.round(successful.reduce(function (sum, record) { return sum + record.response.timing.totalMs; }, 0) / successful.length)
      : null;
    elements.historySummary.textContent = history.length + " runs · " + successful.length + " complete" +
      (average !== null ? " · " + average.toLocaleString() + " ms avg" : "");

    history.forEach(function (record, index) {
      var item = document.createElement("div");
      item.className = "history-run";
      var copy = document.createElement("div");
      var title = document.createElement("strong");
      title.textContent = record.scenario + " · " + record.status;
      var meta = document.createElement("span");
      var latency = record.response && record.response.timing ? formatDuration(record.response.timing.totalMs) : "failed";
      meta.textContent = new Date(record.startedAt).toLocaleString() + " · " + record.request.videos.length + " videos · " + latency;
      copy.append(title, meta);
      var inspect = document.createElement("button");
      inspect.type = "button";
      inspect.dataset.historyIndex = String(index);
      inspect.textContent = "Inspect";
      item.append(copy, inspect);
      elements.historyList.appendChild(item);
    });
  }

  function inspectHistory(index) {
    var record = history[index];
    if (!record) return;
    elements.requestOutput.textContent = formatJson(record.request);
    resetTrace();
    (record.trace || []).forEach(handleStage);
    if (record.response) {
      renderResult(record.request, record.response);
      setRunState("complete", "Historical run");
      elements.traceNote.textContent = "Displaying retained trace from " + new Date(record.startedAt).toLocaleString() + ".";
    } else {
      setRunState("failed", "Historical failure");
      elements.assessmentSummary.textContent = record.error || "Classification failed.";
      elements.rawOutput.textContent = record.error || "No model output.";
    }
  }

  async function runTest() {
    elements.formError.textContent = "";
    var request;
    try {
      request = buildRequest();
    } catch (error) {
      elements.formError.textContent = error.message;
      return;
    }

    var startedAt = new Date().toISOString();
    resetTrace();
    clearLatestResult();
    elements.requestOutput.textContent = formatJson(request);
    elements.runTest.disabled = true;
    setRunState("running", "Running");

    try {
      var response = await FocusFeedLocalClassifier.classify(request, { onStage: handleStage });
      renderResult(request, response);
      setRunState("complete", "Complete");
      elements.traceNote.textContent = "Trace complete. Raw and normalized outputs are retained locally.";
      await saveHistory({
        id: request.requestId,
        scenario: scenarioLabel(elements.scenario.value),
        status: "complete",
        startedAt: startedAt,
        request: request,
        response: response,
        trace: traceEvents(),
      });
    } catch (error) {
      setRunState("failed", "Failed");
      elements.assessmentSummary.textContent = error && error.message || "Local classification failed.";
      elements.rawOutput.textContent = error && error.stack || String(error);
      await saveHistory({
        id: request.requestId,
        scenario: scenarioLabel(elements.scenario.value),
        status: "failed",
        startedAt: startedAt,
        request: request,
        response: null,
        error: error && error.message || String(error),
        trace: traceEvents(),
      });
    } finally {
      elements.runTest.disabled = false;
      refreshModelStatus();
    }
  }

  async function refreshModelStatus() {
    try {
      var status = await FocusFeedLocalClassifier.availability();
      elements.modelState.textContent = "Model: local · " + status;
      elements.modelState.className = "model-state " + status;
      elements.runTest.disabled = status !== "available";
    } catch (error) {
      elements.modelState.textContent = error.message;
      elements.modelState.className = "model-state unavailable";
      elements.runTest.disabled = true;
    }
  }

  function copyOutput(id, button) {
    var target = document.getElementById(id);
    if (!target) return;
    navigator.clipboard.writeText(target.textContent).then(function () {
      var original = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = original; }, 1200);
    });
  }

  elements.scenario.addEventListener("change", function () { applyFixture(selectedFixture()); });
  elements.resetFixture.addEventListener("click", function () { applyFixture(selectedFixture()); });
  elements.videosJson.addEventListener("input", updateVideoCount);
  elements.runTest.addEventListener("click", runTest);
  elements.clearHistory.addEventListener("click", function () {
    history = [];
    chrome.storage.local.remove("classifierLabRuns").then(renderHistory);
  });
  elements.historyList.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-history-index]");
    if (button) inspectHistory(parseInt(button.dataset.historyIndex, 10));
  });
  document.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-copy]");
    if (!button) return;
    event.preventDefault();
    copyOutput(button.dataset.copy, button);
  });

  Promise.all([
    chrome.storage.local.get({ activeProfile: null }),
    chrome.storage.local.get({ classifierLabRuns: [] }),
  ]).then(function (results) {
    activeProfile = results[0].activeProfile;
    history = Array.isArray(results[1].classifierLabRuns) ? results[1].classifierLabRuns : [];
    applyFixture(FIXTURES.interview);
    resetTrace();
    renderHistory();
    refreshModelStatus();
  });
})();
