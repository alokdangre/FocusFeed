// Popup controller. Tag editing is isolated in topic-input.js; saved state belongs to the worker.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var settings = null, mode = "general", drafts = {}, blocks = [], busy = false, savedEndpoint = "";
  var DEFAULT_ENDPOINT = "http://127.0.0.1:3000";
  var editor = FocusFeedTopicInput.create({ input: $("objectiveInput"), list: $("topicList"), onChange: edited });

  async function request(message) {
    var response = await chrome.runtime.sendMessage(message);
    if (!response || !response.ok) throw new Error(response && response.error && response.error.message || "Could not reach the extension. Reload it and try again.");
    return response.data;
  }
  function feedback(id, message, error) {
    var node = $(id); node.textContent = message || ""; node.hidden = !message; node.dataset.error = String(!!error);
  }
  function texts(profile) {
    return (profile && profile.objectives || []).flatMap(function (o) { return (o.sourceText || o.text || "").split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean); });
  }
  function draft(profile) { return { topics: texts(profile), duration: profile && profile.sessionDurationMinutes !== undefined ? profile.sessionDurationMinutes : 45 }; }
  function fingerprint() { return JSON.stringify([mode, editor.values(), $("sessionDuration").value]); }
  function rememberDraft() {
    if (settings) drafts[mode] = { topics: editor.values(), duration: $("sessionDuration").value };
  }
  function edited() {
    rememberDraft(); editor.markInvalid([]); $("validationResults").hidden = true;
    feedback("profileFeedback", ""); renderDraft();
  }
  function renderDraft() {
    var topics = editor.values();
    $("topicCount").textContent = topics.length + " / 8";
    var error = topics.length > 8 ? "Use up to 8 topics. Remove a tag to make room." :
      topics.some(function (s) { return s.length > 160; }) ? "Use 160 characters or fewer per topic. Use Backspace in the empty input to edit the last tag." : "";
    $("topicError").textContent = error; $("topicError").hidden = !error;
    $("topicEditor").dataset.invalid = String(!!error);
    if (settings) {
      var profile = settings[mode], same = JSON.stringify(topics) === JSON.stringify(texts(profile)) &&
        Number($("sessionDuration").value) === Number(profile.sessionDurationMinutes);
      $("draftState").textContent = busy ? "Checking…" : same && FocusFeedSettings.valid(profile) ? "Saved" : topics.length ? "Unsaved changes" : "Not saved yet";
      $("profileVersion").textContent = profile.objectives.some(function (o) { return o.matchScope !== "intent"; })
        ? "Save once to upgrade this profile to your exact wording." : "Your topics stay in your words.";
    }
    document.querySelectorAll("[data-minutes]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.minutes === $("sessionDuration").value));
    });
  }
  function setMode(next) {
    rememberDraft(); mode = next; var current = drafts[mode];
    editor.set(current.topics); $("sessionDuration").value = String(current.duration);
    $("validationResults").hidden = true; feedback("profileFeedback", "");
    var focus = mode === "focus";
    $("modeTitle").textContent = focus ? "One thing at a time." : "A quieter feed.";
    $("modeDescription").textContent = focus ? "Choose a direction. Keep only the videos that fit." : "Less of what distracts you. More room for everything else.";
    $("objectiveLabel").textContent = focus ? "What are you focusing on?" : "Keep out of your feed";
    $("durationSection").hidden = !focus;
    document.querySelectorAll("[data-mode]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.mode === mode)); });
    $("topicSuggestions").replaceChildren();
    (focus ? ["DSA tutorials", "Learning Spanish", "Guitar lessons"] : ["Movie reviews", "Gaming streams", "Celebrity gossip"]).forEach(function (topic) {
      var button = document.createElement("button"); button.type = "button"; button.textContent = topic;
      button.addEventListener("click", function () { editor.add(topic); }); $("topicSuggestions").appendChild(button);
    });
    render();
  }
  function render() {
    if (!settings) return;
    var active = FocusFeedSettings.focusActive(settings);
    $("enableToggle").checked = settings.enabled; $("hideShorts").checked = settings.hideShorts === true;
    $("statusDot").dataset.active = String(settings.enabled);
    $("statusText").textContent = !settings.enabled ? "Filtering is paused" : active ? "Focus is active" : "General filtering is on";
    $("sessionCard").hidden = !active;
    if (active) {
      var session = settings.focusSession, remaining = session.endsAt ? Math.max(0, Date.parse(session.endsAt) - Date.now()) : null;
      $("sessionBadge").textContent = (settings.enabled ? "" : "Paused · ") + (remaining === null ? "Until you end it" : Math.ceil(remaining / 60000) + " min left");
      $("sessionProgress").hidden = remaining === null;
      $("sessionProgress").value = remaining === null ? 1 : Math.min(1, remaining / Math.max(1, Date.parse(session.endsAt) - Date.parse(session.startedAt)));
    }
    $("saveGoal").textContent = busy ? "Checking topics…" : mode === "focus" ? "Save topics" : "Save preferences";
    $("saveGoal").className = "button " + (mode === "focus" ? "button-secondary" : "button-primary");
    $("toggleSession").hidden = mode !== "focus" && !active;
    $("toggleSession").textContent = active ? "End Focus" : "Start Focus";
    $("toggleSession").className = "button " + (active ? "button-secondary" : "button-primary");
    $("saveGoal").disabled = busy; $("toggleSession").disabled = busy;
    renderDraft();
  }
  async function update(action) {
    settings = await request({ type: "FF_SETTINGS_UPDATE", action: action }); render(); return settings;
  }
  async function saveEndpoint() {
    var value = $("classifierEndpoint").value.trim().replace(/\/+$/, "") || DEFAULT_ENDPOINT, url;
    try { url = new URL(value); } catch (_) { throw new Error("Enter a valid classifier address."); }
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
      throw new Error("Use HTTPS, or HTTP on localhost, without embedded credentials.");
    }
    if (url.protocol === "https:" && !await chrome.permissions.request({ origins: [url.origin + "/*"] })) throw new Error("Connection access was not granted.");
    if (value !== savedEndpoint) { await chrome.storage.local.set({ classifierEndpoint: value }); savedEndpoint = value; }
  }
  function showInvalid(assessments) {
    var invalid = assessments.filter(function (a) { return a.status !== "ready_for_confirmation"; });
    editor.markInvalid(invalid.map(function (a) { return a.text; }));
    $("validationResults").replaceChildren(); $("validationResults").hidden = !invalid.length;
    invalid.forEach(function (a) {
      var row = document.createElement("div"); row.className = "validation-row";
      var title = document.createElement("strong"); title.textContent = a.text;
      var description = document.createElement("span"); description.textContent = a.reason;
      row.append(title, description); $("validationResults").appendChild(row);
    });
    return invalid.length > 0;
  }
  async function save(startFocus) {
    if (!settings || busy) return;
    var topics = editor.commit(), target = mode, duration = Number($("sessionDuration").value);
    if (!topics.length) { feedback("profileFeedback", "Add at least one topic to get started.", true); $("objectiveInput").focus(); return; }
    if (topics.length > 8 || topics.some(function (s) { return s.length > 160; })) { renderDraft(); return; }
    if (!Number.isInteger(duration) || duration < 0 || duration > 480) { feedback("profileFeedback", "Choose a duration from 0 to 480 minutes.", true); return; }
    var snapshot = fingerprint(), original = settings[target], objectives;
    busy = true; render(); feedback("profileFeedback", "Checking your topics…");
    try {
      var unchanged = FocusFeedSettings.valid(original) && original.objectives.every(function (o) { return o.matchScope === "intent"; }) &&
        JSON.stringify(topics) === JSON.stringify(texts(original));
      if (unchanged) objectives = original.objectives;
      else {
        await saveEndpoint();
        var id = "objectives-" + Date.now() + "-" + Math.random().toString(16).slice(2);
        var result = await request({ type: "OBJECTIVES_CLASSIFY_CLOUD", request: { requestId: id, mode: target, objectives: topics } });
        if (!result || result.requestId !== id || !Array.isArray(result.objectives) || result.objectives.length !== topics.length ||
            result.objectives.some(function (a, i) { return !a || a.text !== topics[i]; })) throw new Error("The validator returned an incomplete response. Nothing has been saved.");
        await chrome.storage.local.set({ focusfeedObjectiveValidationV1: { savedAt: Date.now(), requestedMode: target, requestedObjectives: topics, response: result } });
        if (snapshot !== fingerprint()) throw new Error("Your preferences changed during validation. Save the current topics again.");
        if (showInvalid(result.objectives)) { feedback("profileFeedback", "Clarify the highlighted topics, then save again. Nothing has been saved.", true); return; }
        objectives = result.objectives.map(function (a) {
          var o = a.validatedObjective;
          if (!FocusFeedSettings.validObjective(o) || o.matchScope !== "intent" || o.text !== a.text) throw new Error("The validator returned an incomplete response. Nothing has been saved.");
          return { id: o.id, text: o.text, sourceText: o.text, contentType: "topic", matchScope: "intent", validationVersion: o.validationVersion };
        });
      }
      if (snapshot !== fingerprint()) throw new Error("Your preferences changed during validation. Save the current topics again.");
      await update({ type: "saveProfile", profile: { id: target, mode: target, version: Math.max(1, original.version + 1),
        objectives: objectives, sessionDurationMinutes: duration } });
      if (snapshot !== fingerprint()) { feedback("profileFeedback", "The previous version was saved. Your new edits are still unsaved."); return; }
      drafts[target] = draft(settings[target]);
      if (startFocus && target === "focus") {
        await update({ type: "startFocus" }); feedback("profileFeedback", settings.enabled ? "Focus started. Your goal now filters YouTube." : "Focus started. Turn filtering on when you are ready.");
      } else feedback("profileFeedback", target === "general" && FocusFeedSettings.focusActive(settings)
        ? "Saved. These preferences apply when Focus ends." : target === "focus" ? "Focus topics saved." : "Saved. Your preferences now filter YouTube.");
    } catch (error) { feedback("profileFeedback", error.message, true); }
    finally { busy = false; render(); }
  }
  function renderChannels() {
    $("channelCount").textContent = String(blocks.length); $("channelBlocks").replaceChildren();
    if (!blocks.length) { var empty = document.createElement("p"); empty.className = "empty-message"; empty.textContent = "No channels blocked. You can block one from its video menu on YouTube."; $("channelBlocks").appendChild(empty); }
    blocks.forEach(function (block) {
      var row = document.createElement("div"); row.className = "channel-row";
      var label = document.createElement("span"); label.textContent = block.channelLabel || block.channelId;
      var scope = document.createElement("small"); scope.textContent = block.scope === "global" ? "Blocked everywhere" : "Blocked for its saved preferences"; label.appendChild(scope);
      var button = document.createElement("button"); button.className = "text-button"; button.type = "button"; button.textContent = "Unblock";
      button.setAttribute("aria-label", "Unblock " + (block.channelLabel || block.channelId));
      button.addEventListener("click", async function () {
        button.disabled = true;
        try { await request({ type: "FF_BLOCK_REMOVE", id: block.id }); blocks = (await chrome.storage.local.get({ focusFeedChannelBlocksV1: [] })).focusFeedChannelBlocksV1; renderChannels(); }
        catch (error) { button.disabled = false; feedback("profileFeedback", error.message, true); }
      }); row.append(label, button); $("channelBlocks").appendChild(row);
    });
  }
  async function refreshFeedStatus() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || !/^https:\/\/(www\.)?youtube\.com\//.test(tabs[0].url || "")) { $("feedStatus").textContent = "Ready when you are."; return; }
      var stats = await chrome.tabs.sendMessage(tabs[0].id, { type: "GET_STATS" });
      $("feedStatus").textContent = stats && stats.runtime ? stats.runtime.hidden + " cards hidden in this tab" : "Reload YouTube to connect.";
    } catch (_) { $("feedStatus").textContent = "Reload YouTube to connect."; }
  }
  document.querySelectorAll("[data-mode]").forEach(function (button) { button.addEventListener("click", function () { if (settings) setMode(button.dataset.mode); }); });
  document.querySelectorAll("[data-minutes]").forEach(function (button) { button.addEventListener("click", function () { $("sessionDuration").value = button.dataset.minutes; edited(); }); });
  $("sessionDuration").addEventListener("input", edited);
  $("topicEditor").addEventListener("click", function (event) { if (event.target === $("topicEditor")) $("objectiveInput").focus(); });
  $("saveGoal").addEventListener("click", function () { save(false); });
  $("toggleSession").addEventListener("click", async function () {
    if (!settings || busy) return;
    if (!FocusFeedSettings.focusActive(settings)) { save(true); return; }
    try { await update({ type: "endFocus" }); setMode("general"); feedback("profileFeedback", "Focus ended. General preferences are active."); }
    catch (error) { feedback("profileFeedback", error.message, true); }
  });
  [["enableToggle", "setEnabled"], ["hideShorts", "setHideShorts"]].forEach(function (pair) {
    $(pair[0]).addEventListener("change", async function () {
      $(pair[0]).disabled = true;
      try { await update({ type: pair[1], enabled: $(pair[0]).checked }); }
      catch (error) { render(); feedback("profileFeedback", error.message, true); }
      finally { $(pair[0]).disabled = false; }
    });
  });
  $("checkClassifier").addEventListener("click", async function () {
    $("checkClassifier").disabled = true; feedback("classifierResult", "Checking connection…");
    try { await saveEndpoint(); await request({ type: "CLASSIFIER_HEALTH_CHECK" }); feedback("classifierResult", "API connected and ready for requests."); }
    catch (error) { feedback("classifierResult", error.message, true); }
    finally { $("checkClassifier").disabled = false; }
  });
  $("openObservability").addEventListener("click", function () { chrome.tabs.create({ url: chrome.runtime.getURL("observability/observability.html") }); });
  $("clearGeneratedData").addEventListener("click", async function () {
    $("clearGeneratedData").disabled = true;
    try {
      await request({ type: "FF_CACHE_CLEAR" }); await chrome.storage.local.remove("focusfeedObjectiveValidationV1");
      var tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
      await Promise.allSettled(tabs.map(function (tab) { return chrome.tabs.sendMessage(tab.id, { type: "FF_RESET_RUNTIME" }); }));
      feedback("classifierResult", "Video checks refreshed. Your preferences are unchanged.");
    } catch (error) { feedback("classifierResult", error.message, true); }
    finally { $("clearGeneratedData").disabled = false; }
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.focusfeedSettingsV2 && changes.focusfeedSettingsV2.newValue) { settings = changes.focusfeedSettingsV2.newValue; render(); }
    if (changes.focusFeedChannelBlocksV1) { blocks = changes.focusFeedChannelBlocksV1.newValue || []; renderChannels(); }
  });
  async function load() {
    try {
      settings = await request({ type: "FF_SETTINGS_GET" });
      var values = await chrome.storage.local.get({ classifierEndpoint: DEFAULT_ENDPOINT, focusFeedChannelBlocksV1: [] });
      savedEndpoint = values.classifierEndpoint; $("classifierEndpoint").value = savedEndpoint; blocks = values.focusFeedChannelBlocksV1;
      drafts.general = draft(settings.general); drafts.focus = draft(settings.focus);
      mode = new URL(location.href).searchParams.get("mode") === "focus" ? "focus" : FocusFeedSettings.effective(settings).mode;
      // The editor is still empty: set the initial mode without overwriting its loaded draft.
      editor.set(drafts[mode].topics); $("sessionDuration").value = String(drafts[mode].duration);
      setMode(mode); renderChannels(); refreshFeedStatus();
    } catch (error) { feedback("profileFeedback", error.message, true); }
  }
  setInterval(function () { render(); refreshFeedStatus(); }, 5000);
  load();
})();
