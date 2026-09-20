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
  var releaseLock = null;
  var runId = null;
  var rows = new Map();
  var reviews = {};
  var displayState = {};
  var displayEvents = [];
  var providerStages = [];
  var renderTimer = null;
  var providerTasks = new Set();
  var settingsVersion = 0;
  var cache = FocusFeedAssessmentCache.create(chrome.storage.local, { storageKey: "focusFeedLiveAssessmentCacheV1", maxEntries: 500 });
  function status(text) { $("status").textContent = text; }
  function send(message) { if (port) port.postMessage(Object.assign({ runId: runId }, message)); }
  function controls() {
    var running = Boolean(engine && !engine.report().stopped);
    // Start remains actionable when readiness is missing so one click can
    // retry both provider preparation and the YouTube handshake.
    $("start").disabled = busy || providerTasks.size > 0 || running;
    $("stop").disabled = !running;
    $("apply").disabled = !running;
    $("prepare").disabled = busy || running || providerTasks.size > 0;
    $("export").disabled = !engine;
  }
  function render() {
    renderTimer = null;
    if (!engine) { controls(); return; }
    var report = engine.report();
    var c = report.counts; var b = report.budget;
    $("admitted").textContent = report.records.length + " / " + b.allowance;
    $("fast").textContent = (c.rule || 0) + " / " + (c.cache || 0);
    $("resolved").textContent = (c.model || 0) + " / " + (c.model_pending || 0) + " / " + ((c.unresolved || 0) + (c.deferred || 0) + (c.metadata || 0));
    $("calls").textContent = b.calls + " / " + b.callBudget;
    $("videos").textContent = b.modelVideos + " / " + b.modelVideoBudget;
    $("queue").textContent = report.scheduler.queueDepth + " / " + report.scheduler.inFlightRequests;
    $("display").textContent = (displayState.hiddenCards || 0) + " / " + (displayState.gate && displayState.gate.waiting || 0);
    var p95 = report.scheduler.timing.providerMs.p95;
    $("latency").textContent = p95 === null ? "—" : (p95 / 1000).toFixed(1) + " s";
    if (!report.stopped) send({ type: "STATS", counts: c, budget: b, queueDepth: report.scheduler.queueDepth });
    controls();
  }
  function scheduleRender() { if (!renderTimer) renderTimer = setTimeout(render, 80); }
  function renderRecord(record) {
    var id = record.video.videoId;
    var row = rows.get(id);
    if (!row) { row = document.createElement("tr"); rows.set(id, row); $("results").appendChild(row); }
    row.textContent = "";
    function cell(text) { var el = document.createElement("td"); el.textContent = text || ""; row.appendChild(el); return el; }
    var video = cell(); var link = document.createElement("a");
    link.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(id); link.target = "_blank"; link.rel = "noreferrer";
    link.textContent = record.video.title; video.appendChild(link);
    var channel = document.createElement("small"); channel.textContent = record.video.channel + " · " + id; video.appendChild(channel);
    cell(record.route + " · " + (record.status === "resolved" ? record.action : record.status));
    var evidence = cell(record.reason);
    if (record.assessment) {
      var labels = document.createElement("small");
      labels.textContent = record.assessment.goalRelevance + " · unwanted " + record.assessment.unwantedMatch + " · " + record.assessment.evidenceSufficiency + " · " + (record.assessment.evidence || []).join("; ");
      evidence.appendChild(labels);
    }
    cell(record.timing ? "Queue " + Math.round(record.timing.queueWaitMs) + " ms; provider " + (record.timing.providerMs / 1000).toFixed(1) + " s" : "—");
    var action = cell(); var select = document.createElement("select");
    [["", "Not reviewed"], ["show", "Should show"], ["hide", "Should hide"], ["unclear", "Unsure"]].forEach(function (pair) {
      var opt = document.createElement("option"); opt.value = pair[0]; opt.textContent = pair[1]; select.appendChild(opt);
    });
    select.value = reviews[id] && reviews[id].action || "";
    select.addEventListener("change", function () { reviews[id] = { action: select.value, fingerprint: record.fingerprint, at: Date.now() }; });
    action.appendChild(select);
    var restore = document.createElement("button"); restore.className = "button"; restore.textContent = "Restore on YouTube";
    restore.addEventListener("click", function () { send({ type: "RESTORE", videoId: id }); }); action.appendChild(restore);
  }
  async function loadPreferences() {
    prefs = await chrome.storage.local.get({ enabled: true, activeProfile: null, classifierProvider: "bedrock", classifierEndpoint: "http://127.0.0.1:3000",
      blockedKeywords: [], blockedChannels: [], whitelistedChannels: [], channelSignals: {}, hideShorts: false, hideLiveStreams: false, hidePremieres: false, minDurationSec: 0, maxDurationSec: 0 });
    var profile = prefs.activeProfile;
    $("profile").textContent = profile && profile.goal ? profile.goal + " · " + profile.mode + " · profile v" + profile.version : "Save a goal in the popup first.";
    $("providerNote").textContent = prefs.classifierProvider === "local"
      ? "Local Chrome AI selected. No Bedrock charges. A fresh four-video call took about a minute on the latest run; rules and cache do not wait for it."
      : "Amazon Bedrock selected. Start and Load more may incur inference charges, limited by the displayed call allowance. No automatic retries or provider fallback.";
  }
  async function prepare(download) {
    if (busy) return false;
    busy = true; ready = false; controls();
    var preparingVersion = settingsVersion;
    try {
      await loadPreferences();
      if (!prefs.enabled) throw new Error("Enable FocusFeed in the popup first.");
      if (!prefs.activeProfile || !prefs.activeProfile.goal || !prefs.activeProfile.version) throw new Error("Save your goal in the popup first.");
      if (prefs.classifierProvider === "local") {
        var availability = await FocusFeedLocalClassifier.availability();
        if (availability !== "available" && download) {
          await FocusFeedLocalClassifier.prepare(function (percent) { status("Preparing local AI: " + percent + "%"); });
          availability = await FocusFeedLocalClassifier.availability();
        }
        if (availability !== "available") throw new Error("Local AI is " + availability + ". Use Check / prepare provider.");
        identity = { provider: "chrome-built-in-ai", model: FocusFeedLocalClassifier.modelName, promptVersion: FocusFeedLocalClassifier.promptVersion };
      } else {
        var response = await chrome.runtime.sendMessage({ type: "CLASSIFIER_HEALTH_CHECK" });
        if (!response || !response.ok) throw new Error(response && response.error.message || "Backend is unavailable.");
        identity = { provider: response.data.provider, model: response.data.model, promptVersion: response.data.promptVersion };
      }
      if (preparingVersion !== settingsVersion) throw new Error("Settings changed during provider preparation. Check the provider again.");
      ready = true; status("Provider ready. Start preview to admit at most 12 recommendations from YouTube Home.");
      return true;
    } catch (error) { status(error.message); return false; }
    finally { busy = false; controls(); }
  }
  async function executeProvider(request, signal) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (prefs.classifierProvider === "local") {
      var response = await FocusFeedLocalClassifier.classify(request, { signal: signal, onStage: function (stage) {
        providerStages.push({ requestId: request.requestId, stage: stage });
        if (providerStages.length > 600) providerStages.shift();
        if (!signal.aborted) status("Local AI · " + stage.id + " · " + stage.status + ". You can use YouTube while this runs.");
      }});
      return FocusFeedLiveProvider.validateRaw(response, request);
    }
    var cancel = function () { chrome.runtime.sendMessage({ type: "LIVE_CLASSIFY_CANCEL", requestId: request.requestId }).catch(function () {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      var result = await chrome.runtime.sendMessage({ type: "LIVE_CLASSIFY_BEDROCK", request: FocusFeedLiveProvider.cloudRequest(request) });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!result || !result.ok) throw new Error(result && result.error.message || "Bedrock request failed.");
      if (!result.data.diagnostics) throw new Error("Restart the updated backend to expose output diagnostics before live classification.");
      return result.data;
    } finally { signal.removeEventListener("abort", cancel); }
  }
  function provider(request, signal) {
    var task = executeProvider(request, signal);
    providerTasks.add(task);
    task.then(function () { providerTasks.delete(task); controls(); }, function () { providerTasks.delete(task); controls(); });
    return task;
  }
  function stop(message) {
    if (engine) engine.stop();
    send({ type: "STOP" }); $("apply").checked = false;
    var release = releaseLock; releaseLock = null;
    if (release) Promise.allSettled(Array.from(providerTasks)).then(function () { release(); controls(); });
    if (message) status(message);
    render();
  }
  async function start() {
    if (busy || providerTasks.size || (engine && !engine.report().stopped)) return;
    if (!ready && !await prepare(true)) return;
    if (!connected) {
      status("Connecting to YouTube Home…");
      if (!await connectWithRepair()) return;
    }
    busy = true; controls();
    var startingVersion = settingsVersion;
    try {
      var acquired = await new Promise(function (resolve, reject) {
        navigator.locks.request("focusfeed-live-session", { ifAvailable: true }, async function (lock) {
          if (!lock) { resolve(false); return; }
          await new Promise(function (release) { releaseLock = release; resolve(true); });
        }).catch(reject);
      });
      if (!acquired) throw new Error("Another live session is running. Stop it first to keep model concurrency at one.");
      var cacheEntries = await cache.getAll();
      if (startingVersion !== settingsVersion || !connected || !ready) throw new Error("Settings or the YouTube connection changed before start. Prepare the provider again.");
      runId = "live-" + Date.now() + "-" + tabId;
      rows.clear(); reviews = {}; displayState = {}; displayEvents = []; providerStages = []; $("results").textContent = "";
      engine = FocusFeedLiveEngine.create({ runId: runId, profile: prefs.activeProfile, preferences: FocusFeedWorkflow.normalizePreferences(prefs),
        classifier: identity, cache: cache, cacheEntries: cacheEntries, provider: provider,
        onRecord: function (record) { renderRecord(record); if (engine && !engine.report().stopped) send({ type: "RESULT", record: record }); },
        onChange: scheduleRender,
      });
      send({ type: "START" }); status("Preview started. Switch back to YouTube. Only Load more expands the allowance.");
    } catch (error) { stop(error.message); }
    finally { busy = false; render(); }
  }
  function more() {
    if (!engine || engine.report().scheduler.queueDepth > 12 || !engine.loadMore()) return;
    send({ type: "MORE", allowance: engine.report().budget.allowance }); render();
    status("Allowed up to " + engine.report().budget.allowance + " recommendations. At most one additional Home page may load if needed.");
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
        port = null; connected = false;
        lastConnectionError = error;
        status("Could not connect to YouTube. " + error.message);
        finish(false); controls(); return;
      }
      timer = setTimeout(function () {
        if (!connected && port === connection) {
          port = null;
          lastConnectionError = new Error("YouTube receiver handshake timed out.");
          try { connection.disconnect(); } catch (_) {}
          status("Could not reach FocusFeed on YouTube. Reload YouTube once after reloading the extension, then click Start again.");
        }
        finish(connected); controls();
      }, 2000);
      connection.onMessage.addListener(function (message) {
        if (message.type === "HELLO") {
          connected = message.home;
          if (connected) lastConnectionError = null;
          if (!connected) status("Open YouTube Home, then reopen the session from the popup.");
          finish(connected); controls(); return;
        }
        if (message.type === "ERROR") { stop(message.message); return; }
        if (message.type === "NAVIGATED" || message.type === "PREFERENCES_CHANGED") {
          stop("Page or settings changed. Reopen the session from YouTube Home to use the new context."); ready = false; controls(); return;
        }
        if (!engine || engine.report().stopped || message.runId !== runId) return;
        if (message.type === "CANDIDATES") {
          (message.candidates || []).slice(0, 120).forEach(function (candidate) { engine.offer(candidate.video, candidate.priority); });
        }
        if (message.type === "LOAD_MORE") more();
        if (message.type === "USER_STOP") stop("Session stopped. AI hides restored; explicit filters remain active.");
        if (message.type === "MODE") { $("apply").checked = message.applyHides; }
        if (message.type === "DISPLAY_STATE") { displayState = message.state; scheduleRender(); }
        if (message.type === "DISPLAY_RESULT" || message.type === "RESTORED") {
          displayEvents.push(message); if (displayEvents.length > 400) displayEvents.shift();
        }
      });
      connection.onDisconnect.addListener(function () {
        var error = chrome.runtime.lastError;
        if (port === connection) { port = null; connected = false; }
        lastConnectionError = error || new Error("YouTube disconnected.");
        finish(false);
        stop(error ? "Reload YouTube after reloading the extension, then click Start again. " + error.message : "YouTube disconnected. Session stopped.");
      });
      // Request an explicit reply after both listeners exist. The content
      // script's eager HELLO can otherwise race listener registration.
      try { connection.postMessage({ type: "HELLO_REQUEST" }); }
      catch (error) {
        if (port === connection) { port = null; connected = false; }
        lastConnectionError = error;
        status("Could not connect to YouTube. " + error.message); finish(false); controls();
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
      status("Could not install FocusFeed in YouTube. Reopen the popup from YouTube Home. " + error.message);
      return false;
    }
    status("FocusFeed installed. Reconnecting to YouTube Home…");
    return connect();
  }
  $("start").addEventListener("click", start);
  $("prepare").addEventListener("click", function () { prepare(true); });
  $("stop").addEventListener("click", function () { stop("Session stopped. AI hides restored; normal Home pagination resumed."); });
  $("apply").addEventListener("change", function () { send({ type: "MODE", applyHides: $("apply").checked }); });
  $("back").addEventListener("click", function () { chrome.tabs.update(tabId, { active: true }).catch(function (error) { status(error.message); }); });
  $("export").addEventListener("click", function () {
    if (!engine) return;
    var report = Object.assign(engine.report(), { userAgent: navigator.userAgent, displayState: displayState, displayEvents: displayEvents, providerStages: providerStages, reviews: reviews });
    var url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    var link = document.createElement("a"); link.href = url; link.download = "focusfeed-live-" + Date.now() + ".json"; link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  window.addEventListener("pagehide", function () { stop(); if (port) port.disconnect(); });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    var keys = ["enabled", "activeProfile", "classifierProvider", "classifierEndpoint", "blockedKeywords", "blockedChannels", "whitelistedChannels", "channelSignals", "hideShorts", "hideLiveStreams", "hidePremieres", "minDurationSec", "maxDurationSec"];
    if (!keys.some(function (key) { return Boolean(changes[key]); })) return;
    settingsVersion += 1;
    ready = false;
    stop("Settings changed. Check / prepare provider before starting a new run.");
  });
  connect(); prepare(false);
})();
