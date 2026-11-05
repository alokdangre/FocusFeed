// Shared by the popup and YouTube editor. Only the worker commits saved policy.
(function (root) {
  "use strict";
  var DEFAULT_ENDPOINT = "http://127.0.0.1:3000";
  async function request(message) {
    var response = await chrome.runtime.sendMessage(message);
    if (!response || !response.ok) throw new Error(response && response.error && response.error.message ||
      "Could not reach FocusFeed. Reload the extension and YouTube, then try again.");
    return response.data;
  }
  function texts(profile) {
    return (profile && profile.objectives || []).flatMap(function (o) {
      return (o.sourceText || o.text || "").split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    });
  }
  function draft(profile) {
    return { topics: texts(profile), duration: profile && profile.sessionDurationMinutes !== undefined ? profile.sessionDurationMinutes : 45 };
  }
  async function save(options) {
    var topics = options.topics.slice(), mode = options.mode, duration = Number(options.duration);
    if (!options.state || !["general", "focus"].includes(mode)) throw new Error("Load your preferences before saving.");
    if (!topics.length) throw new Error("Add at least one topic to get started.");
    if (topics.length > 8) throw new Error("Use up to 8 topics. Remove a tag to make room.");
    if (topics.some(function (s) { return typeof s !== "string" || !s.trim() || s.length > 160; })) throw new Error("Use 160 characters or fewer per topic.");
    if (!Number.isInteger(duration) || duration < 0 || duration > 480) throw new Error("Choose a duration from 0 to 480 minutes.");
    var original = options.state[mode], objectives = original.objectives, endpoint;
    function current() {
      if (options.isCurrent && !options.isCurrent()) throw new Error("Your preferences changed during validation. Save the current topics again.");
    }
    var unchanged = FocusFeedSettings.valid(original) && original.objectives.every(function (o) { return o.matchScope === "intent"; }) &&
      JSON.stringify(topics) === JSON.stringify(texts(original));
    if (!unchanged) {
      if (options.beforeValidate) await options.beforeValidate();
      endpoint = (await chrome.storage.local.get({ classifierEndpoint: DEFAULT_ENDPOINT })).classifierEndpoint;
      current();
      var id = "objectives-" + Date.now() + "-" + Math.random().toString(16).slice(2);
      var result = await request({ type: "OBJECTIVES_CLASSIFY_CLOUD", request: { requestId: id, mode: mode, objectives: topics } });
      if (!result || result.requestId !== id || !Array.isArray(result.objectives) || result.objectives.length !== topics.length ||
          result.objectives.some(function (a, i) {
            return !a || a.text !== topics[i] || !Number.isFinite(a.nonsenseProbability) || a.nonsenseProbability < 0 || a.nonsenseProbability > 1 ||
              !["ready_for_confirmation", "needs_clarification"].includes(a.status) ||
              (a.status === "ready_for_confirmation") !== (a.nonsenseProbability < 0.70);
          })) throw new Error("The validator returned an incomplete response. Nothing has been saved.");
      current();
      await chrome.storage.local.set({ focusfeedObjectiveValidationV1: {
        savedAt: Date.now(), requestedMode: mode, requestedObjectives: topics, response: result
      } });
      if (options.onValidation) options.onValidation(result.objectives);
      if (result.objectives.some(function (a) { return a.status !== "ready_for_confirmation"; })) {
        throw new Error("Edit the highlighted topics, then save again. Nothing has been saved.");
      }
      objectives = result.objectives.map(function (a) {
        var o = a.validatedObjective;
        if (!FocusFeedSettings.validObjective(o) || o.matchScope !== "intent" || o.text !== a.text) {
          throw new Error("The validator returned an incomplete response. Nothing has been saved.");
        }
        return { id: o.id, text: o.text, sourceText: o.text, contentType: "topic", matchScope: "intent", validationVersion: o.validationVersion };
      });
    }
    current();
    return request({ type: "FF_SETTINGS_UPDATE", expectedProfileVersion: original.version, expectedEndpoint: endpoint,
      action: { type: "saveProfile", profile: { id: mode, mode: mode, version: Math.max(1, original.version + 1),
        objectives: objectives, sessionDurationMinutes: duration } } });
  }
  root.FocusFeedPreferences = { request: request, texts: texts, draft: draft, save: save };
})(globalThis);
