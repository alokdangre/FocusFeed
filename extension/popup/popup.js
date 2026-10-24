// popup.js — settings, Jev intent validation, and live-session launch.

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  var ui = {
    enableToggle: $("enableToggle"),
    totalCount: $("totalCount"),
    trackedCount: $("trackedCount"),
    statusText: $("statusText"),
    filterMode: $("filterMode"),
    objectiveInput: $("objectiveInput"),
    objectiveLabel: $("objectiveLabel"),
    objectiveHint: $("objectiveHint"),
    taxonomyMapping: $("taxonomyMapping"),
    sessionDuration: $("sessionDuration"),
    saveGoal: $("saveGoal"),
    toggleSession: $("toggleSession"),
    profileFeedback: $("profileFeedback"),
    profileVersion: $("profileVersion"),
    sessionBadge: $("sessionBadge"),
    classifierEndpoint: $("classifierEndpoint"),
    checkClassifier: $("checkClassifier"),
    testClassification: $("testClassification"),
    clearGeneratedData: $("clearGeneratedData"),
    channelBlocks: $("channelBlocks"),
    classifierResult: $("classifierResult"),
  };

  var DEFAULT_PROFILE = {
    id: "default",
    version: 0,
    mode: "general",
    objectives: [],
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
    activeProfile: DEFAULT_PROFILE,
    focusSession: DEFAULT_SESSION,
    classifierProvider: "typesafe",
    classifierEndpoint: "http://127.0.0.1:3000",
    focusFeedChannelBlocksV1: [],
  };
  var GENERATED_DATA_KEYS = [
    "focusFeedAssessmentCacheV2",
    "focusFeedLiveAssessmentCacheV1",
    "classifierEvalRuns",
    "classifierLabRuns",
    "focusfeedObjectiveValidationV1",
    "focusfeedLiveObservabilityV1",
    "focusFeedChannelEvidenceV1",
  ];
  var MAX_OBJECTIVE_LENGTH = 160;
  var TAXONOMY_VERSION = "focusfeed-topics-v1";

  var prefs = Object.assign({}, DEFAULTS);
  var draftObjectives = [];
  var pendingMapping = null;

  function parseList(value) {
    var seen = {};
    return String(value || "")
      .split(/[\n,]/)
      .map(function (item) { return item.trim(); })
      .filter(function (item) {
        var key = item.toLowerCase();
        if (!item || seen[key]) return false;
        seen[key] = true;
        return true;
      });
  }

  function acceptedObjectives(value) {
    return (Array.isArray(value) ? value : []).filter(function (objective) {
      return objective && objective.id && objective.text && objective.contentType === "topic" &&
        objective.taxonomyId && objective.taxonomyVersion === TAXONOMY_VERSION;
    }).map(function (objective) {
      return {
        id: String(objective.id),
        text: String(objective.text),
        contentType: "topic",
        taxonomyId: String(objective.taxonomyId),
        taxonomyVersion: String(objective.taxonomyVersion),
        sourceText: String(objective.sourceText || objective.text),
      };
    });
  }

  function migrateProfile(raw) {
    var source = raw || {};
    var mode = source.mode === "focus" ? "focus" : "general";
    var objectives = acceptedObjectives(source.objectives);
    if (objectives.length) {
      draftObjectives = parseList(objectives.map(function (objective) {
        return objective.sourceText;
      }).join(","));
    } else if (Array.isArray(source.objectives) && source.objectives.length) {
      draftObjectives = parseList(source.objectives.map(function (objective) {
        return objective && objective.sourceText || objective && objective.text || "";
      }).join(","));
    } else if (mode === "focus") {
      draftObjectives = parseList((source.usefulTopics || []).join(","));
      if (!draftObjectives.length && source.goal) draftObjectives = [String(source.goal)];
    } else {
      draftObjectives = parseList((source.unwantedTopics || []).join(","));
    }
    return {
      id: source.id || "default",
      version: objectives.length ? Number(source.version) || 0 : 0,
      mode: mode,
      objectives: objectives,
      sessionDurationMinutes: Number(source.sessionDurationMinutes) || 45,
      updatedAt: source.updatedAt || null,
    };
  }

  function loadPrefs() {
    chrome.storage.local.get(DEFAULTS, function (result) {
      prefs = Object.assign({}, DEFAULTS, result);
      prefs.classifierProvider = "typesafe";
      prefs.activeProfile = migrateProfile(result.activeProfile);
      prefs.focusSession = Object.assign({}, DEFAULT_SESSION, result.focusSession || {});
      ui.enableToggle.checked = prefs.enabled;
      ui.classifierEndpoint.value = prefs.classifierEndpoint || DEFAULTS.classifierEndpoint;
      renderProfile();
      renderSession();
      renderChannelBlocks();
      updateStatus();
      chrome.storage.local.set({
        classifierProvider: "typesafe",
        activeProfile: prefs.activeProfile,
      });
    });
  }

  function savePrefs() {
    chrome.storage.local.set(prefs);
  }

  function renderModeCopy() {
    var focus = ui.filterMode.value === "focus";
    ui.objectiveLabel.textContent = focus ? "Things to watch only" : "Things to avoid";
    ui.objectiveInput.placeholder = focus
      ? "DSA tutorials, system design interviews"
      : "gaming streams, celebrity gossip";
    ui.objectiveHint.textContent = focus
      ? "Only confident matches to your confirmed topics appear. Uncertain and non-matching videos stay restorable in observability."
      : "Confident matches to your confirmed topics are hidden. Uncertain videos stay visible.";
  }

  function renderProfile() {
    var profile = prefs.activeProfile;
    ui.filterMode.value = profile.mode === "focus" ? "focus" : "general";
    ui.objectiveInput.value = draftObjectives.join(", ");
    ui.sessionDuration.value = String(profile.sessionDurationMinutes || 0);
    ui.profileVersion.textContent = profile.version > 0
      ? "Profile v" + profile.version + " · " + profile.objectives.length + " confirmed topics"
      : "Needs topic mapping";
    renderModeCopy();
  }

  function setProfileFeedback(message, isError) {
    ui.profileFeedback.textContent = message || "";
    ui.profileFeedback.className = "profile-feedback" + (isError ? " error" : "");
  }

  function setClassifierResult(message, kind) {
    ui.classifierResult.textContent = message || "";
    ui.classifierResult.className = "connection-result" +
      (message ? " visible" : "") +
      (kind ? " " + kind : "");
  }

  function renderChannelBlocks() {
    ui.channelBlocks.textContent = "";
    var blocks = Array.isArray(prefs.focusFeedChannelBlocksV1)
      ? prefs.focusFeedChannelBlocksV1 : [];
    if (!blocks.length) {
      var empty = document.createElement("span");
      empty.className = "empty-msg";
      empty.textContent = "No channels blocked.";
      ui.channelBlocks.appendChild(empty);
      return;
    }
    blocks.forEach(function (block) {
      var tag = document.createElement("span");
      tag.className = "tag tag-signal-down";
      var scope = block.scope === "global" ? "everywhere" :
        "for exact intent in " + (block.mode === "focus" ? "Focus" : "General");
      tag.appendChild(document.createTextNode((block.channelLabel || block.channelId) + " · " + scope));
      var remove = document.createElement("button");
      remove.className = "tag-remove";
      remove.type = "button";
      remove.title = "Unblock channel";
      remove.setAttribute("aria-label", "Unblock " + (block.channelLabel || block.channelId));
      remove.textContent = "×";
      remove.addEventListener("click", function () {
        prefs.focusFeedChannelBlocksV1 = blocks.filter(function (item) {
          return item.id !== block.id;
        });
        chrome.storage.local.set({ focusFeedChannelBlocksV1: prefs.focusFeedChannelBlocksV1 }, function () {
          renderChannelBlocks();
        });
      });
      tag.appendChild(remove);
      ui.channelBlocks.appendChild(tag);
    });
  }

  function comparableProfile(profile) {
    return JSON.stringify({
      mode: profile.mode,
      objectives: profile.objectives,
      sessionDurationMinutes: profile.sessionDurationMinutes,
    });
  }

  function requestId(prefix) {
    return prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function draftFingerprint(mode, texts) {
    return JSON.stringify({ mode: mode, objectives: texts });
  }

  function resetPendingMapping() {
    pendingMapping = null;
    ui.taxonomyMapping.textContent = "";
    ui.taxonomyMapping.className = "taxonomy-mapping";
    ui.saveGoal.textContent = "Map with Jev";
  }

  function renderTaxonomyMapping(response, mode, texts) {
    pendingMapping = {
      fingerprint: draftFingerprint(mode, texts),
      response: response,
    };
    ui.taxonomyMapping.textContent = "";
    ui.taxonomyMapping.className = "taxonomy-mapping visible";
    (response.objectives || []).forEach(function (assessment, objectiveIndex) {
      var group = document.createElement("div");
      group.className = "mapping-group";
      var heading = document.createElement("div");
      heading.className = "mapping-source";
      heading.textContent = "“" + assessment.text + "” — confirm topics";
      group.appendChild(heading);
      var topics = document.createElement("div");
      topics.className = "mapping-topics";
      var suggested = new Set((assessment.suggestedTopics || []).map(function (topic) {
        return topic.taxonomyId;
      }));
      (response.taxonomy || []).slice().sort(function (left, right) {
        return (assessment.typeProbabilities[right.id] || 0) -
          (assessment.typeProbabilities[left.id] || 0);
      }).forEach(function (topic) {
        var label = document.createElement("label");
        label.className = "mapping-topic";
        label.title = topic.definition + " Includes: " + topic.includes.join(", ") +
          ". Excludes: " + topic.excludes.join(", ") + ".";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = suggested.has(topic.id);
        checkbox.dataset.objectiveIndex = String(objectiveIndex);
        checkbox.dataset.taxonomyId = topic.id;
        var name = document.createElement("span");
        name.textContent = topic.label;
        var score = document.createElement("span");
        score.className = "mapping-score";
        score.textContent = Math.round((assessment.typeProbabilities[topic.id] || 0) * 100) + "%";
        label.appendChild(checkbox);
        label.appendChild(name);
        label.appendChild(score);
        topics.appendChild(label);
      });
      group.appendChild(topics);
      ui.taxonomyMapping.appendChild(group);
    });
    ui.saveGoal.textContent = "Save confirmed topics";
  }

  function confirmedObjectives() {
    var response = pendingMapping.response;
    var byId = {};
    var missing = [];
    (response.objectives || []).forEach(function (assessment, objectiveIndex) {
      var checked = Array.from(ui.taxonomyMapping.querySelectorAll(
        'input[data-objective-index="' + objectiveIndex + '"]:checked'
      ));
      if (!checked.length) missing.push(assessment.text);
      checked.forEach(function (input) {
        var topic = (response.taxonomy || []).find(function (item) {
          return item.id === input.dataset.taxonomyId;
        });
        if (!topic) return;
        if (!byId[topic.id]) byId[topic.id] = { topic: topic, sources: [] };
        byId[topic.id].sources.push(assessment.text);
      });
    });
    if (missing.length) {
      setProfileFeedback("Choose at least one topic for: " + missing.join(", ") + ".", true);
      return null;
    }
    return Object.keys(byId).map(function (taxonomyId) {
      var entry = byId[taxonomyId];
      return {
        id: taxonomyId,
        text: entry.topic.label,
        contentType: "topic",
        taxonomyId: taxonomyId,
        taxonomyVersion: response.taxonomyVersion,
        sourceText: entry.sources.join(", ").slice(0, MAX_OBJECTIVE_LENGTH),
      };
    });
  }

  function saveConfirmedProfile(mode, texts, callback) {
    var objectives = confirmedObjectives();
    if (!objectives) return;
    var duration = parseInt(ui.sessionDuration.value, 10);
    if (isNaN(duration) || duration < 0) duration = 0;
    if (duration > 480) duration = 480;
    var nextProfile = {
      id: prefs.activeProfile.id || "default",
      version: prefs.activeProfile.version || 0,
      mode: mode,
      objectives: objectives,
      sessionDurationMinutes: duration,
      updatedAt: prefs.activeProfile.updatedAt || null,
    };
    if (comparableProfile(nextProfile) !== comparableProfile(prefs.activeProfile)) {
      nextProfile.version = (prefs.activeProfile.version || 0) + 1;
      nextProfile.updatedAt = new Date().toISOString();
    }
    prefs.activeProfile = nextProfile;
    draftObjectives = texts.slice();
    chrome.storage.local.set({ activeProfile: nextProfile }, function () {
      if (chrome.runtime.lastError) {
        setProfileFeedback("Could not save the confirmed topic intent.", true);
        return;
      }
      resetPendingMapping();
      renderProfile();
      setProfileFeedback(
        "Saved " + nextProfile.objectives.length + " confirmed taxonomy topic" +
        (nextProfile.objectives.length === 1 ? "" : "s") + ".",
        false
      );
      if (callback) callback();
    });
  }

  function saveEndpoint(callback) {
    var value = ui.classifierEndpoint.value.trim().replace(/\/+$/, "");
    if (!value) value = DEFAULTS.classifierEndpoint;
    prefs.classifierEndpoint = value;
    chrome.storage.local.set({ classifierEndpoint: value }, callback);
  }

  function saveActiveProfile(callback) {
    var texts = parseList(ui.objectiveInput.value);
    var mode = ui.filterMode.value === "focus" ? "focus" : "general";
    if (!texts.length) {
      setProfileFeedback(mode === "focus"
        ? "Enter at least one thing to watch only."
        : "Enter at least one thing to avoid.", true);
      ui.objectiveInput.focus();
      return;
    }
    if (texts.length > 8) {
      setProfileFeedback("Use at most 8 entries so every Jev judgment stays bounded and observable.", true);
      return;
    }
    var overlong = texts.find(function (text) { return text.length > MAX_OBJECTIVE_LENGTH; });
    if (overlong) {
      setProfileFeedback(
        "Each entry must be 160 characters or fewer. Shorten: “" + overlong.slice(0, 80) + "…”",
        true
      );
      return;
    }

    var fingerprint = draftFingerprint(mode, texts);
    if (pendingMapping && pendingMapping.fingerprint === fingerprint) {
      saveConfirmedProfile(mode, texts, callback);
      return;
    }

    ui.saveGoal.disabled = true;
    ui.toggleSession.disabled = true;
    setProfileFeedback("Jev is mapping each entry to the versioned topic taxonomy…", false);
    saveEndpoint(function () {
      chrome.runtime.sendMessage({
        type: "OBJECTIVES_CLASSIFY_CLOUD",
        request: {
          requestId: requestId("objectives"),
          mode: mode,
          objectives: texts,
        },
      }, function (response) {
        ui.saveGoal.disabled = false;
        ui.toggleSession.disabled = false;
        if (chrome.runtime.lastError || !response) {
          setProfileFeedback("The extension service worker did not respond.", true);
          return;
        }
        var observability = {
          schemaVersion: "focusfeed-objective-observability-v1",
          savedAt: Date.now(),
          requestedMode: mode,
          requestedObjectives: texts,
          response: response.ok ? response.data : null,
          error: response.ok ? null : response.error,
        };
        chrome.storage.local.set({ focusfeedObjectiveValidationV1: observability });
        if (!response.ok) {
          setProfileFeedback(response.error.message, true);
          return;
        }
        renderTaxonomyMapping(response.data, mode, texts);
        var noSuggestions = response.data.objectives.filter(function (objective) {
          return !(objective.suggestedTopics || []).length;
        });
        setProfileFeedback(noSuggestions.length
          ? "Jev could not confidently suggest every topic. Choose at least one topic for each entry, then save."
          : "Review Jev's checked suggestions. Edit them if needed, then save confirmed topics.", false);
      });
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
      ui.toggleSession.textContent = "End session";
      ui.toggleSession.className = "btn btn-session-active";
      ui.sessionBadge.textContent = remaining === null ? "Session active" : remaining + " min left";
      ui.sessionBadge.className = "session-badge active";
    } else {
      ui.toggleSession.textContent = "Start session";
      ui.toggleSession.className = "btn btn-secondary";
      ui.sessionBadge.textContent = "No active session";
      ui.sessionBadge.className = "session-badge";
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
      renderSession();
      setProfileFeedback("Session started with the confirmed " + prefs.activeProfile.mode + " topic intent.", false);
    });
  }

  function endSession() {
    prefs.focusSession = Object.assign({}, DEFAULT_SESSION);
    chrome.storage.local.set({ focusSession: prefs.focusSession }, function () {
      renderSession();
      setProfileFeedback("Session ended.", false);
    });
  }

  function runHealthCheck() {
    ui.checkClassifier.disabled = true;
    setClassifierResult("Checking the FocusFeed API…", "");
    chrome.runtime.sendMessage({ type: "CLASSIFIER_HEALTH_CHECK" }, function (response) {
      ui.checkClassifier.disabled = false;
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
        "\nvideo: " + response.data.promptVersion +
        "\nobjectives: " + response.data.objectivePromptVersion +
        "\ntaxonomy: " + response.data.taxonomyVersion,
        "success"
      );
    });
  }

  function sampleRequest() {
    return {
      requestId: requestId("popup"),
      profile: {
        id: prefs.activeProfile.id,
        version: prefs.activeProfile.version,
        mode: prefs.activeProfile.mode,
        objectives: prefs.activeProfile.objectives,
      },
      videos: [
        {
          videoId: "focusfeed-sample-algorithms",
          title: "Sliding Window: Solve These 5 Interview Problems",
          channel: "Algorithm Academy",
          duration: "12:30",
          isShort: false,
          isLive: false,
          isPremiere: false,
        },
        {
          videoId: "focusfeed-sample-gaming",
          title: "LIVE Ranked Gaming Stream and Reactions",
          channel: "Game Clips",
          duration: "18:00",
          isShort: false,
          isLive: true,
          isPremiere: false,
        },
      ],
    };
  }

  function runSampleClassification() {
    if (!prefs.activeProfile.objectives.length || prefs.activeProfile.version < 1) {
      setClassifierResult("Validate and save your intent before testing Jev.", "error");
      return;
    }
    ui.testClassification.disabled = true;
    setClassifierResult("Classifying two sample videos with Jev…", "");
    chrome.runtime.sendMessage(
      { type: "CLASSIFY_VIDEOS", request: sampleRequest() },
      function (response) {
        ui.testClassification.disabled = false;
        if (chrome.runtime.lastError || !response) {
          setClassifierResult("The extension service worker did not respond.", "error");
          return;
        }
        if (!response.ok) {
          setClassifierResult(response.error.message, "error");
          return;
        }
        var lines = response.data.assessments.map(function (assessment) {
          var scores = assessment.objectiveMatches.map(function (match) {
            return match.text + " " + Math.round(match.matchProbability * 100) + "%";
          }).join(", ");
          return assessment.videoId.replace("focusfeed-sample-", "") + ": " +
            assessment.outcome + " · " + scores +
            " · evidence " + Math.round(assessment.evidenceProbability * 100) + "%";
        });
        lines.push("TypeSafe Jev: " + response.data.timing.totalMs + " ms");
        setClassifierResult(lines.join("\n"), "success");
      }
    );
  }

  function updateStatus() {
    if (prefs.enabled) {
      ui.statusText.textContent = "Active on YouTube";
      ui.statusText.className = "status-active";
    } else {
      ui.statusText.textContent = "Filtering disabled";
      ui.statusText.className = "status-inactive";
    }
  }

  function fetchStats() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs[0] || !tabs[0].url || !tabs[0].url.includes("youtube.com")) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: "GET_STATS" }, function (response) {
        if (chrome.runtime.lastError || !response) return;
        ui.totalCount.textContent = response.total || 0;
        ui.trackedCount.textContent = response.trackedVideos || 0;
      });
    });
  }

  ui.filterMode.addEventListener("change", function () {
    resetPendingMapping();
    renderModeCopy();
  });
  ui.objectiveInput.addEventListener("input", resetPendingMapping);
  ui.saveGoal.addEventListener("click", function () { saveActiveProfile(); });
  ui.toggleSession.addEventListener("click", function () {
    if (prefs.focusSession.active) endSession();
    else saveActiveProfile(startSession);
  });
  ui.checkClassifier.addEventListener("click", function () { saveEndpoint(runHealthCheck); });
  ui.testClassification.addEventListener("click", function () { saveEndpoint(runSampleClassification); });
  ui.clearGeneratedData.addEventListener("click", function () {
    ui.clearGeneratedData.disabled = true;
    chrome.storage.local.remove(GENERATED_DATA_KEYS, function () {
      ui.clearGeneratedData.disabled = false;
      if (chrome.runtime.lastError) {
        setClassifierResult("Could not clear generated data: " + chrome.runtime.lastError.message, "error");
        return;
      }
      setClassifierResult("Cleared every assessment cache, report, observability snapshot, and learned channel-evidence tally. Your intent and confirmed channel blocks were kept.", "success");
    });
  });
  $("openObservability").addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("observability/observability.html") });
  });
  $("openYouTubeSession").addEventListener("click", async function () {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    var url;
    try { url = new URL(tab && tab.url); } catch (_error) {}
    if (!url || !/(^|\.)youtube\.com$/.test(url.hostname) || url.pathname !== "/") {
      setClassifierResult("Open YouTube Home first, then open the session here.", "error");
      return;
    }
    await chrome.tabs.create({
      url: chrome.runtime.getURL("live/live.html") + "?tab=" + tab.id,
      active: false,
    });
    window.close();
  });

  ui.enableToggle.addEventListener("change", function () {
    prefs.enabled = ui.enableToggle.checked;
    savePrefs();
    updateStatus();
  });
  loadPrefs();
  fetchStats();
})();
