(function () {
  "use strict";

  var VALIDATION_KEY = "focusfeedObjectiveValidationV1";
  var LEARNING_KEYS = ["focusfeedChannelProfilesV1", "focusfeedCorrectionsV1", "focusfeedChannelInvestigationsV1", "focusfeedSettingsV2", "classifierEndpoint", "focusFeedChannelBlocksV1"];
  var latest = {};
  var refreshSerial = 0;
  var refreshTimer = null;

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
    $("objectiveRequest").textContent = "No request recorded yet.";
    if (!snapshot || (!snapshot.response && !snapshot.error)) {
      $("objectiveMeta").textContent = "No validation yet";
      emptyRow(target, 5, "Validate an intent from the FocusFeed popup.");
      return;
    }
    if (snapshot.error) {
      $("objectiveMeta").textContent = "Validation failed";
      $("objectiveError").hidden = false;
      $("objectiveError").textContent = snapshot.error.message || "Jev objective validation failed.";
      emptyRow(target, 5, "No validated objective judgments were returned.");
      return;
    }
    var response = snapshot.response;
    var usage = response && response.diagnostics && response.diagnostics.usage || {};
    var diagnostics = response.diagnostics || {};
    var threshold = diagnostics.thresholds && diagnostics.thresholds.nonsenseProbability;
    if (typeof threshold !== "number") threshold = 0.7;
    $("objectiveRequest").textContent = diagnostics.jevRequest ? JSON.stringify(diagnostics.jevRequest, null, 2) : "This older snapshot did not record the question. Validate changed topics to see the current request.";
    $("objectiveMeta").textContent =
      (response.classifier && response.classifier.model || "Jev") + " · " +
      (response.objectives || []).length + " objectives · " +
      (usage.input_tokens || 0) + " input tokens";
    (response.objectives || []).forEach(function (objective) {
      var row = document.createElement("tr");
      cell(row, objective.text);
      cell(row, objective.status, objective.status === "ready_for_confirmation" ? "show" : "hide");
      cell(row, objective.validatedObjective ? "Exact user preference" : "Clarification required");
      cell(row, percent(objective.nonsenseProbability), objective.nonsenseProbability >= threshold ? "hide" : "show");
      cell(row, objective.reason || "No reason recorded.");
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
      link.href = record.video.itemType === "collection" ? "https://www.youtube.com/playlist?list=" + encodeURIComponent(record.video.collectionId) : "https://www.youtube.com/watch?v=" + encodeURIComponent(record.video.videoId);
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
            label: match.text + (match.labelSource === "user" ? " [your correction]" : " [" + match.contentType + "]"),
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
      if (record.route === "user_correction" || record.route === "channel_topic" || record.route === "collection_block") {
        var policy = document.createElement("small");
        policy.textContent = record.route === "user_correction" ? "Your personal correction determines this action; any model score below is the original judgment." : record.route === "collection_block" ? "You hid this collection. Its videos and creators were not labeled." : "A learned channel rule determines this action; any video score below is the original judgment.";
        reason.appendChild(policy);
      }
      if (record.assessment) {
        var outcome = document.createElement("small");
        outcome.textContent = "Original model outcome: " + record.assessment.outcome;
        reason.appendChild(outcome);
        var evidence = document.createElement("small");
        evidence.textContent = (record.assessment.evidence || []).join("; ");
        reason.appendChild(evidence);
      }
      target.appendChild(row);
    });
  }

  function investigationStatus(trace) {
    if (!trace) return "No investigation recorded";
    if (trace.status === "learned") return (trace.judgments || []).some(function (j) { return j.blockChannel; }) ? "Channel match established" : "No channel match established";
    return { queued: "Queued", running: "Checking", shared: "Sharing a channel check", failed: "Failed", deferred: "Deferred", cached: "Cached judgments", cancelled: "Cancelled", superseded: "Superseded" }[trace.status] || trace.status;
  }
  function renderChannels(data) {
    data = data || { profiles: [], corrections: {}, investigations: [] };
    var search = $("channelFilter").value.trim().toLowerCase();
    function includes(value) { return !search || JSON.stringify(value).toLowerCase().includes(search); }
    var corrections = data.corrections || {}, traces = data.investigations || [];
    var items = (corrections.items || []).concat(corrections.collections || []).filter(includes).sort(function (a, b) { return b.createdAt - a.createdAt; });
    var target = $("corrections"); target.textContent = "";
    items.forEach(function (item) {
      var row = document.createElement("tr");
      cell(row, (item.itemType === "collection" ? "Collection: " : "") + (item.title || item.videoId));
      cell(row, item.topic ? (item.match ? "Matches: " : "Does not match: ") + item.topic : "Hide this collection");
      var event = (corrections.history || []).find(function (e) { return e.id === item.id && e.type === "correction"; });
      var original = event && event.modelAssessment && (event.modelAssessment.objectiveMatches || []).find(function (m) { return m.text === item.topic && m.labelSource !== "user"; });
      cell(row, original ? percent(original.matchProbability) : "Not recorded");
      var investigation = traces.slice().reverse().find(function (t) { return t.triggerId === item.id; });
      cell(row, item.itemType === "collection" ? "Collection only · no channel check" : item.match === false ? "Not requested for this negative correction" : investigationStatus(investigation));
      target.appendChild(row);
    });
    if (!items.length) emptyRow(target, 4, "No saved corrections match this filter.");

    var table = $("channelInvestigations");
    var open = new Set(Array.from(table.querySelectorAll("details[open]")).map(function (d) { return d.dataset.investigationId; }));
    table.textContent = "";
    var rows = traces.filter(includes).slice().reverse();
    (data.profiles || []).forEach(function (p) {
      if (traces.some(function (t) { return t.channelId === p.channelId; }) || !includes(p)) return;
      rows.push({ id: "saved-" + p.channelId, channelId: p.channelId, channelLabel: p.title, status: "cached", stage: "saved_profile",
        topics: (p.judgments || []).map(function (j) { return { text: j.text }; }), judgments: p.judgments || [], evidence: p,
        reason: "Saved channel judgments are available, but this older check has no investigation trace." });
    });
    rows.forEach(function (trace) {
      var row = document.createElement("tr"), channel = cell(row, trace.channelLabel || trace.channelId || "Channel unresolved");
      var identity = document.createElement("small"); identity.textContent = trace.channelId || "No verified channel ID"; channel.appendChild(identity);
      if (trace.video) { var title = document.createElement("small"); title.textContent = trace.video.title || trace.video.videoId; channel.appendChild(title); }
      cell(row, (trace.topics || []).map(function (t) { return t.text; }).join("; ") + " · " + (trace.triggerId ? "your correction" : "automatic / saved"));
      var state = cell(row, investigationStatus(trace));
      var stage = document.createElement("small"); stage.textContent = trace.stage || ""; state.appendChild(stage);
      if (trace.error) { var error = document.createElement("small"); error.className = "hide"; error.textContent = trace.error.message; state.appendChild(error); }
      var scores = cell(row);
      if (!(trace.judgments || []).length) scores.textContent = "No accepted channel judgments";
      (trace.judgments || []).forEach(function (j) {
        var label = document.createElement("small"); label.textContent = j.text + " · " + (j.blockChannel ? "passes channel thresholds" : "does not establish a channel rule"); scores.appendChild(label);
        scoreList(scores, [{ label: "Dominant match", value: j.dominantProbability, yesThreshold: .5 }]);
        var expiry = document.createElement("small"); expiry.textContent = "Expires: " + (j.expiresAt ? new Date(j.expiresAt).toLocaleString() : "not recorded"); scores.appendChild(expiry);
      });
      var detailsCell = cell(row, trace.reason || "");
      var details = document.createElement("details"); details.dataset.investigationId = trace.id;
      if (open.has(trace.id)) details.setAttribute("open", "");
      var summary = document.createElement("summary"); summary.textContent = "Evidence, exact requests and responses";
      var pre = document.createElement("pre"); pre.className = "request-details"; pre.textContent = JSON.stringify(trace, null, 2);
      details.append(summary, pre); detailsCell.appendChild(details); table.appendChild(row);
    });
    if (!rows.length) emptyRow(table, 5, "No channel investigations match this filter. Older failed checks cannot be reconstructed.");
    $("channelMeta").textContent = traces.length + " recent investigations · " + (data.profiles || []).length + " saved channel profiles";
  }

  async function refresh() {
    var serial = ++refreshSerial;
    var values = await chrome.storage.local.get([VALIDATION_KEY].concat(LEARNING_KEYS));
    var tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
    var snapshots = await Promise.all(tabs.map(async function (tab) {
      try {
        var response = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATS" });
        return response && response.runtime ? { tabId: tab.id, runtime: response.runtime } : null;
      } catch (_) { return null; }
    }));
    var requests = null;
    try { var response = await chrome.runtime.sendMessage({ type: "FF_REQUEST_STATS" }); if (response && response.ok) requests = response.data; } catch (_) {}
    if (serial !== refreshSerial) return;
    latest = { schemaVersion: 2, validation: values[VALIDATION_KEY] || null, tabs: snapshots.filter(Boolean), requests: requests, updatedAt: Date.now(),
      channelLearning: { profiles: values.focusfeedChannelProfilesV1 || [], corrections: values.focusfeedCorrectionsV1 || {},
        investigations: values.focusfeedChannelInvestigationsV1 || [], settings: values.focusfeedSettingsV2 || null,
        endpoint: values.classifierEndpoint || "http://127.0.0.1:3000", explicitBlocks: values.focusFeedChannelBlocksV1 || [] } };
    var counts = requests && requests.metrics;
    $("requestMeta").textContent = counts ? counts.httpAttempts + " classifier HTTP attempts · " + counts.httpFailed + " failed · " +
      counts.providerCalls + " Jev calls · " + counts.providerQuestions + " Jev questions · " + counts.localHits + " local pair reuses · " + counts.sharedPairs + " in-flight pair shares · " + counts.inputTokens + "/" + counts.outputTokens + " Jev tokens" : "Request counters unavailable; reload the extension.";
    $("requestHistory").textContent = JSON.stringify(requests && requests.requests || [], null, 2);
    renderObjectives(latest.validation); renderVideos(latest.tabs);
    renderChannels(latest.channelLearning);
    if (requests) $("runMeta").textContent = latest.tabs.length + " tabs · " + latest.tabs.reduce(function (n, tab) { return n + tab.runtime.records.length; }, 0) + " recent items · request totals above count shared work once";
    $("updated").textContent = "Updated " + new Date(latest.updatedAt).toLocaleTimeString();
  }

  $("refresh").addEventListener("click", refresh);
  $("channelFilter").addEventListener("input", function () { renderChannels(latest.channelLearning); });
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
    if (area !== "local" || ![VALIDATION_KEY].concat(LEARNING_KEYS).some(function (key) { return changes[key]; })) return;
    if (!refreshTimer) refreshTimer = setTimeout(function () { refreshTimer = null; refresh().catch(function () {}); }, 100);
  });
  setInterval(function () { refresh().catch(function () {}); }, 5000);
  refresh().catch(function () {});
})();
