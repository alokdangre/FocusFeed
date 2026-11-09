// Everyday preferences on YouTube. Native nodes remain owned by YouTube.
(function (root) {
  "use strict";
  function create(adapter) {
    adapter = adapter || {};
    var settings = null, mode = "general", drafts = {}, blocks = [], busy = false, stopped = false, suspended = false;
    var opened = false, mountTimer = null, clock = null, blocksSerial = 0, listeners = [];
    var request = FocusFeedPreferences.request, texts = FocusFeedPreferences.texts, draft = FocusFeedPreferences.draft;
    function element(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }
    function button(text, className, action) {
      var node = element("button", className, text); node.type = "button";
      if (action) node.addEventListener("click", action);
      return node;
    }
    function listen(node, type, action, options) {
      node.addEventListener(type, action, options); listeners.push(function () { node.removeEventListener(type, action, options); });
    }
    var trigger = button("", "focusfeed-header-button", function () { if (opened) close(true); else open(); });
    trigger.id = "focusfeed-preferences-button"; trigger.dataset.focusfeedUi = "true";
    trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "focusfeed-preferences");
    var mark = element("span", "focusfeed-header-mark", "O"); mark.setAttribute("aria-hidden", "true");
    var name = element("span", "focusfeed-header-name", "OwnFeed"), status = element("span", "focusfeed-header-status", "…");
    trigger.append(mark, name, status);
    var panel = element("section", "focusfeed-preferences");
    panel.id = "focusfeed-preferences"; panel.dataset.focusfeedUi = "true"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", "focusfeed-preferences-title");
    var nativePopover = typeof panel.showPopover === "function";
    // Own dismissal so clicking the trigger cannot race native light-dismiss.
    if (nativePopover) panel.setAttribute("popover", "manual");
    var heading = element("header", "focusfeed-preferences-heading");
    var title = element("h2", "", "OwnFeed"); title.id = "focusfeed-preferences-title";
    var dismiss = button("×", "focusfeed-preferences-close", function () { close(true); });
    dismiss.setAttribute("aria-label", "Close OwnFeed settings"); heading.append(title, dismiss);
    var message = element("p", "focusfeed-preferences-message"); message.hidden = true; message.setAttribute("role", "status");
    var retry = button("Retry loading", "focusfeed-preferences-link", load); retry.hidden = true;
    var power = element("input"); power.type = "checkbox"; power.id = "focusfeed-preferences-enabled"; power.setAttribute("role", "switch");
    var powerRow = switchRow("Filtering", "Pause or resume your saved filters", power);
    var modes = element("nav", "focusfeed-preferences-modes"); modes.setAttribute("aria-label", "Preferences to edit");
    var general = button("General", "", function () { setMode("general"); });
    var focus = button("Focus", "", function () { setMode("focus"); }); modes.append(general, focus);
    general.dataset.mode = "general"; focus.dataset.mode = "focus";
    var fieldHeading = element("div", "focusfeed-preferences-field-heading");
    var label = element("label", "", "Hide recommendations about"); label.htmlFor = "focusfeed-preferences-input";
    var count = element("span"); fieldHeading.append(label, count);
    var topicEditor = element("div", "focusfeed-preferences-editor");
    var topicList = element("div", "focusfeed-preferences-topics"); topicList.setAttribute("aria-label", "Your topics");
    var input = element("input"); input.id = "focusfeed-preferences-input"; input.type = "text"; input.autocomplete = "off";
    input.setAttribute("aria-describedby", "focusfeed-preferences-hint focusfeed-preferences-error");
    var hint = element("p", "focusfeed-preferences-note", "Press Enter or comma to add a topic.");
    hint.id = "focusfeed-preferences-hint";
    var fieldError = element("p", "focusfeed-preferences-error"); fieldError.id = "focusfeed-preferences-error";
    fieldError.hidden = true; fieldError.setAttribute("role", "status");
    topicEditor.append(topicList, input);
    var validation = element("ul", "focusfeed-preferences-validation"); validation.hidden = true;
    var durationRow = element("section", "focusfeed-preferences-duration"); durationRow.hidden = true;
    var durationLabel = element("label", "", "Focus duration"); durationLabel.htmlFor = "focusfeed-preferences-duration";
    var presets = element("div", "focusfeed-preferences-presets");
    [25, 45, 60].forEach(function (minutes) {
      var preset = button(minutes + " min", "", function () { duration.value = String(minutes); edited(); });
      preset.dataset.minutes = String(minutes); presets.appendChild(preset);
    });
    var duration = element("input"); duration.id = "focusfeed-preferences-duration"; duration.type = "number";
    duration.min = "0"; duration.max = "480"; duration.step = "1"; duration.value = "45";
    duration.setAttribute("aria-label", "Custom Focus minutes; zero means no timer"); presets.appendChild(duration);
    durationRow.append(durationLabel, presets, element("p", "focusfeed-preferences-note", "Set 0 for a session without a timer."));
    var session = element("p", "focusfeed-preferences-session"); session.hidden = true;
    var actions = element("div", "focusfeed-preferences-actions");
    var disclosure = element("p", "focusfeed-preferences-note", "BYOK filtering sends your topics and relevant YouTube video/channel text directly to TypeSafe using your key. Provider usage charges apply. Custom servers may have separate access requirements. ");
    disclosure.id = "focusfeed-preferences-disclosure";
    var privacy = element("a", "focusfeed-preferences-link", "Privacy details ↗");
    privacy.href = "https://ownfeed.tech/privacy.html"; privacy.target = "_blank"; privacy.rel = "noreferrer";
    disclosure.appendChild(privacy);
    var saveButton = button("Save changes", "focusfeed-preferences-primary", function () { save(false); });
    var sessionButton = button("Start Focus", "focusfeed-preferences-primary", toggleSession); sessionButton.hidden = true;
    actions.append(saveButton, sessionButton);
    var draftStatus = element("p", "focusfeed-preferences-note"); draftStatus.setAttribute("role", "status");
    var shorts = element("input"); shorts.type = "checkbox"; shorts.id = "focusfeed-preferences-shorts"; shorts.setAttribute("role", "switch");
    var shortsRow = switchRow("Hide Shorts", "Applies across YouTube", shorts);
    var displaySettings = FocusFeedDisplaySettings.create({ prefix: "focusfeed-display",
      save: function (action) { return request({ type: "FF_SETTINGS_UPDATE", action: action }); },
      onSaved: configure, onError: function (error) { feedback(error.message, true); }
    });
    var channels = element("details", "focusfeed-preferences-channels");
    var channelsSummary = element("summary", "", "Blocked channels");
    var channelsList = element("div", "focusfeed-preferences-channel-list"); channels.append(channelsSummary, channelsList);
    var review = button("Review filtered videos", "focusfeed-preferences-link", function () {
      if (adapter.reviewHidden && adapter.reviewHidden()) close(false);
      else feedback("Enable filtering in General to review topic decisions.", true);
    });
    var more = button("Connection & more settings ↗", "focusfeed-preferences-link", async function () {
      try { await request({ type: "FF_OPEN_PREFERENCES", mode: mode }); close(false); }
      catch (error) { feedback(error.message, true); }
    });
    var accountLink = button("API key & connection ↗", "focusfeed-preferences-link", async function () {
      try { await request({ type: "FF_OPEN_PREFERENCES", mode: mode }); close(false); }
      catch (error) { feedback(error.message, true); }
    });
    panel.append(heading, powerRow, accountLink, modes, fieldHeading, topicEditor, hint, fieldError, validation,
      durationRow, session, disclosure, actions, draftStatus, message, retry, shortsRow, displaySettings.element, channels, review, more);
    var editor = FocusFeedTopicInput.create({ input: input, list: topicList, onChange: edited });
    function switchRow(text, description, control) {
      var row = element("label", "focusfeed-preferences-switch"); row.htmlFor = control.id;
      var copy = element("span"); copy.append(element("strong", "", text), element("small", "", description));
      row.append(copy, control); return row;
    }
    function feedback(text, error) { message.textContent = text || ""; message.hidden = !text; message.dataset.error = String(!!error); }
    function remember() {
      if (settings) drafts[mode] = { topics: editor.values(), duration: duration.value };
    }
    function fingerprint() { return JSON.stringify([mode, editor.values(), Number(duration.value)]); }
    function dirty(target, previous) {
      if (!drafts[target] || !previous) return false;
      var value = target === mode ? { topics: editor.values(), duration: duration.value } : drafts[target];
      return JSON.stringify(value.topics) !== JSON.stringify(texts(previous[target])) ||
        Number(value.duration) !== Number(draft(previous[target]).duration);
    }
    function edited() {
      remember(); editor.markInvalid([]); validation.hidden = true; feedback(""); renderDraft();
    }
    function renderDraft() {
      var topics = editor.values(), error = topics.length > 8 ? "Use up to 8 topics. Remove a tag to make room." :
        topics.some(function (s) { return s.length > 160; }) ? "Use 160 characters or fewer per topic." : "";
      count.textContent = topics.length + " / 8";
      fieldError.textContent = error; fieldError.hidden = !error; topicEditor.dataset.invalid = String(!!error);
      draftStatus.textContent = busy ? "Checking topics…" : !settings ? "Loading preferences…" :
        dirty(mode, settings) ? "Unsaved changes" : FocusFeedSettings.valid(settings[mode]) ? "Saved" : "Add topics to get started.";
      presets.querySelectorAll("button").forEach(function (node) {
        node.setAttribute("aria-pressed", String(node.dataset.minutes === duration.value));
      });
    }
    function setMode(next) {
      if (!settings) return;
      remember(); mode = next;
      editor.set(drafts[mode].topics); duration.value = String(drafts[mode].duration);
      validation.hidden = true; feedback(""); render();
    }
    function renderClock() {
      var active = settings && FocusFeedSettings.focusActive(settings), enabled = settings && settings.enabled;
      var remaining = active && settings.focusSession.endsAt ? Math.max(0, Date.parse(settings.focusSession.endsAt) - Date.now()) : null;
      var timerLabel = remaining === null ? "Focus" : "Focus · " + Math.ceil(remaining / 60000) + " min";
      var stateLabel = !settings ? "…" : !enabled ? "Paused" : settings.aiAccess === false ? "Free controls" : active ? timerLabel :
        FocusFeedSettings.valid(settings.general) ? "On" : "Set up";
      if (status.textContent !== stateLabel) status.textContent = stateLabel;
      trigger.title = "OwnFeed · " + stateLabel + ". Open feed settings";
      trigger.setAttribute("aria-label", trigger.title);
      trigger.dataset.active = String(!!enabled);
      session.hidden = !active;
      if (active) session.textContent = (!enabled ? "Paused · " : "") + (remaining === null ? "Focus active until you end it" : Math.ceil(remaining / 60000) + " min of Focus remaining");
      sessionButton.hidden = mode !== "focus" && !active;
      sessionButton.textContent = active ? "End Focus" : "Start Focus";
    }
    function render() {
      general.setAttribute("aria-pressed", String(mode === "general")); focus.setAttribute("aria-pressed", String(mode === "focus"));
      label.textContent = mode === "focus" ? "Show recommendations about" : "Hide recommendations about";
      durationRow.hidden = mode !== "focus";
      power.checked = !!(settings && settings.enabled); shorts.checked = !!(settings && settings.hideShorts);
      saveButton.disabled = !settings || busy; sessionButton.disabled = !settings || busy;
      power.disabled = !settings; shorts.disabled = !settings;
      if (settings) displaySettings.configure(settings);
      saveButton.textContent = busy ? "Checking topics…" : "Save changes";
      review.disabled = !settings || !settings.enabled || settings.aiAccess === false || FocusFeedSettings.focusActive(settings);
      renderClock(); renderDraft();
    }
    function configure(next) {
      if (!next || stopped || settings && next.revision < settings.revision) return;
      var previous = settings, conflict = false, refreshEditor = !previous;
      if (!previous) {
        mode = FocusFeedSettings.effective(next).mode;
        drafts.general = draft(next.general); drafts.focus = draft(next.focus);
      } else {
        remember();
        ["general", "focus"].forEach(function (target) {
          if (JSON.stringify(previous[target]) === JSON.stringify(next[target])) return;
          if (dirty(target, previous)) conflict = true;
          else { drafts[target] = draft(next[target]); if (mode === target) refreshEditor = true; }
        });
      }
      settings = next;
      if (refreshEditor) { editor.set(drafts[mode].topics); duration.value = String(drafts[mode].duration); }
      retry.hidden = true; render(); mount();
      if (conflict && !busy) feedback("Saved topics changed in another tab. Your draft is preserved; Save changes will replace those topics.");
    }
    async function save(startFocus) {
      if (!settings || busy) return;
      var topics = editor.commit(), target = mode, snapshot = fingerprint();
      if (!topics.length) { feedback("Add at least one topic to get started.", true); input.focus(); return; }
      busy = true; render(); feedback("Checking your topics…");
      try {
        var saved = await FocusFeedPreferences.save({ state: settings, mode: target, topics: topics, duration: duration.value,
          isCurrent: function () { return !stopped && !suspended && snapshot === fingerprint(); },
          onValidation: function (assessments) {
            editor.markInvalid(assessments.filter(function (a) { return a.status !== "ready_for_confirmation"; }).map(function (a) { return a.text; }));
            validation.replaceChildren();
            assessments.filter(function (a) { return a.status !== "ready_for_confirmation"; }).forEach(function (a) {
              var item = element("li"); item.append(element("strong", "", a.text), element("span", "", a.reason)); validation.appendChild(item);
            });
            validation.hidden = !validation.children.length;
          } });
        configure(saved);
        if (snapshot !== fingerprint()) { feedback("The previous version was saved. Your new edits are still unsaved."); return; }
        drafts[target] = draft(saved[target]);
        if (startFocus && target === "focus") {
          configure(await request({ type: "FF_SETTINGS_UPDATE", expectedProfileVersion: saved.focus.version, action: { type: "startFocus" } }));
          feedback(settings.enabled ? "Focus started." : "Focus started. Enable filtering when you are ready.");
        } else feedback(target === "general" && FocusFeedSettings.focusActive(settings) ? "Saved. These topics apply when Focus ends." : "Saved.");
      } catch (error) { feedback(error.message, true); }
      finally { busy = false; if (!stopped) render(); }
    }
    async function toggleSession() {
      if (!settings || busy) return;
      if (!FocusFeedSettings.focusActive(settings)) { save(true); return; }
      sessionButton.disabled = true;
      try {
        configure(await request({ type: "FF_SETTINGS_UPDATE", action: { type: "endFocus" } }));
        setMode("general"); feedback("Focus ended. General preferences are active.");
      } catch (error) { feedback(error.message, true); }
      finally { render(); }
    }
    [[power, "setEnabled"], [shorts, "setHideShorts"]].forEach(function (pair) {
      pair[0].addEventListener("change", async function () {
        pair[0].disabled = true;
        try { configure(await request({ type: "FF_SETTINGS_UPDATE", action: { type: pair[1], enabled: pair[0].checked } })); }
        catch (error) { render(); feedback(error.message, true); }
        finally { pair[0].disabled = !settings; }
      });
    });
    function renderChannels() {
      channelsSummary.textContent = "Blocked channels (" + blocks.length + ")"; channelsList.replaceChildren();
      if (!blocks.length) channelsList.appendChild(element("p", "focusfeed-preferences-note", "No channels blocked. Use a video's ⋯ menu to block one."));
      blocks.forEach(function (block) {
        var row = element("div", "focusfeed-preferences-channel");
        var title = block.channelLabel || block.channelId;
        var copy = element("span", "", title);
        copy.appendChild(element("small", "", block.scope === "global" ? "Blocked everywhere" : "Blocked for its saved topics"));
        var unblock = button("Unblock", "focusfeed-preferences-link", async function () {
          unblock.disabled = true;
          try { await request({ type: "FF_BLOCK_REMOVE", id: block.id }); await loadBlocks(); }
          catch (error) { unblock.disabled = false; feedback(error.message, true); }
        });
        unblock.setAttribute("aria-label", "Unblock " + title); row.append(copy, unblock); channelsList.appendChild(row);
      });
    }
    async function loadBlocks() {
      var serial = ++blocksSerial;
      var values = await chrome.storage.local.get({ focusFeedChannelBlocksV1: [] });
      if (stopped || serial !== blocksSerial) return;
      blocks = values.focusFeedChannelBlocksV1; renderChannels();
    }
    async function load() {
      retry.hidden = true;
      try { configure(await request({ type: "FF_SETTINGS_GET" })); await loadBlocks(); }
      catch (error) { feedback(error.message, true); retry.hidden = false; }
    }
    function position() {
      if (!opened) return;
      var width = window.innerWidth || document.documentElement.clientWidth || 1024;
      var height = window.innerHeight || document.documentElement.clientHeight || 768;
      var rect = trigger.getBoundingClientRect(), panelWidth = Math.min(360, width - 24);
      var top = Math.max(8, Math.min(height - 120, rect.bottom + 8));
      panel.style.left = Math.max(12, Math.min(width - panelWidth - 12, (rect.right || width - 12) - panelWidth)) + "px";
      panel.style.top = top + "px"; panel.style.maxHeight = Math.max(80, height - top - 12) + "px";
    }
    function close(restoreFocus) {
      if (!opened) return;
      opened = false; trigger.setAttribute("aria-expanded", "false");
      if (nativePopover) { try { panel.hidePopover(); } catch (_) {} }
      panel.hidden = true;
      if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }
    function open(target) {
      if (stopped || suspended || !mount()) return false;
      if (target && settings && mode !== target) setMode(target);
      panel.hidden = false; opened = true; trigger.setAttribute("aria-expanded", "true"); position();
      if (nativePopover) { try { panel.showPopover(); } catch (_) { close(false); return false; } }
      render(); (settings ? input : dismiss).focus({ preventScroll: true });
      if (!settings) load(); else loadBlocks().catch(function (error) { feedback(error.message, true); });
      return true;
    }
    function mount() {
      if (stopped || suspended) return false;
      var floating = !!(settings && settings.enabled && settings.hideTopHeader);
      trigger.toggleAttribute("data-floating", floating);
      if (floating) {
        var host = document.body || document.documentElement;
        if (trigger.parentNode !== host) host.appendChild(trigger);
      } else if (!trigger.isConnected || !trigger.closest("ytd-masthead")) {
        var actions = document.querySelector("ytd-masthead #end #buttons") || document.querySelector("ytd-masthead #end");
        if (!actions) { close(false); return false; }
        actions.prepend(trigger);
      }
      if (!panel.isConnected) (document.body || document.documentElement).appendChild(panel);
      position(); return true;
    }
    var observer = new MutationObserver(function () {
      if (trigger.isConnected && panel.isConnected || stopped || suspended || mountTimer) return;
      mountTimer = setTimeout(function () { mountTimer = null; mount(); }, 100);
    });
    function start() {
      if (stopped) return;
      suspended = false; observer.observe(document.documentElement, { childList: true, subtree: true });
      if (!clock) clock = setInterval(function () { if (!document.hidden) renderClock(); }, 5000);
      mount();
    }
    function suspend() {
      suspended = true; close(false); observer.disconnect();
      clearTimeout(mountTimer); mountTimer = null; clearInterval(clock); clock = null;
    }
    function changed(changes, area) {
      if (area !== "local" || stopped) return;
      if (changes.focusfeedSettingsV2 && changes.focusfeedSettingsV2.newValue) configure(changes.focusfeedSettingsV2.newValue);
      if (changes.focusFeedChannelBlocksV1) { blocksSerial++; blocks = changes.focusFeedChannelBlocksV1.newValue || []; renderChannels(); }
    }
    chrome.storage.onChanged.addListener(changed);
    listen(duration, "input", edited);
    listen(topicEditor, "click", function (event) { if (event.target === topicEditor) input.focus(); });
    listen(panel, "keydown", function (event) {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(true); }
    });
    listen(panel, "focusout", function (event) {
      if (event.relatedTarget && !panel.contains(event.relatedTarget) && !trigger.contains(event.relatedTarget)) close(false);
    });
    // Keyup/keypress can also be used by page-level playback shortcuts.
    ["keyup", "keypress"].forEach(function (type) { listen(panel, type, function (event) { event.stopPropagation(); }); });
    listen(panel, "toggle", function (event) {
      if (nativePopover && event.newState === "closed" && opened) { opened = false; panel.hidden = true; trigger.setAttribute("aria-expanded", "false"); }
    });
    listen(document, "pointerdown", function (event) {
      if (opened && !panel.contains(event.target) && !trigger.contains(event.target)) close(false);
    }, true);
    listen(document, "keydown", function (event) { if (opened && event.key === "Escape") { event.preventDefault(); close(true); } });
    listen(window, "resize", position);
    listen(window, "scroll", position, { passive: true });
    listen(window, "yt-navigate-start", function () { close(false); });
    listen(window, "yt-navigate-finish", mount);
    listen(window, "popstate", function () { close(false); mount(); });
    listen(document, "fullscreenchange", function () { close(false); });
    listen(window, "pagehide", suspend);
    listen(window, "pageshow", start);
    render(); renderChannels(); start();
    return { configure: configure, open: open, close: close, stop: function () {
      if (stopped) return;
      suspend(); stopped = true; blocksSerial++; displaySettings.stop();
      if (chrome.storage.onChanged.removeListener) chrome.storage.onChanged.removeListener(changed);
      listeners.forEach(function (remove) { remove(); }); trigger.remove(); panel.remove();
    } };
  }
  root.FocusFeedYouTubePreferences = { create: create };
})(globalThis);
