"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
require("../settings.js");
const S = FocusFeedSettings;
const general = { id: "old", mode: "general", version: 4, objectives: [{ id: "topic.gaming", text: "Gaming", contentType: "topic", taxonomyId: "topic.gaming", taxonomyVersion: "focusfeed-topics-v1" }] };
test("migration preserves confirmed intent; General ignores legacy session start", () => {
  const state = S.migrate({ activeProfile: general, focusSession: { active: false } });
  assert.deepEqual(state.general, general); assert.equal(S.effective(state).mode, "general"); assert.equal(state.enabled, true);
  const existing = S.migrate({ focusfeedSettingsV2: state, enabled: false }); assert.deepEqual(existing, state);
});
test("separate Focus profile, expiry, end and pause survive serialization", () => {
  let state = S.migrate({ activeProfile: general });
  state = S.update(state, { type: "saveProfile", profile: { ...general, mode: "focus", sessionDurationMinutes: 1 } }, 1000);
  state = S.update(state, { type: "startFocus" }, 1000);
  state = JSON.parse(JSON.stringify(state));
  assert.equal(S.effective(state, 2000).mode, "focus"); assert.equal(S.effective(state, 61001).mode, "general");
  assert.deepEqual(state.general, general);
  state = S.update(state, { type: "endFocus" }, 2000); assert.equal(S.effective(state, 2000).mode, "general");
  state = S.update(state, { type: "setEnabled", enabled: false }); assert.equal(state.enabled, false); assert.equal(state.revision, 5);
  assert.throws(() => S.update(state, { type: "saveProfile", profile: {} }), /Confirm/);
});
test("migrate legacy Focus does not invent a General profile", () => {
  const state = S.migrate({ activeProfile: { ...general, mode: "focus" }, focusSession: { active: true } });
  assert.equal(S.effective(state).mode, "focus"); assert.equal(S.valid(state.general), false);
});
test("Hide Shorts is an independent persisted preference and migrates without changing confirmed profiles", () => {
  let state = S.migrate({ activeProfile: general });
  state = S.update(state, { type: "setHideShorts", enabled: true });
  assert.equal(S.migrate({ focusfeedSettingsV2: JSON.parse(JSON.stringify(state)) }).hideShorts, true);
  assert.deepEqual(state.general, general);
  state = S.update(state, { type: "setHideShorts", enabled: false }); assert.equal(state.hideShorts, false);
});

test("validated direct preferences retain exact wording and do not require taxonomy IDs", () => {
  const objective = { id: "intent-review", text: "movie reviews", sourceText: "movie reviews", contentType: "topic",
    matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
  const profile = { id: "general", mode: "general", version: 1, objectives: [objective, { ...objective, id: "intent-trailer", text: "movie trailers", sourceText: "movie trailers" }] };
  const state = S.update(S.migrate({}), { type: "saveProfile", profile });
  assert.deepEqual(state.general.objectives, profile.objectives);
  assert.equal(S.valid(S.migrate({ focusfeedSettingsV2: JSON.parse(JSON.stringify(state)) }).general), true);
  assert.equal(S.validObjective({ ...objective, validationVersion: "old" }), false);
  assert.equal(S.validObjective({ ...objective, taxonomyId: "topic.film_tv" }), false);
  assert.equal(S.validObjective({ ...objective, sourceText: "all movies" }), false);
  assert.equal(S.valid({ ...profile, objectives: [objective, objective] }), false);
});
