// Popup controller. Tag editing is isolated in topic-input.js; saved state belongs to the worker.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var settings = null, mode = "general", drafts = {}, blocks = [], busy = false, savedEndpoint = "";
  var DEFAULT_ENDPOINT = "http://127.0.0.1:3000";
  var learningProfiles = [], learningData = { items: [], history: [], allowedChannels: [] };
  var editor = FocusFeedTopicInput.create({ input: $("objectiveInput"), list: $("topicList"), onChange: edited });

  var request = FocusFeedPreferences.request;
  var accountBusy = false, accountValue = null, billingValue = null, billingBusy = false, billingFeedback = "";
  var byokBusy = false, byokConfigured = null;
  function renderByok(value) {
    var configured = value && value.keyConfigured;
    $("byokConnectionLabel").textContent = configured ? "Connected" : "Add your key";
    $("byokSection").dataset.connected = String(!!configured);
    if (value && (byokConfigured === null || byokConfigured !== !!configured)) $("byokSection").open = !configured;
    if (value) byokConfigured = !!configured;
    $("byokStatus").textContent = configured ? "Your TypeSafe key is ready for this browser session." : "Add a key to enable topic filtering. Layout controls and manual blocks work without one.";
    $("byokRemove").hidden = !configured;
    $("byokSave").disabled = byokBusy; $("byokRemove").disabled = byokBusy;
    $("hostedAccount").hidden = (savedEndpoint || DEFAULT_ENDPOINT) === "https://api.typesafe.ai";
  }
  async function byokAction(type) {
    if (byokBusy) return;
    byokBusy = true; $("byokSave").disabled = true; $("byokRemove").disabled = true;
    var key = $("byokKey").value;
    $("byokKey").value = "";
    feedback("byokFeedback", type === "FF_BYOK_SAVE" ? "Checking your key with TypeSafe…" : "Removing your key…");
    try {
      var result = await request(type === "FF_BYOK_SAVE" ? { type: type, key: key } : { type: type });
      if (type === "FF_BYOK_SAVE") { savedEndpoint = "https://api.typesafe.ai"; $("classifierEndpoint").value = savedEndpoint; }
      renderByok(result); renderAccount(result);
      if (type === "FF_BYOK_SAVE") $("byokSection").open = false;
      if (!$("byokSection").open) $("byokSummary").focus();
      feedback("byokFeedback", type === "FF_BYOK_SAVE" ? "Key checked. You can now save topics and filter your feed." : "Key removed. AI checks have stopped.");
    } catch (error) { $("byokSection").open = true; feedback("byokFeedback", error.message, true); }
    finally { key = ""; byokBusy = false; $("byokSave").disabled = false; $("byokRemove").disabled = false; }
  }
  $("byokSave").addEventListener("click", function () { byokAction("FF_BYOK_SAVE"); });
  $("byokRemove").addEventListener("click", function () { byokAction("FF_BYOK_REMOVE"); });
  request({ type: "FF_BYOK_STATUS" }).then(renderByok).catch(function () { renderByok(null); });
  function renderBilling() {
    var signedIn = accountValue && accountValue.mode === "required" && accountValue.userId;
    var available = signedIn && billingValue && billingValue.available;
    $("billingUpgrade").hidden = !available || !!accountValue.premium || !!billingValue.hasSubscription;
    $("billingManage").hidden = !available || !billingValue.canManage;
    $("billingUpgrade").disabled = accountBusy || billingBusy; $("billingManage").disabled = accountBusy || billingBusy;
    $("billingUpgrade").textContent = billingValue && billingValue.mode === "test_mode" ? "Test checkout ↗" : "Upgrade to Pro ↗";
    var message = billingFeedback || (available && billingValue.mode === "test_mode" ? "Test billing is enabled. No real payment will be collected." :
      available && billingValue.cancelAtPeriodEnd ? "Renewal is cancelled. Your paid access lasts until the end of its period." : "");
    $("billingStatus").textContent = message; $("billingStatus").hidden = !message;
  }
  function renderAccount(value) {
    if (!value || !accountValue || value.userId !== accountValue.userId || value.endpoint !== accountValue.endpoint) { billingValue = null; billingFeedback = ""; }
    accountValue = value;
    $("hostedAccount").hidden = (savedEndpoint || DEFAULT_ENDPOINT) === "https://api.typesafe.ai";
    var local = value && value.mode === "local", signedIn = value && value.userId && !local;
    $("accountStatus").textContent = local ? "Local testing is active. No sign-in required." : !signedIn ? "Sign in to use AI filtering, or test with a local server. Layout controls are free." :
      value.premium ? "Pro access is active." : "Signed in. Pro access is not active for this account.";
    $("accountSignIn").hidden = !!local || !!signedIn; $("accountSignOut").hidden = !signedIn;
    $("accountTestLocal").hidden = !!local;
    $("accountTestLocal").disabled = accountBusy;
    $("accountSignIn").disabled = accountBusy; $("accountSignOut").disabled = accountBusy; $("accountRefresh").disabled = accountBusy;
    renderBilling();
  }
  async function billingStatus() {
    if (!accountValue || !accountValue.userId || accountValue.mode !== "required" || billingBusy) return;
    var identity = accountValue.userId, endpoint = accountValue.endpoint;
    try {
      var value = await request({ type: "FF_BILLING_STATUS" });
      if (accountValue && accountValue.userId === identity && accountValue.endpoint === endpoint) billingValue = value;
    } catch (_error) { billingValue = null; }
    renderBilling();
  }
  async function billingAction(type) {
    if (billingBusy || accountBusy) return;
    billingBusy = true; billingFeedback = "Opening secure billing…"; renderBilling();
    try {
      var value = await request({ type: type });
      billingFeedback = value.mode === "test_mode" ? "Test billing opened in a new tab. Return here to refresh access." :
        "Billing opened in a new tab. Payment confirmation can take a few minutes; return here to refresh access.";
    } catch (error) { billingFeedback = error.message; }
    finally { billingBusy = false; renderBilling(); }
  }
  async function accountAction(type, refresh) {
    if (accountBusy) return;
    accountBusy = true;
    ["accountSignIn", "accountSignOut", "accountRefresh", "accountTestLocal"].forEach(function (id) { $(id).disabled = true; });
    try {
      if (refresh && accountValue && accountValue.userId && billingValue && billingValue.available) await request({ type: "FF_BILLING_REFRESH" }).catch(function () {});
      var value = await request({ type: type, refresh: !!refresh });
      feedback("accountFeedback", value && value.remoteSignOutPending ? "Signed out on this device. The server could not confirm session revocation." : ""); accountBusy = false; renderAccount(value);
      await billingStatus();
    } catch (error) {
      accountBusy = false; renderAccount(null); feedback("accountFeedback", error.message, true);
    }
  }
  $("accountSignIn").addEventListener("click", function () { accountAction("FF_ACCOUNT_SIGN_IN"); });
  $("accountTestLocal").addEventListener("click", function () { accountAction("FF_ACCOUNT_TEST_LOCAL"); });
  $("accountSignOut").addEventListener("click", function () { accountAction("FF_ACCOUNT_SIGN_OUT"); });
  $("accountRefresh").addEventListener("click", function () { accountAction("FF_ACCOUNT_STATUS", true); });
  $("billingUpgrade").addEventListener("click", function () { billingAction("FF_BILLING_CHECKOUT"); });
  $("billingManage").addEventListener("click", function () { billingAction("FF_BILLING_PORTAL"); });
  var displaySettings = FocusFeedDisplaySettings.create({ prefix: "popup-display",
    save: function (action) { return update(action); },
    onError: function (error) { feedback("profileFeedback", error.message, true); }
  });
  $("displaySettings").appendChild(displaySettings.element);
  function feedback(id, message, error) {
    var node = $(id); node.textContent = message || ""; node.hidden = !message; node.dataset.error = String(!!error);
  }
  var texts = FocusFeedPreferences.texts, draft = FocusFeedPreferences.draft;
  function fingerprint() { return JSON.stringify([mode, editor.values(), $("sessionDuration").value]); }
  function rememberDraft() {
    if (settings) drafts[mode] = { topics: editor.values(), duration: $("sessionDuration").value };
  }
  function receive(next) {
    if (!next || settings && next.revision < settings.revision) return;
    var previous = settings, refreshEditor = false, conflict = false;
    if (previous && drafts.general) {
      rememberDraft();
      ["general", "focus"].forEach(function (target) {
        if (JSON.stringify(previous[target]) === JSON.stringify(next[target])) return;
        var current = drafts[target], original = draft(previous[target]);
        if (JSON.stringify(current.topics) === JSON.stringify(original.topics) && Number(current.duration) === Number(original.duration)) {
          drafts[target] = draft(next[target]); if (target === mode) refreshEditor = true;
        } else conflict = true;
      });
    }
    settings = next;
    if (refreshEditor) { editor.set(drafts[mode].topics); $("sessionDuration").value = String(drafts[mode].duration); }
    render();
    if (conflict && !busy) feedback("profileFeedback", "Saved topics changed in another tab. Your draft is preserved; save to replace those topics.");
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
      var needsUpgrade = profile.objectives.some(function (o) { return o.matchScope !== "intent"; });
      $("profileVersion").textContent = needsUpgrade ? "Save once to upgrade this profile to your exact wording." : "";
      $("profileVersion").hidden = !needsUpgrade;
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
    $("modeDescription").textContent = focus ? "Make room for what you want to learn." : "Choose what makes it into your feed.";
    $("objectiveLabel").textContent = focus ? "What are you focusing on?" : "Keep out of your feed";
    $("durationSection").hidden = !focus;
    document.querySelectorAll("[data-mode]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.mode === mode)); });
    $("topicSuggestions").replaceChildren();
    (focus ? ["DSA tutorials", "Learning Spanish", "Guitar lessons"] : ["Movie reviews", "Gaming streams", "Celebrity gossip", "Sports highlights"]).filter(function (topic) {
      return !editor.values().some(function (value) { return value.toLowerCase() === topic.toLowerCase(); });
    }).slice(0, 2).forEach(function (topic) {
      var button = document.createElement("button"); button.type = "button"; button.textContent = topic;
      button.addEventListener("click", function () { editor.add(topic); }); $("topicSuggestions").appendChild(button);
    });
    render();
  }
  function render() {
    if (!settings) return;
    var active = FocusFeedSettings.focusActive(settings);
    $("enableToggle").checked = settings.enabled; $("hideShorts").checked = settings.hideShorts === true;
    displaySettings.configure(settings);
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
  async function update(action, expectedProfileVersion) {
    receive(await request({ type: "FF_SETTINGS_UPDATE", action: action, expectedProfileVersion: expectedProfileVersion })); return settings;
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
  function showValidation(assessments) {
    var invalid = assessments.filter(function (a) { return a.status !== "ready_for_confirmation"; });
    editor.markInvalid(invalid.map(function (a) { return a.text; }));
    $("validationResults").replaceChildren(); $("validationResults").hidden = false;
    assessments.forEach(function (a) {
      var row = document.createElement("div"); row.className = "validation-row";
      row.dataset.accepted = String(a.status === "ready_for_confirmation");
      var title = document.createElement("strong"); title.textContent = a.text;
      var score = document.createElement("span"); score.className = "validation-score";
      score.textContent = (a.status === "ready_for_confirmation" ? "Accepted" : "Needs editing") + " · Nonsense probability: " + (a.nonsenseProbability * 100).toFixed(1) + "%";
      var description = document.createElement("span"); description.textContent = a.reason;
      row.append(title, score, description); $("validationResults").appendChild(row);
    });
    return invalid.length > 0;
  }
  async function save(startFocus) {
    if (!settings || busy) return;
    var topics = editor.commit(), target = mode, duration = Number($("sessionDuration").value);
    if (!topics.length) { feedback("profileFeedback", "Add at least one topic to get started.", true); $("objectiveInput").focus(); return; }
    if (topics.length > 8 || topics.some(function (s) { return s.length > 160; })) { renderDraft(); return; }
    if (!Number.isInteger(duration) || duration < 0 || duration > 480) { feedback("profileFeedback", "Choose a duration from 0 to 480 minutes.", true); return; }
    var snapshot = fingerprint();
    busy = true; render(); feedback("profileFeedback", "Checking your topics…");
    try {
      var saved = await FocusFeedPreferences.save({ state: settings, mode: target, topics: topics, duration: duration,
        beforeValidate: saveEndpoint, isCurrent: function () { return snapshot === fingerprint(); }, onValidation: showValidation });
      receive(saved);
      if (snapshot !== fingerprint()) { feedback("profileFeedback", "The previous version was saved. Your new edits are still unsaved."); return; }
      drafts[target] = draft(settings[target]);
      if (startFocus && target === "focus") {
        await update({ type: "startFocus" }, saved.focus.version); feedback("profileFeedback", settings.enabled ? "Focus started. Your goal now filters YouTube." : "Focus started. Turn filtering on when you are ready.");
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
  function renderLearning() {
    if (typeof FocusFeedLearningPolicy === "undefined" || !settings) return;
    $("learnedChannels").replaceChildren(); $("videoCorrections").replaceChildren();
    var count = 0;
    learningProfiles.forEach(function (p) {
      settings.general.objectives.forEach(function (o) {
        var j = FocusFeedLearningPolicy.judgment(p, o, FocusFeedLearningPolicy.endpointKey(savedEndpoint), Date.now());
        if (!j || !j.blockChannel || FocusFeedLearningPolicy.allowed(learningData, p.channelId, j.key)) return;
        count++;
        var row = document.createElement("div"); row.className = "channel-row";
        var label = document.createElement("span"); label.textContent = p.title || p.channelId;
        var topic = document.createElement("small"); topic.textContent = o.text; label.appendChild(topic);
        var button = document.createElement("button"); button.className = "text-button"; button.textContent = "Use video checks";
        button.addEventListener("click", async function () {
          button.disabled = true;
          try { await request({ type: "FF_CHANNEL_ALLOW", channelId: p.channelId, topicKey: j.key }); await loadLearning(); }
          catch (error) { button.disabled = false; feedback("profileFeedback", error.message, true); }
        }); row.append(label, button); $("learnedChannels").appendChild(row);
      });
    });
    if (!count) { var empty = document.createElement("p"); empty.className = "empty-message"; empty.textContent = "No active channel filters learned yet."; $("learnedChannels").appendChild(empty); }
    learningData.items.concat(learningData.collections || []).sort(function (a, b) { return a.createdAt - b.createdAt; }).slice(-20).reverse().forEach(function (c) {
      var row = document.createElement("div"); row.className = "channel-row";
      var label = document.createElement("span"); label.textContent = c.title || c.videoId;
      var topic = document.createElement("small"); topic.textContent = c.topic ? (c.itemType === "collection" ? "Collection · " : "") + (c.match ? "Matches: " : "Doesn't match: ") + c.topic : "Hidden collection"; label.appendChild(topic);
      var button = document.createElement("button"); button.className = "text-button"; button.textContent = "Undo";
      button.addEventListener("click", async function () {
        button.disabled = true;
        try { await request({ type: "FF_CORRECTION_UNDO", id: c.id }); await loadLearning(); }
        catch (error) { button.disabled = false; feedback("profileFeedback", error.message, true); }
      }); row.append(label, button); $("videoCorrections").appendChild(row);
    });
  }
  async function loadLearning() {
    var values = await chrome.storage.local.get({ focusfeedChannelProfilesV1: [], focusfeedCorrectionsV1: { items: [], history: [], allowedChannels: [] } });
    learningProfiles = values.focusfeedChannelProfilesV1; learningData = values.focusfeedCorrectionsV1; renderLearning();
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
  $("reviewHidden").addEventListener("click", async function () {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || !/^https:\/\/(www\.)?youtube\.com\//.test(tabs[0].url || "")) throw new Error("Open a YouTube tab first.");
      var response = await chrome.tabs.sendMessage(tabs[0].id, { type: "FF_REVIEW_HIDDEN" });
      if (!response || !response.reviewing) throw new Error("Switch to General and enable filtering to review topic decisions.");
      feedback("classifierResult", "Filtered videos are visible for review. Use their ⋯ menu to correct a topic, then select Done.");
    } catch (error) { feedback("classifierResult", error.message, true); }
  });
  $("exportCorrections").addEventListener("click", async function () {
    await loadLearning();
    var blob = new Blob([JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), corrections: learningData.items, hiddenCollections: learningData.collections || [], events: learningData.history }, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "focusfeed-corrections.json"; link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
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
    if (changes.focusfeedAccountV1 && !accountBusy) renderAccount(changes.focusfeedAccountV1.newValue);
    if (changes.focusfeedSettingsV2 && changes.focusfeedSettingsV2.newValue) receive(changes.focusfeedSettingsV2.newValue);
    if (changes.focusFeedChannelBlocksV1) { blocks = changes.focusFeedChannelBlocksV1.newValue || []; renderChannels(); }
    if (changes.classifierEndpoint) { savedEndpoint = changes.classifierEndpoint.newValue || DEFAULT_ENDPOINT; $("classifierEndpoint").value = savedEndpoint; $("hostedAccount").hidden = savedEndpoint === "https://api.typesafe.ai"; }
    if (changes.focusfeedChannelProfilesV1 || changes.focusfeedCorrectionsV1 || changes.classifierEndpoint || changes.focusfeedSettingsV2) loadLearning();
  });
  async function load() {
    try {
      settings = await request({ type: "FF_SETTINGS_GET" });
      var values = await chrome.storage.local.get({ classifierEndpoint: DEFAULT_ENDPOINT, focusFeedChannelBlocksV1: [] });
      savedEndpoint = values.classifierEndpoint; $("classifierEndpoint").value = savedEndpoint; blocks = values.focusFeedChannelBlocksV1;
      drafts.general = draft(settings.general); drafts.focus = draft(settings.focus);
      var requestedMode = new URL(location.href).searchParams.get("mode");
      mode = ["general", "focus"].includes(requestedMode) ? requestedMode : FocusFeedSettings.effective(settings).mode;
      // The editor is still empty: set the initial mode without overwriting its loaded draft.
      editor.set(drafts[mode].topics); $("sessionDuration").value = String(drafts[mode].duration);
      setMode(mode); renderChannels(); refreshFeedStatus(); await loadLearning();
      accountAction("FF_ACCOUNT_STATUS");
    } catch (error) { feedback("profileFeedback", error.message, true); }
  }
  setInterval(function () { render(); refreshFeedStatus(); accountAction("FF_ACCOUNT_STATUS"); }, 5000);
  load();
})();
