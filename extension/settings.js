// Persistent user intent, independent of tabs and filtering runs.
(function (root) {
  "use strict";
  var KEY = "focusfeedSettingsV2";
  function empty(mode) { return { id: mode, version: 0, mode: mode, objectives: [], sessionDurationMinutes: 45 }; }
  function migrate(prefs) {
    if (prefs[KEY] && prefs[KEY].schemaVersion === 2) return JSON.parse(JSON.stringify(prefs[KEY]));
    var legacy = prefs.activeProfile;
    var state = { schemaVersion: 2, revision: 1, enabled: prefs.enabled !== false,
      general: empty("general"), focus: empty("focus"), focusSession: { active: false } };
    if (legacy && legacy.mode === "focus") {
      state.focus = legacy;
      state.focusSession = prefs.focusSession || { active: false };
    } else if (legacy) state.general = legacy;
    return state;
  }
  function focusActive(state, now) {
    var session = state.focusSession || {};
    return session.active === true && (!session.endsAt || Date.parse(session.endsAt) > (now || Date.now()));
  }
  function effective(state, now) { return focusActive(state, now) ? state.focus : state.general; }
  function valid(profile) {
    return !!(profile && profile.version > 0 && Array.isArray(profile.objectives) && profile.objectives.length &&
      profile.objectives.every(function (o) { return o && o.id && o.text && o.contentType === "topic" &&
        o.taxonomyId && o.taxonomyVersion === "focusfeed-topics-v1"; }));
  }
  function update(state, action, now) {
    var next = JSON.parse(JSON.stringify(state));
    now = now || Date.now();
    if (action.type === "saveProfile") {
      if (!valid(action.profile)) throw new Error("Confirm taxonomy topics before saving.");
      var mode = action.profile.mode === "focus" ? "focus" : "general";
      next[mode] = Object.assign({}, action.profile, { mode: mode, id: mode,
        version: (Number(next[mode].version) || 0) + 1, updatedAt: new Date(now).toISOString() });
    } else if (action.type === "startFocus") {
      if (!valid(next.focus)) throw new Error("Save Focus topics first.");
      var minutes = Math.min(480, Math.max(0, Number(next.focus.sessionDurationMinutes) || 0));
      next.focusSession = { active: true, startedAt: new Date(now).toISOString(),
        endsAt: minutes ? new Date(now + minutes * 60000).toISOString() : null };
    } else if (action.type === "endFocus") next.focusSession = { active: false };
    else if (action.type === "setEnabled") next.enabled = action.enabled !== false;
    else throw new Error("Unknown settings action.");
    next.revision += 1;
    return next;
  }
  root.FocusFeedSettings = { KEY: KEY, migrate: migrate, effective: effective, focusActive: focusActive,
    valid: valid, update: update };
})(globalThis);
