(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var tabId = Number(new URLSearchParams(location.search).get("tab"));
  var port = null;
  var engine = null;
  var prefs = null;
  var identity = null;
  var ready = false;
  var connected = false;
  var connectionAttempt = null;
  var lastConnectionError = null;
  var busy = false;
  var starting = false;
  var releaseLock = null;
  var runId = null;
  var rows = new Map();
  var reviews = {};
  var displayState = {};
  var displayEvents = [];
  var providerStages = [];
  var renderTimer = null;
  var observabilityTimer = null;
  var providerTasks = new Set();
  var settingsVersion = 0;
  var TAXONOMY_VERSION = "focusfeed-topics-v1";
  var channelEvidence = {};
  var pendingChannelSuggestions = new Map();

  function status(text) { $("status").textContent = text; }
  function send(message) {
    if (port) port.postMessage(Object.assign({ runId: runId }, message));
  }

  function controls() {
    var running = Boolean(engine && !engine.report().stopped);
    $("retry").hidden = running || starting || busy || providerTasks.size > 0;
    $("retry").disabled = starting || busy || providerTasks.size > 0 || running;
    $("stop").disabled = !running;
    $("export").disabled = !engine;
  }

  function observabilitySnapshot() {
    if (!engine) return null;
    return {
      schemaVersion: "focusfeed-live-observability-v1",
      savedAt: Date.now(),
      report: engine.report(),
      displayState: displayState,
      displayEvents: displayEvents,
      providerStages: providerStages,
      reviews: reviews,
    };
  }

  function persistObservability() {
    observabilityTimer = null;
    var snapshot = observabilitySnapshot();
    if (snapshot) chrome.storage.local.set({ focusfeedLiveObservabilityV1: snapshot });
  }

  function scheduleObservability() {
    if (!observabilityTimer) observabilityTimer = setTimeout(persistObservability, 100);
  }

  function render() {
    renderTimer = null;
    if (!engine) { controls(); return; }
    var report = engine.report();
    var counts = report.counts;
    var budget = report.budget;
    $("admitted").textContent = report.records.length + " / " + budget.allowance;
    $("resolved").textContent = (counts.model || 0) + " / " + (counts.channel_block || 0) + " / " +
      (counts.model_pending || 0) + " / " +
      ((counts.unresolved || 0) + (counts.deferred || 0) + (counts.metadata || 0));
    $("calls").textContent = budget.calls + " / " + budget.callBudget;
    $("videos").textContent = budget.modelVideos + " / " + budget.modelVideoBudget;
    $("queue").textContent = report.scheduler.queueDepth + " / " + report.scheduler.inFlightRequests;
    $("display").textContent = (displayState.hiddenCards || 0) + " / " +
      (displayState.gate && displayState.gate.waiting || 0);
    var p95 = report.scheduler.timing.providerMs.p95;
    $("latency").textContent = p95 === null ? "—" : (p95 / 1000).toFixed(1) + " s";
    if (!report.stopped) {
      send({
        type: "STATS",
        counts: counts,
        budget: budget,
        queueDepth: report.scheduler.queueDepth,
      });
    }
    controls();
  }

  function scheduleRender() {
    if (!renderTimer) renderTimer = setTimeout(render, 80);
    scheduleObservability();
  }

  function percent(value) {
    return typeof value === "number" ? Math.round(value * 100) + "%" : "—";
  }

  function saveChannelEvidence() {
    chrome.storage.local.set({ focusFeedChannelEvidenceV1: channelEvidence });
  }

  function renderChannelSuggestions() {
    var panel = $("channelSuggestionsPanel");
    var target = $("channelSuggestions");
    target.textContent = "";
    panel.hidden = pendingChannelSuggestions.size === 0;
    pendingChannelSuggestions.forEach(function (candidate, key) {
      var card = document.createElement("article");
      card.className = "channel-suggestion";
      var title = document.createElement("strong");
      title.textContent = candidate.channelLabel;
      var detail = document.createElement("span");
      var decisive = candidate.unwanted + candidate.acceptable;
      detail.textContent = candidate.unwanted + " of " + decisive +
        " confident decisions were unwanted across " + candidate.unwantedSessionIds.length + " sessions.";
      var scope = document.createElement("span");
      scope.textContent = "Current " + candidate.mode + " topics: " + candidate.taxonomyIds.map(function (id) {
        return id.replace(/^topic\./, "").replace(/_/g, " ");
      }).join(", ");
      var actions = document.createElement("div");
      actions.className = "channel-actions";
      function button(label, handler, primary) {
        var element = document.createElement("button");
        element.className = "button" + (primary ? " primary" : "");
        element.textContent = label;
        element.addEventListener("click", handler);
        actions.appendChild(element);
      }
      function block(scopeName) {
        var block = FocusFeedChannelPolicy.createBlock(candidate, scopeName);
        prefs.focusFeedChannelBlocksV1 = (prefs.focusFeedChannelBlocksV1 || []).filter(function (item) {
          return !(item.channelId === block.channelId && item.scope === block.scope &&
            (block.scope === "global" || item.mode === block.mode) &&
            JSON.stringify(item.taxonomyIds || []) === JSON.stringify(block.taxonomyIds || []));
        });
        prefs.focusFeedChannelBlocksV1.push(block);
        pendingChannelSuggestions.delete(key);
        chrome.storage.local.set({ focusFeedChannelBlocksV1: prefs.focusFeedChannelBlocksV1 });
        if (engine) engine.addChannelBlock(block);
        renderChannelSuggestions();
        scheduleObservability();
      }
      button("Block for this intent", function () { block("topics"); }, true);
      button("Block everywhere", function () { block("global"); });
      button("Snooze 7 days", function () {
        channelEvidence = FocusFeedChannelPolicy.snooze(
          channelEvidence,
          candidate,
          Date.now() + 7 * 24 * 60 * 60 * 1000
        );
        pendingChannelSuggestions.delete(key);
        saveChannelEvidence();
        renderChannelSuggestions();
      });
      card.appendChild(title);
      card.appendChild(detail);
      card.appendChild(scope);
      card.appendChild(actions);
      target.appendChild(card);
    });
  }

  function noteChannelAssessment(record) {
    var updated = FocusFeedChannelPolicy.recordAssessment(
      channelEvidence,
      record,
      prefs.activeProfile,
      runId
    );
    channelEvidence = updated.state;
    if (updated.candidate) {
      pendingChannelSuggestions.set(updated.candidate.evidenceKey, updated.candidate);
      channelEvidence = FocusFeedChannelPolicy.markPrompted(channelEvidence, updated.candidate);
      renderChannelSuggestions();
    }
    if (record.route === "model" && record.assessment) saveChannelEvidence();
  }

  function renderRecord(record) {
    var id = record.video.videoId;
    var row = rows.get(id);
    if (!row) {
      row = document.createElement("tr");
      rows.set(id, row);
      $("results").appendChild(row);
    }
    row.textContent = "";
    function cell(text) {
      var element = document.createElement("td");
      element.textContent = text || "";
      row.appendChild(element);
      return element;
    }

    var video = cell();
    var link = document.createElement("a");
    link.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(id);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = record.video.title;
    video.appendChild(link);
    var channel = document.createElement("small");
      channel.textContent = record.video.channel + " · " + id;
    video.appendChild(channel);

    cell(record.route + " · " + (record.status === "resolved" ? record.action : record.status));
    var evidence = cell(record.reason);
    if (record.assessment) {
      var summary = document.createElement("small");
      summary.textContent = "outcome " + record.assessment.outcome +
        " · evidence " + percent(record.assessment.evidenceProbability);
      evidence.appendChild(summary);
      (record.assessment.objectiveMatches || []).forEach(function (match) {
        var score = document.createElement("small");
        score.textContent = match.text + " [" + match.contentType + "] · match " +
          percent(match.matchProbability);
        evidence.appendChild(score);
      });
      var metadata = document.createElement("small");
      metadata.textContent = (record.assessment.evidence || []).join("; ");
      evidence.appendChild(metadata);
    }

    cell(record.timing
      ? "Queue " + Math.round(record.timing.queueWaitMs) + " ms; provider " +
        (record.timing.providerMs / 1000).toFixed(1) + " s"
      : "—");

    var action = cell();
    var select = document.createElement("select");
    [["", "Not reviewed"], ["show", "Should show"], ["hide", "Should hide"], ["unclear", "Unsure"]]
      .forEach(function (pair) {
        var option = document.createElement("option");
        option.value = pair[0];
        option.textContent = pair[1];
        select.appendChild(option);
      });
    select.value = reviews[id] && reviews[id].action || "";
    select.addEventListener("change", function () {
      reviews[id] = { action: select.value, fingerprint: record.fingerprint, at: Date.now() };
      scheduleObservability();
    });
    action.appendChild(select);
    var restore = document.createElement("button");
    restore.className = "button";
    restore.textContent = "Restore on YouTube";
    restore.addEventListener("click", function () {
      send({ type: "RESTORE", videoId: id });
    });
    action.appendChild(restore);
  }

  async function loadPreferences() {
    prefs = await chrome.storage.local.get({
      enabled: true,
      activeProfile: null,
      classifierEndpoint: "http://127.0.0.1:3000",
      focusFeedChannelBlocksV1: [],
      focusFeedChannelEvidenceV1: {},
    });
    channelEvidence = prefs.focusFeedChannelEvidenceV1 || {};
    var profile = prefs.activeProfile;
    var objectiveText = profile && Array.isArray(profile.objectives)
      ? profile.objectives.map(function (objective) { return objective.text; }).join(", ")
      : "";
    $("profile").textContent = objectiveText
      ? profile.mode + " · " + objectiveText + " · profile v" + profile.version
      : "Map and confirm a feed intent in the popup first.";
    $("providerNote").textContent =
      "TypeSafe Jev supplies direct taxonomy-match probabilities. General mode keeps uncertain videos visible; Focus mode hides uncertain and non-matching videos. Hide decisions are applied automatically and every result is copied to the Jev observability tab.";
  }

  async function prepare() {
    if (busy) return false;
    busy = true;
    ready = false;
    controls();
    var preparingVersion = settingsVersion;
    try {
      await loadPreferences();
      if (!prefs.enabled) throw new Error("Enable FocusFeed in the popup first.");
      if (!prefs.activeProfile || !prefs.activeProfile.version ||
          !Array.isArray(prefs.activeProfile.objectives) ||
          !prefs.activeProfile.objectives.length) {
        throw new Error("Map and confirm your feed topics in the popup first.");
      }
      if (prefs.activeProfile.objectives.some(function (objective) {
        return !objective || objective.contentType !== "topic" || !objective.taxonomyId ||
          objective.taxonomyVersion !== TAXONOMY_VERSION;
      })) {
        throw new Error("This profile predates the current taxonomy. Remap and confirm it in the popup.");
      }
      var response = await chrome.runtime.sendMessage({ type: "CLASSIFIER_HEALTH_CHECK" });
      if (!response || !response.ok) {
        throw new Error(response && response.error.message || "Backend is unavailable.");
      }
      identity = {
        provider: response.data.provider,
        model: response.data.model,
        promptVersion: response.data.promptVersion,
        assessmentSchemaVersion: "taxonomy-match-v2",
      };
      if (preparingVersion !== settingsVersion) {
        throw new Error("Settings changed during provider preparation. Check Jev again.");
      }
      ready = true;
      status("Jev ready. Starting the first 12 recommendations on YouTube Home…");
      return true;
    } catch (error) {
      status(error.message);
      return false;
    } finally {
      busy = false;
      controls();
    }
  }

  async function executeProvider(request, signal) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    var cancel = function () {
      chrome.runtime.sendMessage({
        type: "LIVE_CLASSIFY_CANCEL",
        requestId: request.requestId,
      }).catch(function () {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      var result = await chrome.runtime.sendMessage({
        type: "LIVE_CLASSIFY_CLOUD",
        request: FocusFeedLiveProvider.cloudRequest(request),
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!result || !result.ok) {
        throw new Error(result && result.error.message || "TypeSafe Jev request failed.");
      }
      if (!result.data.diagnostics) {
        throw new Error("Restart the updated backend before live classification.");
      }
      return result.data;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  function provider(request, signal) {
    var task = executeProvider(request, signal);
    providerTasks.add(task);
    task.then(function () {
      providerTasks.delete(task);
      controls();
    }, function () {
      providerTasks.delete(task);
      controls();
    });
    return task;
  }

  function stop(message) {
    if (engine) engine.stop();
    send({ type: "STOP" });
    var release = releaseLock;
    releaseLock = null;
    if (release) {
      Promise.allSettled(Array.from(providerTasks)).then(function () {
        release();
        controls();
      });
    }
    if (message) status(message);
    render();
    persistObservability();
  }

  async function start() {
    if (starting || busy || providerTasks.size || (engine && !engine.report().stopped)) return;
    starting = true;
    controls();
    try {
      if (!ready && !await prepare()) return;
      if (!connected) {
        status("Connecting to YouTube Home…");
        if (!await connectWithRepair()) return;
      }
      busy = true;
      controls();
      var startingVersion = settingsVersion;
      var acquired = await new Promise(function (resolve, reject) {
        navigator.locks.request("focusfeed-live-session", { ifAvailable: true }, async function (lock) {
          if (!lock) {
            resolve(false);
            return;
          }
          await new Promise(function (release) {
            releaseLock = release;
            resolve(true);
          });
        }).catch(reject);
      });
      if (!acquired) throw new Error("Another live session is running. Stop it first.");
      if (startingVersion !== settingsVersion || !connected || !ready) {
        throw new Error("Settings or the YouTube connection changed before start. Check Jev again.");
      }
      runId = "live-" + Date.now() + "-" + tabId;
      rows.clear();
      reviews = {};
      displayState = {};
      displayEvents = [];
      providerStages = [];
      pendingChannelSuggestions.clear();
      renderChannelSuggestions();
      $("results").textContent = "";
      engine = FocusFeedLiveEngine.create({
        runId: runId,
        profile: prefs.activeProfile,
        classifier: identity,
        provider: provider,
        channelBlocks: prefs.focusFeedChannelBlocksV1,
        onRecord: function (record) {
          renderRecord(record);
          noteChannelAssessment(record);
          if (engine && !engine.report().stopped) send({ type: "RESULT", record: record });
          scheduleObservability();
        },
        onChange: scheduleRender,
      });
      send({ type: "START" });
      persistObservability();
      status("Session active on YouTube. AI hide decisions apply automatically; Load 12 more appears at the end of the feed.");
    } catch (error) {
      stop(error.message);
    } finally {
      busy = false;
      starting = false;
      render();
    }
  }

  function more() {
    if (!engine || engine.report().scheduler.queueDepth > 12 || !engine.loadMore()) return;
    send({ type: "MORE", allowance: engine.report().budget.allowance });
    render();
    persistObservability();
    status("Allowed up to " + engine.report().budget.allowance +
      " recommendations. At most one additional Home page may load if needed.");
  }

  function connect() {
    if (connected && port) return Promise.resolve(true);
    if (connectionAttempt) return connectionAttempt;
    if (!Number.isInteger(tabId) || tabId <= 0) {
      status("Open YouTube Home, then use Open YouTube session in the popup.");
      return Promise.resolve(false);
    }
    connectionAttempt = new Promise(function (resolve) {
      var connection;
      var settled = false;
      var timer = null;
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connectionAttempt = null;
        resolve(value);
      }
      try {
        connection = chrome.tabs.connect(tabId, { name: "focusfeed-live" });
        port = connection;
      } catch (error) {
        port = null;
        connected = false;
        lastConnectionError = error;
        status("Could not connect to YouTube. " + error.message);
        finish(false);
        controls();
        return;
      }
      timer = setTimeout(function () {
        if (!connected && port === connection) {
          port = null;
          lastConnectionError = new Error("YouTube receiver handshake timed out.");
          try { connection.disconnect(); } catch (_error) {}
          status("Could not reach FocusFeed on YouTube. Reload YouTube once, then use Retry session.");
        }
        finish(connected);
        controls();
      }, 2000);
      connection.onMessage.addListener(function (message) {
        if (message.type === "HELLO") {
          connected = message.home;
          if (connected) lastConnectionError = null;
          if (!connected) status("Open YouTube Home, then reopen the session.");
          finish(connected);
          controls();
          return;
        }
        if (message.type === "ERROR") {
          stop(message.message);
          return;
        }
        if (message.type === "PREFERENCES_CHANGED") {
          stop("Settings changed. Reopen the session to use the new context.");
          ready = false;
          controls();
          return;
        }
        if (!engine || engine.report().stopped || message.runId !== runId) return;
        if (message.type === "HOME_LEFT") {
          status("Session paused outside YouTube Home. It will resume automatically when you return.");
        }
        if (message.type === "HOME_RESUMED") {
          status("Session active again on YouTube Home. Existing decisions were reapplied automatically.");
        }
        if (message.type === "CANDIDATES") {
          (message.candidates || []).slice(0, 120).forEach(function (candidate) {
            engine.offer(candidate.video, candidate.priority);
          });
        }
        if (message.type === "LOAD_MORE") more();
        if (message.type === "USER_STOP") {
          stop("Session stopped. AI hides restored; explicit filters remain active.");
        }
        if (message.type === "DISPLAY_STATE") {
          displayState = message.state;
          scheduleRender();
        }
        if (message.type === "DISPLAY_RESULT" || message.type === "RESTORED") {
          displayEvents.push(message);
          if (displayEvents.length > 400) displayEvents.shift();
          scheduleObservability();
        }
      });
      connection.onDisconnect.addListener(function () {
        var error = chrome.runtime.lastError;
        if (port === connection) {
          port = null;
          connected = false;
        }
        lastConnectionError = error || new Error("YouTube disconnected.");
        finish(false);
        stop(error
          ? "Reload YouTube after reloading the extension, then use Retry session. " + error.message
          : "YouTube disconnected. Session stopped.");
      });
      try {
        connection.postMessage({ type: "HELLO_REQUEST" });
      } catch (error) {
        if (port === connection) {
          port = null;
          connected = false;
        }
        lastConnectionError = error;
        status("Could not connect to YouTube. " + error.message);
        finish(false);
        controls();
      }
    });
    return connectionAttempt;
  }

  async function connectWithRepair() {
    if (await connect()) return true;
    if (!FocusFeedLiveBootstrap.isMissingReceiver(lastConnectionError)) return false;
    status("FocusFeed was not loaded in this YouTube tab. Installing it now…");
    try {
      await FocusFeedLiveBootstrap.inject(chrome, tabId);
    } catch (error) {
      status("Could not install FocusFeed in YouTube. " + error.message);
      return false;
    }
    status("FocusFeed installed. Reconnecting to YouTube Home…");
    return connect();
  }

  $("retry").addEventListener("click", start);
  $("stop").addEventListener("click", function () {
    stop("Session stopped. AI hides restored; normal Home pagination resumed.");
  });
  $("back").addEventListener("click", function () {
    chrome.tabs.update(tabId, { active: true }).catch(function (error) { status(error.message); });
  });
  $("export").addEventListener("click", function () {
    var snapshot = observabilitySnapshot();
    if (!snapshot) return;
    var url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    }));
    var link = document.createElement("a");
    link.href = url;
    link.download = "focusfeed-live-" + Date.now() + ".json";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  window.addEventListener("pagehide", function () {
    stop();
    if (port) port.disconnect();
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.focusFeedChannelEvidenceV1 &&
        changes.focusFeedChannelEvidenceV1.newValue === undefined) {
      channelEvidence = {};
      pendingChannelSuggestions.clear();
      renderChannelSuggestions();
    }
    var keys = [
      "enabled", "activeProfile", "classifierEndpoint",
    ];
    if (!keys.some(function (key) { return Boolean(changes[key]); })) return;
    settingsVersion += 1;
    ready = false;
    stop("Settings changed. Use Retry session to start with the new settings.");
  });

  start();
})();
