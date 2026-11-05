"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, videoCard } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const header = '<ytd-masthead><div id="end"><div id="buttons"><button id="native-create">Create</button></div><button id="avatar">Account</button></div></ytd-masthead>';
function accepted(text, i) {
  return { text, status: "ready_for_confirmation", nonsenseProbability: .02, reason: "Recognizable subject.",
    validatedObjective: { id: "intent-" + i, text, sourceText: text, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" } };
}
function setup(t, options = {}) {
  const h = dom((options.noHeader ? "" : header) + videoCard("one") + '<video id="playing"></video>');
  h.load("settings.js", "preferences-controller.js", "display-settings.js", "popup/topic-input.js", "youtube-preferences.js");
  let state = h.context.FocusFeedSettings.migrate({}), failUpdate = false;
  const requests = [], listeners = new Set(), stored = { focusFeedChannelBlocksV1: [] };
  function changed(values) { listeners.forEach(fn => fn(values, "local")); }
  h.context.chrome = {
    storage: { local: {
      get: async defaults => ({ ...defaults, ...stored }),
      set: async values => { Object.assign(stored, values); }
    }, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    runtime: { sendMessage: async message => {
      requests.push(message);
      try {
        if (message.type === "FF_SETTINGS_GET") {
          if (options.failLoad) throw new Error("Extension unavailable. Reload and retry.");
          return { ok: true, data: state };
        }
        if (message.type === "OBJECTIVES_CLASSIFY_CLOUD") {
          const objectives = options.validate ? await options.validate(message.request) : message.request.objectives.map(accepted);
          return { ok: true, data: { requestId: message.request.requestId, objectives } };
        }
        if (message.type === "FF_SETTINGS_UPDATE") {
          if (failUpdate) throw new Error("Could not save. Try again.");
          const target = message.action.type === "startFocus" ? "focus" : message.action.profile && message.action.profile.mode;
          if (message.expectedProfileVersion !== undefined && state[target].version !== message.expectedProfileVersion) throw new Error("Saved topics changed in another tab. Review your draft and save again.");
          state = h.context.FocusFeedSettings.update(state, message.action);
          changed({ focusfeedSettingsV2: { newValue: state } });
          return { ok: true, data: state };
        }
        if (message.type === "FF_BLOCK_REMOVE") {
          stored.focusFeedChannelBlocksV1 = stored.focusFeedChannelBlocksV1.filter(block => block.id !== message.id);
          changed({ focusFeedChannelBlocksV1: { newValue: stored.focusFeedChannelBlocksV1 } });
          return { ok: true };
        }
        if (message.type === "FF_OPEN_PREFERENCES") return { ok: true, data: {} };
        throw new Error("Unexpected request: " + message.type);
      } catch (error) { return { ok: false, error: { message: error.message } }; }
    } }
  };
  const ui = h.context.FocusFeedYouTubePreferences.create({ reviewHidden: options.reviewHidden || (() => true) });
  if (!options.unconfigured) ui.configure(state);
  t.after(() => { ui.stop(); h.cleanup(); });
  const panel = () => h.document.querySelector("#focusfeed-preferences");
  const input = () => h.document.querySelector("#focusfeed-preferences-input");
  const enter = value => { input().value = value; input().dispatchEvent(new h.window.Event("input")); };
  const save = () => panel().querySelector(".focusfeed-preferences-actions button").click();
  const modes = mode => panel().querySelector('[data-mode="' + mode + '"]').click();
  const feedback = () => panel().querySelector(".focusfeed-preferences-message").textContent;
  const tags = () => Array.from(panel().querySelectorAll(".topic-tag-label"), node => node.textContent);
  function remote(action) {
    state = h.context.FocusFeedSettings.update(state, action);
    changed({ focusfeedSettingsV2: { newValue: state } });
  }
  return { ...h, ui, requests, listeners, stored, options, panel, input, enter, save, modes, feedback, tags, remote,
    get state() { return state; }, set failUpdate(value) { failUpdate = value; } };
}
async function saved(h, value = "Movie reviews") { h.ui.open(); h.enter(value); h.save(); await settle(); await settle(); }
function key(h, node, value) {
  const event = new h.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value }); node.dispatchEvent(event); return event;
}
test("header integration preserves native controls and cards and mounts only once", async t => {
  const h = setup(t), native = h.document.querySelector("#native-create"), card = h.document.querySelector("ytd-rich-item-renderer");
  const markup = card.outerHTML;
  const trigger = h.document.querySelector("#focusfeed-preferences-button");
  assert.equal(trigger.parentNode.id, "buttons"); assert.match(trigger.textContent, /OwnFeed.*Set up/);
  h.window.dispatchEvent(new h.window.Event("yt-navigate-finish"));
  assert.equal(h.document.querySelectorAll("#focusfeed-preferences-button").length, 1);
  assert.equal(h.document.querySelector("#native-create"), native); assert.equal(card.outerHTML, markup);
  trigger.click(); assert.equal(h.panel().hidden, false); assert.equal(trigger.getAttribute("aria-expanded"), "true");
  h.enter("movie reviews, Gaming streams"); assert.equal(h.requests.length, 0, "typing never calls the provider");
  h.save(); await settle(); await settle();
  assert.equal(h.state.general.objectives.length, 2);
  assert.deepEqual(Array.from(h.state.general.objectives, o => o.text), ["movie reviews", "Gaming streams"]);
  assert.match(trigger.textContent, /On/); assert.equal(h.feedback(), "Saved.");
  const validated = h.requests.filter(m => m.type === "OBJECTIVES_CLASSIFY_CLOUD").length;
  h.save(); await settle(); assert.equal(h.requests.filter(m => m.type === "OBJECTIVES_CLASSIFY_CLOUD").length, validated);
});
test("drafts survive dismissal, navigation, mode switching and failed saves", async t => {
  const h = setup(t); h.ui.open(); h.enter("Movie reviews"); h.modes("focus"); h.enter("DSA tutorials");
  h.panel().querySelector('[data-minutes="25"]').click(); h.ui.close();
  h.window.dispatchEvent(new h.window.Event("yt-navigate-start")); h.window.dispatchEvent(new h.window.Event("yt-navigate-finish"));
  h.ui.open(); assert.equal(h.input().value, "DSA tutorials");
  h.modes("general"); assert.deepEqual(h.tags(), ["Movie reviews"]);
  h.failUpdate = true; h.save(); await settle(); assert.match(h.feedback(), /Could not save/); assert.deepEqual(h.tags(), ["Movie reviews"]);
  h.failUpdate = false; h.save(); await settle(); await settle();
  h.modes("focus"); assert.deepEqual(h.tags(), ["DSA tutorials"]);
  assert.equal(h.panel().querySelector("#focusfeed-preferences-duration").value, "25");
});
test("invalid and stale validation never changes saved policy or starts Focus", async t => {
  let finish;
  const h = setup(t, { validate: () => new Promise(resolve => { finish = resolve; }) });
  h.ui.open("focus"); h.enter("Movie reviews");
  h.panel().querySelector(".focusfeed-preferences-actions button + button").click(); await settle();
  h.enter("DSA tutorials"); finish([accepted("Movie reviews", 0)]); await settle();
  assert.equal(h.state.focus.version, 0); assert.equal(h.state.focusSession.active, false);
  assert.match(h.feedback(), /changed during validation/);
  h.options.validate = request => request.objectives.map(text => ({ text, status: "needs_clarification", nonsenseProbability: .95, reason: "Describe a subject." }));
  h.save(); await settle();
  assert.equal(h.state.focus.version, 0); assert.match(h.panel().querySelector(".focusfeed-preferences-validation").textContent, /Describe a subject/);
  assert.equal(h.panel().querySelector(".topic-tag").hasAttribute("data-invalid"), true);
  assert.deepEqual(h.tags(), ["Movie reviews", "DSA tutorials"]);
});
test("cross-tab updates refresh clean editors and preserve dirty drafts", async t => {
  const h = setup(t); await saved(h);
  const profile = { ...h.state.general, objectives: [accepted("Guitar lessons", 0).validatedObjective] };
  h.remote({ type: "saveProfile", profile }); assert.deepEqual(h.tags(), ["Guitar lessons"]);
  h.enter("Gaming streams");
  h.remote({ type: "saveProfile", profile: { ...profile, objectives: [accepted("Sports", 0).validatedObjective] } });
  assert.equal(h.input().value, "Gaming streams"); assert.deepEqual(h.tags(), ["Guitar lessons"]); assert.match(h.feedback(), /draft is preserved/);
  h.save(); await settle(); await settle();
  assert.deepEqual(Array.from(h.state.general.objectives, o => o.text), ["Guitar lessons", "Gaming streams"]);
});
test("a profile changed elsewhere while validation runs cannot be overwritten", async t => {
  let finish;
  const h = setup(t, { validate: () => new Promise(resolve => { finish = resolve; }) });
  h.ui.open(); h.enter("Movie reviews"); h.save(); await settle();
  h.remote({ type: "saveProfile", profile: { ...h.state.general, version: 1, objectives: [accepted("Sports", 0).validatedObjective] } });
  finish([accepted("Movie reviews", 0)]); await settle(); await settle();
  assert.equal(h.state.general.objectives[0].text, "Sports"); assert.deepEqual(h.tags(), ["Movie reviews"]);
  assert.match(h.feedback(), /another tab/);
});
test("Focus starts after validation, reports time, ends in General and retains both profiles", async t => {
  const h = setup(t); await saved(h);
  h.modes("focus"); h.enter("DSA tutorials"); h.panel().querySelector('[data-minutes="25"]').click();
  h.panel().querySelector(".focusfeed-preferences-actions button + button").click(); await settle(); await settle();
  assert.equal(h.state.focusSession.active, true);
  assert.match(h.document.querySelector("#focusfeed-preferences-button").textContent, /Focus.*25 min/);
  assert.match(h.panel().querySelector(".focusfeed-preferences-session").textContent, /25 min/);
  h.panel().querySelector(".focusfeed-preferences-actions button + button").click(); await settle();
  assert.equal(h.state.focusSession.active, false); assert.deepEqual(h.tags(), ["Movie reviews"]);
  assert.equal(h.state.focus.objectives[0].text, "DSA tutorials");
  h.modes("focus"); h.panel().querySelector("#focusfeed-preferences-duration").value = "0";
  h.panel().querySelector(".focusfeed-preferences-actions button + button").click(); await settle(); await settle();
  assert.equal(h.state.focusSession.endsAt, null); assert.match(h.panel().querySelector(".focusfeed-preferences-session").textContent, /until you end it/);
});
test("instant switches persist without validation and roll back on write failure", async t => {
  const h = setup(t); h.ui.open();
  const power = h.panel().querySelector("#focusfeed-preferences-enabled"), shorts = h.panel().querySelector("#focusfeed-preferences-shorts");
  power.checked = false; power.dispatchEvent(new h.window.Event("change")); await settle();
  assert.equal(h.state.enabled, false); assert.match(h.document.querySelector("#focusfeed-preferences-button").textContent, /Paused/);
  shorts.checked = true; shorts.dispatchEvent(new h.window.Event("change")); await settle(); assert.equal(h.state.hideShorts, true);
  h.failUpdate = true; shorts.checked = false; shorts.dispatchEvent(new h.window.Event("change")); await settle();
  assert.equal(shorts.checked, true); assert.equal(shorts.disabled, false); assert.match(h.feedback(), /Could not save/);
  assert.equal(h.requests.some(m => m.type === "OBJECTIVES_CLASSIFY_CLOUD"), false);
});
test("layout controls save locally, preserve child choices, sync across tabs and recover from failed writes", async t => {
  const h = setup(t); h.ui.open(); h.enter("An unsaved topic");
  const control = key => h.panel().querySelector('[data-display-preference="' + key + '"]');
  async function toggle(key, checked) { const node = control(key); node.checked = checked; node.dispatchEvent(new h.window.Event("change")); await settle(); }
  assert.equal(h.panel().querySelectorAll('[data-display-preference]').length, 23);
  await toggle("hideRecommended", true); await toggle("hideVideoSidebar", true);
  assert.equal(h.state.hideRecommended, true); assert.equal(control("hideRecommended").disabled, true);
  await toggle("hideVideoSidebar", false);
  assert.equal(control("hideRecommended").checked, true); assert.equal(control("hideRecommended").disabled, false);
  h.remote({ type: "setDisplayPreference", key: "hideComments", enabled: true }); assert.equal(control("hideComments").checked, true);
  h.failUpdate = true; await toggle("hideComments", false);
  assert.equal(control("hideComments").checked, true); assert.equal(control("hideComments").disabled, false);
  assert.match(h.feedback(), /Could not save/); assert.equal(h.input().value, "An unsaved topic");
  assert.equal(h.requests.some(m => m.type === "OBJECTIVES_CLASSIFY_CLOUD"), false);
});
test("hiding the native header keeps settings reachable and pause returns the button to the header", async t => {
  const h = setup(t); h.ui.open();
  h.remote({ type: "setDisplayPreference", key: "hideTopHeader", enabled: true });
  const trigger = h.document.querySelector("#focusfeed-preferences-button");
  assert.equal(trigger.parentNode, h.document.body); assert.equal(trigger.hasAttribute("data-floating"), true);
  h.ui.close(); trigger.click(); assert.equal(h.panel().hidden, false);
  h.remote({ type: "setEnabled", enabled: false });
  assert.equal(trigger.parentNode.id, "buttons"); assert.equal(trigger.hasAttribute("data-floating"), false);
  h.remote({ type: "setEnabled", enabled: true }); assert.equal(trigger.parentNode, h.document.body);
  h.remote({ type: "setDisplayPreference", key: "hideTopHeader", enabled: false });
  assert.equal(trigger.parentNode.id, "buttons");
});
test("blocked channels use text labels, unblock the selected ID and review stays on YouTube", async t => {
  let reviewing = 0;
  const h = setup(t, { reviewHidden: () => { reviewing++; return true; } });
  h.stored.focusFeedChannelBlocksV1 = [{ id: "one", channelId: "@one", channelLabel: "<img src=x>", scope: "global" },
    { id: "two", channelId: "@two", scope: "global" }];
  h.ui.open(); await settle();
  assert.equal(h.panel().querySelector("img"), null);
  h.panel().querySelector(".focusfeed-preferences-channel button").click(); await settle();
  assert.equal(h.stored.focusFeedChannelBlocksV1.length, 1); assert.equal(h.stored.focusFeedChannelBlocksV1[0].id, "two");
  const review = Array.from(h.panel().querySelectorAll("button")).find(node => node.textContent === "Review filtered videos");
  review.click(); assert.equal(reviewing, 1); assert.equal(h.panel().hidden, true);
  assert.equal(h.requests.some(m => m.type === "FF_OPEN_PREFERENCES"), false);
});
test("Escape restores focus, typing does not reach page shortcuts, and outside clicks dismiss", t => {
  const h = setup(t); let focused, shortcuts = 0;
  h.window.HTMLElement.prototype.focus = function () { focused = this; };
  h.ui.open(); h.document.addEventListener("keydown", () => shortcuts++);
  key(h, h.input(), "k"); assert.equal(shortcuts, 0);
  const escape = key(h, h.input(), "Escape"); assert.equal(escape.defaultPrevented, true);
  assert.equal(h.panel().hidden, true); assert.equal(focused.id, "focusfeed-preferences-button");
  h.ui.open(); h.document.querySelector("#native-create").dispatchEvent(new h.window.Event("pointerdown", { bubbles: true }));
  assert.equal(h.panel().hidden, true);
});
test("missing/replaced headers and back-forward restoration remount without duplicates or lost drafts", async t => {
  const h = setup(t, { noHeader: true }); assert.equal(h.ui.open(), false);
  const host = h.document.createElement("div"); host.innerHTML = header; h.document.body.appendChild(host); await sleep(130);
  assert.ok(h.document.querySelector("#focusfeed-preferences-button")); h.ui.open(); h.enter("Movie reviews");
  h.document.querySelector("ytd-masthead").remove();
  const next = h.document.createElement("div"); next.innerHTML = header; h.document.body.appendChild(next); await sleep(130);
  assert.equal(h.document.querySelectorAll("#focusfeed-preferences-button").length, 1);
  assert.equal(h.input().value, "Movie reviews");
  h.window.dispatchEvent(new h.window.Event("pagehide")); assert.equal(h.panel().hidden, true);
  h.window.dispatchEvent(new h.window.Event("pageshow")); h.ui.open(); assert.equal(h.input().value, "Movie reviews");
  h.ui.stop(); assert.equal(h.listeners.size, 0); assert.equal(h.document.querySelector("#focusfeed-preferences-button"), null);
});
test("native popovers support light dismissal and narrow viewports stay bounded", t => {
  const h = dom(header); t.after(h.cleanup); let shows = 0, hides = 0;
  h.window.HTMLElement.prototype.showPopover = function () { shows++; };
  h.window.HTMLElement.prototype.hidePopover = function () { hides++; };
  h.window.innerWidth = 320; h.window.innerHeight = 480;
  h.context.chrome = { storage: { onChanged: { addListener() {}, removeListener() {} }, local: { get: async defaults => defaults } } };
  h.load("settings.js", "preferences-controller.js", "display-settings.js", "popup/topic-input.js", "youtube-preferences.js");
  const ui = h.context.FocusFeedYouTubePreferences.create(); t.after(() => ui.stop());
  ui.configure(h.context.FocusFeedSettings.migrate({})); ui.open();
  const panel = h.document.querySelector("#focusfeed-preferences");
  assert.equal(shows, 1); assert.equal(panel.getAttribute("popover"), "manual");
  assert.ok(parseFloat(panel.style.left) >= 12 && parseFloat(panel.style.left) + 296 <= 308);
  assert.ok(parseFloat(panel.style.top) + parseFloat(panel.style.maxHeight) <= 468);
  const event = new h.window.Event("toggle"); event.newState = "closed"; panel.dispatchEvent(event);
  assert.equal(panel.hidden, true); assert.equal(h.document.querySelector("#focusfeed-preferences-button").getAttribute("aria-expanded"), "false");
  ui.open(); ui.close(); assert.equal(hides, 1);
});
test("initial loading can be retried and advanced settings carry the selected mode", async t => {
  const h = setup(t, { unconfigured: true, failLoad: true }); h.ui.open(); await settle();
  assert.match(h.feedback(), /Extension unavailable/);
  const retry = Array.from(h.panel().querySelectorAll("button")).find(node => node.textContent === "Retry loading");
  assert.equal(retry.hidden, false); h.options.failLoad = false; retry.click(); await settle();
  assert.equal(retry.hidden, true); h.modes("general");
  Array.from(h.panel().querySelectorAll("button")).find(node => /Connection & more/.test(node.textContent)).click(); await settle();
  assert.equal(h.requests.at(-1).type, "FF_OPEN_PREFERENCES"); assert.equal(h.requests.at(-1).mode, "general");
});
