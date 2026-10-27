"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require("../video-model.js");
const V = FocusFeedVideo;
const assessment = () => ({ videoId: "one", reason: "Specific topic match", outcome: "match",
  objectiveMatches: [{ objectiveId: "intent-review", text: "movie reviews", contentType: "topic", matchProbability: .9 }] });
test("metadata is bounded and fingerprint ignores UI-only aliases but detects meaningful changes", () => {
  const raw = { videoId: "one", title: "  Movie   review  ", description: "x".repeat(1200), channel: "Creator", aliases: ["@one"] };
  const video = V.videoInput(raw);
  assert.equal(video.title, "Movie review"); assert.equal(video.description.length, 1000);
  assert.equal(V.fingerprint(raw), V.fingerprint({ ...raw, aliases: ["@two"] }));
  assert.notEqual(V.fingerprint(raw), V.fingerprint({ ...raw, title: "Movie trailer" }));
  assert.equal(V.hasMinimumModelMetadata(V.videoInput({ videoId: "one", title: "  " })), false);
});
test("invalid, duplicate and mismatched assessments never reach the policy layer", () => {
  assert.equal(V.isValidDecisionAssessment(assessment(), "one"), true);
  assert.equal(V.isValidDecisionAssessment(assessment(), "two"), false);
  for (const value of [NaN, Infinity, -.1, 1.1, true]) {
    const a = assessment(); a.objectiveMatches[0].matchProbability = value;
    assert.equal(V.isValidDecisionAssessment(a, "one"), false);
  }
  const duplicate = assessment(); duplicate.objectiveMatches.push({ ...duplicate.objectiveMatches[0] });
  assert.equal(V.isValidDecisionAssessment(duplicate, "one"), false);
});
test("General and Focus preserve opposite match and uncertainty policies", () => {
  for (const [outcome, general, focus] of [["match", "hide", "show"], ["no_match", "show", "hide"], ["uncertain", "show", "hide"]]) {
    assert.equal(V.policyDecision({ outcome }, "general"), general);
    assert.equal(V.policyDecision({ outcome }, "focus"), focus);
  }
  assert.equal(V.uncertaintyAction("general"), "show"); assert.equal(V.uncertaintyAction("focus"), "hide");
});
