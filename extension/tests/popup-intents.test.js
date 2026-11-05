"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { dom } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
function accepted(text, i) {
  return { objectiveId: "objective-" + i, text, status: "ready_for_confirmation", nonsenseProbability: 0.02, reason: "Clear preference.",
    validatedObjective: { id: "intent-" + i, text, sourceText: text, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" } };
}
async function setup(t, validate) {
  const html = fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8");
  const h = dom(html); t.after(h.cleanup);
  h.load("settings.js");
  let state = h.context.FocusFeedSettings.migrate({}), data = {}, onChanged;
  const saved = [], requests = [];
  h.context.chrome = { runtime: { lastError: null, getURL: p => "chrome-extension://test/" + p,
    sendMessage(message, callback) {
      const result = (async () => {
        if (message.type === "FF_SETTINGS_GET") return { ok: true, data: state };
        if (message.type === "FF_SETTINGS_UPDATE") {
          state = h.context.FocusFeedSettings.update(state, message.action);
          if (message.action.type === "saveProfile") saved.push(message.action.profile);
          return { ok: true, data: state };
        }
        if (message.type === "OBJECTIVES_CLASSIFY_CLOUD") {
          requests.push(message.request);
          const response = validate ? await validate(message.request) : message.request.objectives.map(accepted);
          return { ok: true, data: { requestId: message.request.requestId, objectives: response } };
        }
        throw new Error("Unexpected message " + message.type);
      })();
      if (callback) result.then(callback); else return result;
    } }, storage: { local: {
      get: async defaults => ({ ...defaults, ...data }),
      set(values, callback) { Object.assign(data, values); if (callback) callback(); return Promise.resolve(); }
    }, onChanged: { addListener(fn) { onChanged = fn; } } },
    tabs: { query(_options, callback) { if (callback) callback([]); else return Promise.resolve([]); }, create: async () => {} } };
  h.load("preferences-controller.js", "popup/topic-input.js", "popup/popup.js"); await settle();
  const input = h.document.getElementById("objectiveInput");
  const enter = text => { input.value = text; input.dispatchEvent(new h.window.Event("input")); };
  const save = () => h.document.getElementById("saveGoal").click();
  function remote(profile) {
    state = h.context.FocusFeedSettings.update(state, { type: "saveProfile", profile });
    onChanged({ focusfeedSettingsV2: { newValue: state } }, "local");
  }
  return { ...h, input, enter, save, saved, requests, remote, feedback: () => h.document.getElementById("profileFeedback").textContent };
}
test("comma and newline preferences are validated then saved distinctly in the user's words", async t => {
  const h = await setup(t); h.enter("movie reviews, movie trailers\nSumerian cuneiform tutorials, MOVIE REVIEWS"); h.save(); await settle(); await settle();
  assert.deepEqual(Array.from(h.requests[0].objectives), ["movie reviews", "movie trailers", "Sumerian cuneiform tutorials"]);
  assert.equal(h.saved.length, 1);
  assert.deepEqual(Array.from(h.saved[0].objectives, o => o.text), Array.from(h.requests[0].objectives));
  assert.ok(h.saved[0].objectives.every(o => o.matchScope === "intent" && !o.taxonomyId));
  h.save(); await settle(); assert.equal(h.requests.length, 1, "unchanged validated preferences do not incur another validation");
});
test("an unclear entry blocks saving the entire draft and displays its clarification", async t => {
  const h = await setup(t, request => [accepted(request.objectives[0], 0),
    { text: request.objectives[1], status: "needs_clarification", nonsenseProbability: 0.95, reason: "Describe a concrete subject.", validatedObjective: null }]);
  h.enter("movie reviews, do better"); h.save(); await settle();
  assert.equal(h.saved.length, 0); assert.match(h.feedback(), /Nothing has been saved/);
  assert.match(h.document.getElementById("validationResults").textContent, /Describe a concrete subject/);
  assert.match(h.document.getElementById("validationResults").textContent, /Nonsense probability: 95.0%/);
  assert.match(h.document.getElementById("validationResults").textContent, /Nonsense probability: 2.0%/);
  h.save(); await settle(); assert.equal(h.saved.length, 0);
});
test("YouTube settings changes refresh a clean popup and retain an edited popup draft", async t => {
  const h = await setup(t); h.enter("Movie reviews"); h.save(); await settle(); await settle();
  h.remote({ ...h.saved[0], objectives: [accepted("Guitar lessons", 0).validatedObjective] });
  assert.deepEqual(tags(h), ["Guitar lessons"]);
  h.enter("Gaming streams");
  h.remote({ ...h.saved[0], objectives: [accepted("Sports", 0).validatedObjective] });
  assert.deepEqual(tags(h), ["Guitar lessons"]); assert.equal(h.input.value, "Gaming streams");
  assert.match(h.feedback(), /draft is preserved/);
});
test("broad formats save with their returned percentage; invalid probabilities cannot save", async t => {
  const h = await setup(t);
  h.enter("review, movie TV revisits"); h.save(); await settle();
  assert.equal(h.saved.length, 1);
  assert.deepEqual(Array.from(h.saved[0].objectives, o => o.text), ["review", "movie TV revisits"]);
  assert.match(h.document.getElementById("validationResults").textContent, /Accepted · Nonsense probability: 2.0%/);
  for (const probability of [undefined, NaN, 1.1, -0.1, true, 0.7]) {
    const broken = await setup(t, request => [{ ...accepted(request.objectives[0], 0), nonsenseProbability: probability }]);
    broken.enter("review"); broken.save(); await settle();
    assert.equal(broken.saved.length, 0, "Invalid or contradictory probability: " + probability);
    assert.match(broken.feedback(), /incomplete response/);
  }
});
test("editing while validation is in flight cannot save the stale response", async t => {
  let resolve;
  const h = await setup(t, () => new Promise(r => { resolve = r; }));
  h.enter("movie reviews"); h.save(); await settle(); h.enter("DSA tutorials");
  resolve([accepted("movie reviews", 0)]); await settle();
  assert.equal(h.saved.length, 0); assert.match(h.feedback(), /changed during validation/);
});
test("missing or reordered validation results cannot save a different preference", async t => {
  const h = await setup(t, () => [accepted("all movies", 0)]);
  h.enter("movie reviews"); h.save(); await settle();
  assert.equal(h.saved.length, 0); assert.match(h.feedback(), /incomplete response/);
});
test("starting Focus validates new preferences before the session starts", async t => {
  const h = await setup(t);
  h.document.querySelector('[data-mode="focus"]').click();
  h.enter("DSA tutorials"); h.document.getElementById("toggleSession").click(); await settle(); await settle();
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].mode, "focus");
  assert.equal(h.document.getElementById("toggleSession").textContent, "End Focus");
});
function key(h, value, options = {}) {
  const event = new h.window.Event("keydown", { cancelable: true });
  Object.assign(event, { key: value, ...options }); h.input.dispatchEvent(event);
  return event;
}
function tags(h) { return Array.from(h.document.querySelectorAll(".topic-tag-label"), node => node.textContent); }
test("tag keyboard editing, duplicate entry and removal preserve the submitted topics", async t => {
  const h = await setup(t);
  h.enter("Movie reviews"); assert.equal(key(h, ",").defaultPrevented, true);
  h.enter("Guitar lessons"); key(h, "Enter");
  h.enter("MOVIE REVIEWS"); key(h, "Enter");
  assert.deepEqual(tags(h), ["Movie reviews", "Guitar lessons"]);
  key(h, "Backspace"); assert.equal(h.input.value, "Guitar lessons");
  h.enter("Guitar tutorials"); key(h, "Enter");
  h.document.querySelector('[aria-label="Remove Movie reviews"]').click();
  h.save(); await settle();
  assert.deepEqual(Array.from(h.requests[0].objectives), ["Guitar tutorials"]);
});
test("pasting a list replaces the selection, keeps surrounding text and creates tags", async t => {
  const h = await setup(t); h.enter("Movie old trailers");
  h.input.selectionStart = 6; h.input.selectionEnd = 9;
  const event = new h.window.Event("paste", { cancelable: true });
  event.clipboardData = { getData: () => "reviews\ngaming streams, movie" };
  h.input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(tags(h), ["Movie reviews", "gaming streams", "movie trailers"]);
  h.save(); await settle();
  assert.deepEqual(Array.from(h.requests[0].objectives), tags(h));
});
test("composition input waits for completion before separating topics", async t => {
  const h = await setup(t);
  h.input.dispatchEvent(new h.window.Event("compositionstart"));
  h.enter("日本語, guitar"); assert.equal(key(h, "Enter", { isComposing: true }).defaultPrevented, false);
  assert.deepEqual(tags(h), []); assert.equal(h.input.value, "日本語, guitar");
  h.input.dispatchEvent(new h.window.Event("compositionend"));
  assert.deepEqual(tags(h), ["日本語"]); assert.equal(h.input.value, " guitar");
  key(h, "Enter"); assert.deepEqual(tags(h), ["日本語", "guitar"]);
});
test("General and Focus preserve unsaved drafts and duration through mode switches", async t => {
  const h = await setup(t); h.enter("Movie reviews");
  h.document.querySelector('[data-mode="focus"]').click();
  h.document.querySelector("#topicSuggestions button").click();
  h.document.querySelector('[data-minutes="25"]').click();
  h.enter("Graph algorithms");
  h.document.querySelector('[data-mode="general"]').click();
  assert.deepEqual(tags(h), ["Movie reviews"]);
  h.save(); await settle();
  h.document.querySelector('[data-mode="focus"]').click();
  assert.deepEqual(tags(h), ["DSA tutorials", "Graph algorithms"]);
  assert.equal(h.document.getElementById("sessionDuration").value, "25");
  h.document.getElementById("toggleSession").click(); await settle(); await settle();
  assert.deepEqual(Array.from(h.saved, p => p.mode), ["general", "focus"]);
  assert.equal(h.saved[1].sessionDurationMinutes, 25);
  h.document.getElementById("toggleSession").click(); await settle();
  assert.deepEqual(tags(h), ["Movie reviews"]);
});
test("over-limit topics remain editable and make no provider request", async t => {
  const h = await setup(t); h.enter(Array.from({ length: 9 }, (_, i) => "Topic " + i).join(","));
  h.save(); await settle();
  assert.equal(tags(h).length, 9); assert.equal(h.requests.length, 0);
  assert.match(h.document.getElementById("topicError").textContent, /up to 8/);
  for (const button of Array.from(h.document.querySelectorAll(".topic-remove"))) {
    // Rendering replaces button nodes after each removal.
    h.document.querySelector(".topic-remove").click();
  }
  h.enter("x".repeat(161)); h.save(); await settle();
  assert.equal(tags(h)[0].length, 161); assert.equal(h.requests.length, 0);
  assert.match(h.document.getElementById("topicError").textContent, /160 characters/);
});
