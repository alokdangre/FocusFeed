// popup.js — Settings UI for FocusFeed

(function () {
  "use strict";

  var enableToggle    = document.getElementById("enableToggle");
  var hideShorts      = document.getElementById("hideShorts");
  var hideLiveStreams = document.getElementById("hideLiveStreams");
  var hidePremieres   = document.getElementById("hidePremieres");
  var minDuration     = document.getElementById("minDuration");
  var maxDuration     = document.getElementById("maxDuration");
  var keywordInput    = document.getElementById("keywordInput");
  var addKeywordBtn   = document.getElementById("addKeyword");
  var keywordTags     = document.getElementById("keywordTags");
  var channelInput    = document.getElementById("channelInput");
  var addChannelBtn   = document.getElementById("addChannel");
  var channelTags     = document.getElementById("channelTags");
  var whitelistInput  = document.getElementById("whitelistInput");
  var addWhitelistBtn = document.getElementById("addWhitelist");
  var whitelistTags   = document.getElementById("whitelistTags");
  var boostedTags     = document.getElementById("boostedTags");
  var suppressedTags  = document.getElementById("suppressedTags");
  var boostedCount    = document.getElementById("boostedCount");
  var suppressedCount = document.getElementById("suppressedCount");
  var hiddenCount     = document.getElementById("hiddenCount");
  var totalCount      = document.getElementById("totalCount");
  var trackedCount    = document.getElementById("trackedCount");
  var statusText      = document.getElementById("statusText");
  var goalInput       = document.getElementById("goalInput");
  var usefulTopicsInput = document.getElementById("usefulTopicsInput");
  var unwantedTopicsInput = document.getElementById("unwantedTopicsInput");
  var exceptionsInput = document.getElementById("exceptionsInput");
  var filterMode      = document.getElementById("filterMode");
  var sessionDuration = document.getElementById("sessionDuration");
  var saveGoalBtn     = document.getElementById("saveGoal");
  var toggleSessionBtn = document.getElementById("toggleSession");
  var profileFeedback = document.getElementById("profileFeedback");
  var profileVersion  = document.getElementById("profileVersion");
  var sessionBadge    = document.getElementById("sessionBadge");
  var classifierProvider = document.getElementById("classifierProvider");
  var bedrockSettings = document.getElementById("bedrockSettings");
  var classifierHint = document.getElementById("classifierHint");
  var classifierEndpointInput = document.getElementById("classifierEndpoint");
  var checkClassifierBtn = document.getElementById("checkClassifier");
  var testClassificationBtn = document.getElementById("testClassification");
  var openClassifierLabBtn = document.getElementById("openClassifierLab");
  var openEvaluationBtn = document.getElementById("openEvaluation");
  var openWorkflowReplayBtn = document.getElementById("openWorkflowReplay");
  var openLifecycleReplayBtn = document.getElementById("openLifecycleReplay");
  var classifierResult = document.getElementById("classifierResult");

  var DEFAULT_PROFILE = {
    id: "default",
    version: 0,
    goal: "",
    usefulTopics: [],
    unwantedTopics: [],
    exceptions: [],
    languages: ["English"],
    mode: "focus",
    sessionDurationMinutes: 45,
    updatedAt: null,
  };

  var DEFAULT_SESSION = {
    active: false,
    startedAt: null,
    endsAt: null,
    profileVersion: null,
  };

  var DEFAULTS = {
    enabled: true,
    blockedKeywords: [],
    blockedChannels: [],
    whitelistedChannels: [],
    hideShorts: false,
    hideLiveStreams: false,
    hidePremieres: false,
    minDurationSec: 0,
    maxDurationSec: 0,
    channelSignals: {},
    activeProfile: DEFAULT_PROFILE,
    focusSession: DEFAULT_SESSION,
    classifierProvider: "bedrock",
    classifierEndpoint: "http://127.0.0.1:3000",
  };

  var prefs = Object.assign({}, DEFAULTS);

  // --- Load ---
  function loadPrefs() {
    chrome.storage.local.get(DEFAULTS, function (result) {
      prefs = result;
      prefs.activeProfile = Object.assign({}, DEFAULT_PROFILE, result.activeProfile || {});
      prefs.focusSession = Object.assign({}, DEFAULT_SESSION, result.focusSession || {});
      enableToggle.checked    = prefs.enabled;
      hideShorts.checked      = prefs.hideShorts;
      hideLiveStreams.checked  = prefs.hideLiveStreams;
      hidePremieres.checked   = prefs.hidePremieres;
      minDuration.value = prefs.minDurationSec > 0 ? Math.floor(prefs.minDurationSec / 60) : "";
      maxDuration.value = prefs.maxDurationSec > 0 ? Math.floor(prefs.maxDurationSec / 60) : "";
      renderTags(keywordTags,   prefs.blockedKeywords,    "keyword");
      renderTags(channelTags,   prefs.blockedChannels,    "channel");
      renderTags(whitelistTags, prefs.whitelistedChannels, "whitelist");
      renderSignals(prefs.channelSignals || {});
      renderProfile();
      renderSession();
      classifierProvider.value = prefs.classifierProvider === "local" ? "local" : "bedrock";
      classifierEndpointInput.value = prefs.classifierEndpoint || "http://127.0.0.1:3000";
      renderClassifierProvider();
      if (isLocalProvider()) refreshLocalModelStatus();
      updateStatus();
    });
  }

  function renderSignals(signals) {
    var boosted = [];
    var suppressed = [];
    Object.keys(signals).forEach(function (name) {
      var score = signals[name];
      if (score > 0) boosted.push({ name: name, score: score });
      else if (score < 0) suppressed.push({ name: name, score: score });
    });
    boosted.sort(function (a, b) { return b.score - a.score; });
    suppressed.sort(function (a, b) { return a.score - b.score; });

    boostedCount.textContent = boosted.length;
    suppressedCount.textContent = suppressed.length;

    renderSignalList(boostedTags, boosted, "signal-up");
    renderSignalList(suppressedTags, suppressed, "signal-down");
  }

  function renderSignalList(container, items, cls) {
    if (!items.length) {
      container.innerHTML = '<span class="empty-msg">None yet</span>';
      return;
    }
    container.innerHTML = "";
    items.forEach(function (item) {
      var tag = document.createElement("span");
      tag.className = "tag tag-" + cls;
      tag.innerHTML =
        escapeHtml(item.name) +
        '<span class="signal-score">' + (item.score > 0 ? "+" : "") + item.score + '</span>' +
        ' <span class="tag-remove" data-type="signal" data-name="' + escapeAttr(item.name) + '">&times;</span>';
      container.appendChild(tag);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  function savePrefs() {
    chrome.storage.local.set(prefs);
  }

  function parseList(value) {
    var seen = {};
    return String(value || "")
      .split(",")
      .map(function (item) { return item.trim(); })
      .filter(function (item) {
        var key = item.toLowerCase();
        if (!item || seen[key]) return false;
        seen[key] = true;
        return true;
      });
  }

  function comparableProfile(profile) {
    return JSON.stringify({
      goal: profile.goal,
      usefulTopics: profile.usefulTopics,
      unwantedTopics: profile.unwantedTopics,
      exceptions: profile.exceptions,
      languages: profile.languages,
      mode: profile.mode,
      sessionDurationMinutes: profile.sessionDurationMinutes,
    });
  }

  function readProfileForm() {
    var duration = parseInt(sessionDuration.value, 10);
    if (isNaN(duration) || duration < 0) duration = 0;
    if (duration > 480) duration = 480;

    return {
      id: prefs.activeProfile.id || "default",
      version: prefs.activeProfile.version || 0,
      goal: goalInput.value.trim(),
      usefulTopics: parseList(usefulTopicsInput.value),
      unwantedTopics: parseList(unwantedTopicsInput.value),
      exceptions: parseList(exceptionsInput.value),
      languages: prefs.activeProfile.languages || ["English"],
      mode: filterMode.value === "balanced" ? "balanced" : "focus",
      sessionDurationMinutes: duration,
      updatedAt: prefs.activeProfile.updatedAt || null,
    };
  }

  function renderProfile() {
    var profile = prefs.activeProfile;
    goalInput.value = profile.goal || "";
    usefulTopicsInput.value = (profile.usefulTopics || []).join(", ");
    unwantedTopicsInput.value = (profile.unwantedTopics || []).join(", ");
    exceptionsInput.value = (profile.exceptions || []).join(", ");
    filterMode.value = profile.mode === "balanced" ? "balanced" : "focus";
    sessionDuration.value = String(profile.sessionDurationMinutes || 0);
    profileVersion.textContent = profile.version > 0
      ? "Profile v" + profile.version
      : "Unsaved profile";
  }

  function setProfileFeedback(message, isError) {
    profileFeedback.textContent = message || "";
    profileFeedback.className = "profile-feedback" + (isError ? " error" : "");
  }

  function saveActiveProfile(callback) {
    var nextProfile = readProfileForm();
    if (!nextProfile.goal) {
      setProfileFeedback("Enter a goal before saving.", true);
      goalInput.focus();
      return;
    }

    if (comparableProfile(nextProfile) !== comparableProfile(prefs.activeProfile)) {
      nextProfile.version = (prefs.activeProfile.version || 0) + 1;
      nextProfile.updatedAt = new Date().toISOString();
    }

    prefs.activeProfile = nextProfile;
    chrome.storage.local.set({ activeProfile: nextProfile }, function () {
      if (chrome.runtime.lastError) {
        setProfileFeedback("Could not save the goal.", true);
        return;
      }
      renderProfile();
      setProfileFeedback("Goal saved. The selected classifier will use this profile.", false);
      if (callback) callback();
    });
  }

  function remainingSessionMinutes(session) {
    if (!session.active || !session.endsAt) return null;
    return Math.max(0, Math.ceil((new Date(session.endsAt).getTime() - Date.now()) / 60000));
  }

  function renderSession() {
    var session = prefs.focusSession;
    var remaining = remainingSessionMinutes(session);

    if (session.active && remaining === 0) {
      prefs.focusSession = Object.assign({}, DEFAULT_SESSION);
      chrome.storage.local.set({ focusSession: prefs.focusSession });
      session = prefs.focusSession;
    }

    if (session.active) {
      toggleSessionBtn.textContent = "End session";
      toggleSessionBtn.className = "btn btn-session-active";
      sessionBadge.textContent = remaining === null ? "Session active" : remaining + " min left";
      sessionBadge.className = "session-badge active";
    } else {
      toggleSessionBtn.textContent = "Start session";
      toggleSessionBtn.className = "btn btn-secondary";
      sessionBadge.textContent = "No active session";
      sessionBadge.className = "session-badge";
    }
  }

  function startSession() {
    var duration = prefs.activeProfile.sessionDurationMinutes || 0;
    var startedAt = new Date();
    prefs.focusSession = {
      active: true,
      startedAt: startedAt.toISOString(),
      endsAt: duration > 0 ? new Date(startedAt.getTime() + duration * 60000).toISOString() : null,
      profileVersion: prefs.activeProfile.version,
    };
    chrome.storage.local.set({ focusSession: prefs.focusSession }, function () {
      if (chrome.runtime.lastError) {
        setProfileFeedback("Could not start the session.", true);
        return;
      }
      renderSession();
      setProfileFeedback("Focus session started.", false);
    });
  }

  function endSession() {
    prefs.focusSession = Object.assign({}, DEFAULT_SESSION);
    chrome.storage.local.set({ focusSession: prefs.focusSession }, function () {
      renderSession();
      setProfileFeedback("Focus session ended.", false);
    });
  }

  function setClassifierResult(message, kind) {
    classifierResult.textContent = message || "";
    classifierResult.className = "connection-result" +
      (message ? " visible" : "") +
      (kind ? " " + kind : "");
  }

  function isLocalProvider() {
    return prefs.classifierProvider === "local";
  }

  function renderClassifierProvider() {
    var local = isLocalProvider();
    classifierProvider.value = local ? "local" : "bedrock";
    bedrockSettings.hidden = local;
    checkClassifierBtn.textContent = local ? "Prepare local model" : "Check API";
    testClassificationBtn.textContent = local ? "Test local AI" : "Test Bedrock";
    classifierHint.textContent = local
      ? "Runs privately with Gemini Nano in Chrome. You may close this popup after starting the download."
      : "Health checks are free. The sample classification invokes Bedrock.";
    setClassifierResult("", "");
  }

  function saveLocalModelState(status, progress, message) {
    chrome.storage.local.set({
      localModelState: {
        status: status,
        progress: typeof progress === "number" ? progress : null,
        message: message || "",
        updatedAt: new Date().toISOString(),
      },
    });
  }

  function readLocalModelState() {
    return chrome.storage.local.get({ localModelState: null }).then(function (result) {
      return result.localModelState || null;
    });
  }

  function savedDownloadProgress(state) {
    if (!state || state.status !== "downloading" || typeof state.progress !== "number") {
      return null;
    }
    return state.progress;
  }

  function showLocalModelStatus(status, progress) {
    if (!isLocalProvider()) return;

    if (status === "available") {
      checkClassifierBtn.textContent = "Check local model";
      setClassifierResult("Local AI ready\n" + FocusFeedLocalClassifier.modelName, "success");
      return;
    }

    if (status === "downloading") {
      checkClassifierBtn.textContent = "Check download";
      var progressText = typeof progress === "number" ? " " + progress + "%" : "";
      var downloadMessage = progress >= 100
        ? "Model downloaded. Chrome is extracting and loading it..."
        : "Chrome is downloading the local model..." + progressText;
      setClassifierResult(
        downloadMessage +
          "\nYou can close this popup and reopen it later.",
        ""
      );
      return;
    }

    if (status === "downloadable") {
      checkClassifierBtn.textContent = "Prepare local model";
      setClassifierResult("Local model is ready to download. Click Prepare local model once.", "");
      return;
    }

    checkClassifierBtn.textContent = "Check local model";
    setClassifierResult(
      "This device does not meet Chrome's requirements for the built-in model.",
      "error"
    );
  }

  async function refreshLocalModelStatus() {
    if (!isLocalProvider()) return;
    try {
      var storedState = await readLocalModelState();
      var status = await FocusFeedLocalClassifier.availability();
      if (!isLocalProvider()) return;
      var progress = status === "downloading" ? savedDownloadProgress(storedState) : null;
      saveLocalModelState(status, progress, "");
      showLocalModelStatus(status, progress);
    } catch (error) {
      if (!isLocalProvider()) return;
      saveLocalModelState("error", null, error && error.message);
      setClassifierResult(error && error.message || "Could not check the local model.", "error");
    }
  }

  function saveClassifierEndpoint(callback) {
    var value = classifierEndpointInput.value.trim().replace(/\/+$/, "");
    if (!value) {
      setClassifierResult("Enter a classifier endpoint.", "error");
      return;
    }
    try {
      new URL(value);
    } catch (_error) {
      setClassifierResult("Enter a valid classifier URL.", "error");
      return;
    }
    prefs.classifierEndpoint = value;
    chrome.storage.local.set({ classifierEndpoint: value }, function () {
      if (chrome.runtime.lastError) {
        setClassifierResult("Could not save the classifier endpoint.", "error");
        return;
      }
      if (callback) callback();
    });
  }

  function runHealthCheck() {
    checkClassifierBtn.disabled = true;
    setClassifierResult("Checking API...", "");
    chrome.runtime.sendMessage({ type: "CLASSIFIER_HEALTH_CHECK" }, function (response) {
      checkClassifierBtn.disabled = false;
      if (chrome.runtime.lastError || !response) {
        setClassifierResult("The extension service worker did not respond.", "error");
        return;
      }
      if (!response.ok) {
        setClassifierResult(response.error.message, "error");
        return;
      }
      setClassifierResult(
        "API ready\n" + response.data.provider + " · " + response.data.model +
          (response.data.region ? " · " + response.data.region : ""),
        "success"
      );
    });
  }

  async function prepareLocalModel() {
    checkClassifierBtn.disabled = true;
    testClassificationBtn.disabled = true;
    setClassifierResult("Checking local AI support...", "");
    try {
      var storedState = await readLocalModelState();
      var status = await FocusFeedLocalClassifier.availability();
      if (status === "available") {
        saveLocalModelState("available", 100, "");
        showLocalModelStatus("available", 100);
        return;
      }

      var lastProgress = status === "downloading" ? savedDownloadProgress(storedState) : null;
      saveLocalModelState("downloading", lastProgress, "");
      showLocalModelStatus("downloading", lastProgress);
      await FocusFeedLocalClassifier.prepare(function (percent) {
        var nextProgress = typeof lastProgress === "number"
          ? Math.max(lastProgress, percent)
          : percent;
        if (nextProgress === lastProgress) return;
        lastProgress = nextProgress;
        saveLocalModelState("downloading", lastProgress, "");
        showLocalModelStatus("downloading", lastProgress);
      });
      saveLocalModelState("available", 100, "");
      showLocalModelStatus("available", 100);
    } catch (error) {
      saveLocalModelState("error", null, error && error.message);
      setClassifierResult(error && error.message || "Could not prepare the local model.", "error");
    } finally {
      checkClassifierBtn.disabled = false;
      testClassificationBtn.disabled = false;
    }
  }

  function sampleRequest() {
    var profile = prefs.activeProfile;
    return {
      requestId: "popup-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      profile: {
        id: profile.id,
        version: profile.version,
        goal: profile.goal,
        usefulTopics: profile.usefulTopics,
        unwantedTopics: profile.unwantedTopics,
        exceptions: profile.exceptions,
        languages: profile.languages,
        mode: profile.mode,
      },
      videos: [
        {
          videoId: "focusfeed-sample-dsa",
          title: "Sliding Window: Solve These 5 Interview Problems",
          channel: "Algorithm Academy",
          duration: "12:30",
          isShort: false,
          isLive: false,
          isPremiere: false,
        },
        {
          videoId: "focusfeed-sample-gaming",
          title: "I Built a Gaming PC for 80000 Rupees",
          channel: "Build Lab",
          duration: "18:00",
          isShort: false,
          isLive: false,
          isPremiere: false,
        },
      ],
    };
  }

  function runSampleClassification() {
    if (!prefs.activeProfile.goal || prefs.activeProfile.version < 1) {
      setClassifierResult("Save an active goal before testing classification.", "error");
      return;
    }

    if (isLocalProvider()) {
      runLocalSampleClassification();
      return;
    }

    testClassificationBtn.disabled = true;
    setClassifierResult("Classifying two sample videos...", "");
    chrome.runtime.sendMessage(
      { type: "CLASSIFY_VIDEOS", request: sampleRequest() },
      function (response) {
        testClassificationBtn.disabled = false;
        if (chrome.runtime.lastError || !response) {
          setClassifierResult("The extension service worker did not respond.", "error");
          return;
        }
        if (!response.ok) {
          setClassifierResult(response.error.message, "error");
          return;
        }
        var lines = response.data.assessments.map(function (item) {
          return item.videoId.replace("focusfeed-sample-", "") + ": " +
            item.goalRelevance + " · unwanted " + item.unwantedMatch;
        });
        lines.push("Bedrock: " + response.data.timing.totalMs + " ms");
        setClassifierResult(lines.join("\n"), "success");
      }
    );
  }

  async function runLocalSampleClassification() {
    testClassificationBtn.disabled = true;
    checkClassifierBtn.disabled = true;
    setClassifierResult("Classifying two sample videos locally...", "");
    try {
      var data = await FocusFeedLocalClassifier.classify(sampleRequest());
      var lines = data.assessments.map(function (item) {
        return item.videoId.replace("focusfeed-sample-", "") + ": " +
          item.goalRelevance + " · unwanted " + item.unwantedMatch;
      });
      lines.push("Local AI: " + data.timing.totalMs + " ms");
      setClassifierResult(lines.join("\n"), "success");
    } catch (error) {
      setClassifierResult(error && error.message || "Local classification failed.", "error");
    } finally {
      testClassificationBtn.disabled = false;
      checkClassifierBtn.disabled = false;
    }
  }

  // --- Tags ---
  function renderTags(container, items, type) {
    if (!items || items.length === 0) {
      container.innerHTML = '<span class="empty-msg">None added</span>';
      return;
    }
    container.innerHTML = "";
    items.forEach(function (item, index) {
      var tag = document.createElement("span");
      tag.className = "tag" + (type === "whitelist" ? " tag-whitelist" : "");
      tag.innerHTML =
        item +
        ' <span class="tag-remove" data-type="' + type + '" data-index="' + index + '">&times;</span>';
      container.appendChild(tag);
    });
  }

  // --- Add helpers ---
  function addItems(input, listKey, tagsEl, type) {
    var val = input.value.trim();
    if (!val) return;
    val.split(",").map(function (v) { return v.trim(); }).filter(Boolean).forEach(function (item) {
      if (prefs[listKey].indexOf(item) === -1) prefs[listKey].push(item);
    });
    input.value = "";
    renderTags(tagsEl, prefs[listKey], type);
    savePrefs();
  }

  // --- Remove tag ---
  document.addEventListener("click", function (e) {
    if (!e.target.classList.contains("tag-remove")) return;
    var type = e.target.dataset.type;

    if (type === "signal") {
      var name = e.target.dataset.name;
      if (!name || !prefs.channelSignals) return;
      delete prefs.channelSignals[name];
      renderSignals(prefs.channelSignals);
      savePrefs();
      return;
    }

    var index = parseInt(e.target.dataset.index, 10);
    var map   = { keyword: "blockedKeywords", channel: "blockedChannels", whitelist: "whitelistedChannels" };
    var tagsMap = { keyword: keywordTags, channel: channelTags, whitelist: whitelistTags };
    if (!map[type]) return;
    prefs[map[type]].splice(index, 1);
    renderTags(tagsMap[type], prefs[map[type]], type);
    savePrefs();
  });

  // Live-refresh when signals change in another tab/page (e.g. user clicks 👍 on YouTube while popup open)
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes.channelSignals) return;
    prefs.channelSignals = changes.channelSignals.newValue || {};
    renderSignals(prefs.channelSignals);
  });

  // --- Duration change ---
  function saveDuration() {
    var minVal = parseInt(minDuration.value, 10);
    var maxVal = parseInt(maxDuration.value, 10);
    prefs.minDurationSec = (!isNaN(minVal) && minVal > 0) ? minVal * 60 : 0;
    prefs.maxDurationSec = (!isNaN(maxVal) && maxVal > 0) ? maxVal * 60 : 0;
    savePrefs();
  }

  minDuration.addEventListener("change", saveDuration);
  maxDuration.addEventListener("change", saveDuration);

  // --- Checkbox handlers ---
  enableToggle.addEventListener("change", function () {
    prefs.enabled = enableToggle.checked;
    savePrefs();
    updateStatus();
  });

  hideShorts.addEventListener("change", function () {
    prefs.hideShorts = hideShorts.checked;
    savePrefs();
  });

  hideLiveStreams.addEventListener("change", function () {
    prefs.hideLiveStreams = hideLiveStreams.checked;
    savePrefs();
  });

  hidePremieres.addEventListener("change", function () {
    prefs.hidePremieres = hidePremieres.checked;
    savePrefs();
  });

  // --- Button + Enter key ---
  addKeywordBtn.addEventListener("click", function () {
    addItems(keywordInput, "blockedKeywords", keywordTags, "keyword");
  });
  addChannelBtn.addEventListener("click", function () {
    addItems(channelInput, "blockedChannels", channelTags, "channel");
  });
  addWhitelistBtn.addEventListener("click", function () {
    addItems(whitelistInput, "whitelistedChannels", whitelistTags, "whitelist");
  });

  keywordInput.addEventListener("keydown",   function (e) { if (e.key === "Enter") addItems(keywordInput, "blockedKeywords", keywordTags, "keyword"); });
  channelInput.addEventListener("keydown",   function (e) { if (e.key === "Enter") addItems(channelInput, "blockedChannels", channelTags, "channel"); });
  whitelistInput.addEventListener("keydown", function (e) { if (e.key === "Enter") addItems(whitelistInput, "whitelistedChannels", whitelistTags, "whitelist"); });

  saveGoalBtn.addEventListener("click", function () {
    saveActiveProfile();
  });

  toggleSessionBtn.addEventListener("click", function () {
    if (prefs.focusSession.active) {
      endSession();
      return;
    }
    saveActiveProfile(startSession);
  });

  classifierProvider.addEventListener("change", function () {
    prefs.classifierProvider = classifierProvider.value === "local" ? "local" : "bedrock";
    chrome.storage.local.set({ classifierProvider: prefs.classifierProvider }, function () {
      renderClassifierProvider();
      if (isLocalProvider()) refreshLocalModelStatus();
    });
  });

  checkClassifierBtn.addEventListener("click", function () {
    if (isLocalProvider()) {
      prepareLocalModel();
      return;
    }
    saveClassifierEndpoint(runHealthCheck);
  });

  testClassificationBtn.addEventListener("click", function () {
    if (isLocalProvider()) {
      runSampleClassification();
      return;
    }
    saveClassifierEndpoint(runSampleClassification);
  });

  openClassifierLabBtn.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("lab/lab.html") });
  });

  openEvaluationBtn.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("eval/eval.html") });
  });

  openWorkflowReplayBtn.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("workflow/workflow.html") });
  });

  openLifecycleReplayBtn.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("workflow/lifecycle.html") });
  });

  // --- Status ---
  function updateStatus() {
    if (prefs.enabled) {
      statusText.textContent = "Active on YouTube";
      statusText.className = "status-active";
    } else {
      statusText.textContent = "Filtering disabled";
      statusText.className = "status-inactive";
    }
  }

  // --- Stats ---
  function fetchStats() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs[0] || !tabs[0].url || !tabs[0].url.includes("youtube.com")) {
        statusText.textContent = "Open YouTube to start filtering";
        statusText.className = "status-inactive";
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: "GET_STATS" }, function (response) {
        if (chrome.runtime.lastError || !response) return;
        hiddenCount.textContent  = response.hidden || 0;
        totalCount.textContent   = response.total || 0;
        trackedCount.textContent = response.trackedVideos || 0;
      });
    });
  }

  // --- Init ---
  loadPrefs();
  fetchStats();
  setInterval(fetchStats, 2000);
  setInterval(renderSession, 30000);
})();
