(function () {
  "use strict";

  var VALIDATION_KEY = "focusfeedObjectiveValidationV1";
  var latest = {};

  function $(id) { return document.getElementById(id); }
  function percent(value) {
    return typeof value === "number" && isFinite(value)
      ? (value * 100).toFixed(1) + "%"
      : "—";
  }
  function cell(row, text, className) {
    var element = document.createElement("td");
    element.textContent = text || "";
    if (className) element.className = className;
    row.appendChild(element);
    return element;
  }
  function emptyRow(target, columns, message) {
    var row = document.createElement("tr");
    var element = cell(row, message, "empty");
    element.colSpan = columns;
    target.appendChild(row);
  }
  function scoreClass(value, yesThreshold, noThreshold) {
    if (typeof value !== "number") return "uncertain";
    var yes = typeof yesThreshold === "number" ? yesThreshold : 0.6;
    var no = typeof noThreshold === "number" ? noThreshold : 0.2;
    if (value >= yes) return "yes";
    if (value <= no) return "no";
    return "uncertain";
  }
  function scoreList(target, items) {
    var list = document.createElement("div");
    list.className = "score-list";
    items.forEach(function (item) {
      var line = document.createElement("div");
      line.className = "score " + scoreClass(item.value, item.yesThreshold, item.noThreshold);
      var label = document.createElement("span");
      label.textContent = item.label;
      var value = document.createElement("strong");
      value.textContent = percent(item.value);
      line.appendChild(label);
      line.appendChild(value);
      list.appendChild(line);
    });
    target.appendChild(list);
  }

  function renderObjectives(snapshot) {
    var target = $("objectives");
    target.textContent = "";
    $("objectiveError").hidden = true;
    if (!snapshot || (!snapshot.response && !snapshot.error)) {
      $("objectiveMeta").textContent = "No validation yet";
      emptyRow(target, 6, "Validate an intent from the FocusFeed popup.");
      return;
    }
    if (snapshot.error) {
      $("objectiveMeta").textContent = "Validation failed";
      $("objectiveError").hidden = false;
      $("objectiveError").textContent = snapshot.error.message || "Jev objective validation failed.";
      emptyRow(target, 6, "No validated objective judgments were returned.");
      return;
    }
    var response = snapshot.response;
    var usage = response && response.diagnostics && response.diagnostics.usage || {};
    var objectiveThresholds = response && response.diagnostics && response.diagnostics.thresholds ||
      { matchableProbability: 0.7, understoodProbability: 0.7 };
    $("objectiveMeta").textContent =
      (response.classifier && response.classifier.model || "Jev") + " · " +
      (response.objectives || []).length + " objectives · " +
      (usage.input_tokens || 0) + " input tokens";
    (response.objectives || []).forEach(function (objective) {
      var row = document.createElement("tr");
      cell(row, objective.text);
      cell(row, objective.status, objective.status === "ready_for_confirmation" ? "show" : "hide");
      cell(row, objective.validatedObjective ? "Exact user preference" : "Clarification required");
      cell(row, percent(objective.matchableProbability),
        scoreClass(objective.matchableProbability, objectiveThresholds.matchableProbability));
      cell(row, percent(objective.understoodProbability),
        scoreClass(objective.understoodProbability, objectiveThresholds.understoodProbability));
      var probabilities = cell(row);
      scoreList(probabilities, [
        { label: "Understandable", value: objective.understoodProbability, yesThreshold: objectiveThresholds.understoodProbability },
        { label: "Matchable", value: objective.matchableProbability, yesThreshold: objectiveThresholds.matchableProbability },
      ]);
      target.appendChild(row);
    });
  }

  function renderVideos(tabs) {
    var target = $("videos"); target.textContent = "";
    if (!tabs.length) {
      $("runMeta").textContent = "No connected YouTube tab";
      emptyRow(target, 5, "Open YouTube to see automatic filtering decisions."); return;
    }
    var records = tabs.flatMap(function (tab) { return tab.runtime.records; });
    var inputTokens = tabs.reduce(function (n, tab) { return n + (tab.runtime.metrics && tab.runtime.metrics.inputTokens || 0); }, 0);
    var outputTokens = tabs.reduce(function (n, tab) { return n + (tab.runtime.metrics && tab.runtime.metrics.outputTokens || 0); }, 0);
    $("runMeta").textContent = tabs.length + " tabs · " + records.length + " recent videos · " + inputTokens + "/" + outputTokens + " Jev tokens";
    var videoThresholds = { matchYes: 0.5, matchNo: 0.2 };
    records.forEach(function (record) {
      var row = document.createElement("tr");
      var video = cell(row);
      var link = document.createElement("a");
      link.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(record.video.videoId);
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = record.video.title || record.video.videoId;
      video.appendChild(link);
      var channel = document.createElement("small");
      channel.textContent = (record.video.channel || "Unknown channel") + " · " + record.video.videoId;
      video.appendChild(channel);

      cell(row, record.action || "—", record.action === "hide" ? "hide" : "show");
      cell(row, (record.route || "—") + " · " + (record.status || "—"));

      var matches = cell(row);
      if (record.assessment && Array.isArray(record.assessment.objectiveMatches)) {
        scoreList(matches, record.assessment.objectiveMatches.map(function (match) {
          return {
            label: match.text + " [" + match.contentType + "]",
            value: match.matchProbability,
            yesThreshold: videoThresholds.matchYes,
            noThreshold: videoThresholds.matchNo,
          };
        }));
      } else {
        matches.textContent = record.route === "channel_block"
          ? "User-confirmed channel block; Jev was not called."
          : "No complete Jev judgment.";
      }

      var reason = cell(row, record.reason || "");
      if (record.assessment) {
        var outcome = document.createElement("small");
        outcome.textContent = "Computed outcome: " + record.assessment.outcome;
        reason.appendChild(outcome);
        var evidence = document.createElement("small");
        evidence.textContent = (record.assessment.evidence || []).join("; ");
        reason.appendChild(evidence);
      }
      target.appendChild(row);
    });
  }

  async function refresh() {
    var values = await chrome.storage.local.get([VALIDATION_KEY]);
    var tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
    var snapshots = await Promise.all(tabs.map(async function (tab) {
      try {
        var response = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATS" });
        return response && response.runtime ? { tabId: tab.id, runtime: response.runtime } : null;
      } catch (_) { return null; }
    }));
    latest = { validation: values[VALIDATION_KEY] || null, tabs: snapshots.filter(Boolean), updatedAt: Date.now() };
    renderObjectives(latest.validation); renderVideos(latest.tabs);
    $("updated").textContent = "Updated " + new Date(latest.updatedAt).toLocaleTimeString();
  }

  $("refresh").addEventListener("click", refresh);
  $("export").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "focusfeed-jev-observability-" + Date.now() + ".json";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes[VALIDATION_KEY]) return;
    refresh();
  });
  setInterval(function () { refresh().catch(function () {}); }, 5000);
  refresh().catch(function () {});
})();
