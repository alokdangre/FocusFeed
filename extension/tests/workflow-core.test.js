"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedWorkflow;
delete global.FocusFeedWorkflowFixtures;
require("../workflow-core.js");
require("../workflow/fixtures.js");

const workflow = global.FocusFeedWorkflow;
const fixtures = global.FocusFeedWorkflowFixtures;
const now = 1_800_000_000_000;

assert.equal(workflow.normalizeChannelIdentity("  @Study   Hub "), "study hub");
assert.equal(workflow.parseDurationSec("2:30"), 150);
assert.equal(workflow.parseDurationSec("1:02:03"), 3723);
assert.equal(workflow.parseDurationSec("1:75"), null);
assert.equal(workflow.matchesLiteralKeyword("A car crash explained", "car"), true);
assert.equal(workflow.matchesLiteralKeyword("How cartoon animation works", "car"), false);

const emptyCache = {};
const warmCache = fixtures.buildWarmCache(now);

for (const fixture of fixtures.cases) {
  const cold = workflow.routeCandidate({
    video: fixture.video,
    profile: fixture.profile,
    preferences: fixture.preferences,
    classifier: fixture.classifier,
    cacheEntries: emptyCache,
    now,
  });
  assert.deepEqual(
    { route: cold.route, action: cold.action, cacheStatus: cold.cacheStatus, ruleId: cold.ruleId },
    fixture.expectedCold,
    `${fixture.id} cold route should match its visible reference`
  );

  const warm = workflow.routeCandidate({
    video: fixture.video,
    profile: fixture.profile,
    preferences: fixture.preferences,
    classifier: fixture.classifier,
    cacheEntries: warmCache,
    now,
  });
  assert.deepEqual(
    { route: warm.route, action: warm.action, cacheStatus: warm.cacheStatus, ruleId: warm.ruleId },
    fixture.expectedWarm,
    `${fixture.id} warm route should match its visible reference`
  );
}

const sharedVideo = fixtures.cases.find((item) => item.id === "cached-match-focus").video;
const focusProfile = fixtures.cases.find((item) => item.id === "cached-match-focus").profile;
const generalProfile = fixtures.cases.find((item) => item.id === "cached-match-general").profile;
const classifier = fixtures.classifier;
const focusIdentity = workflow.buildCacheIdentity(sharedVideo, focusProfile, classifier);
const generalIdentity = workflow.buildCacheIdentity(sharedVideo, generalProfile, classifier);
assert.equal(
  focusIdentity.signature,
  generalIdentity.signature,
  "mode-independent raw Jev judgments must be reusable across General and Focus policy"
);

const changedMetadataIdentity = workflow.buildCacheIdentity(
  Object.assign({}, sharedVideo, { title: sharedVideo.title + " updated" }),
  focusProfile,
  classifier
);
assert.notEqual(changedMetadataIdentity.signature, focusIdentity.signature);

const changedObjectivesIdentity = workflow.buildCacheIdentity(
  sharedVideo,
  Object.assign({}, focusProfile, {
    objectives: [{ id: "objective-1", text: "celebrity gossip", contentType: "topic" }],
  }),
  classifier
);
assert.notEqual(changedObjectivesIdentity.signature, focusIdentity.signature);

const assessment = {
  videoId: sharedVideo.videoId,
  objectiveMatches: [{
    objectiveId: "objective-1",
    text: "gaming streams",
    contentType: "content_format",
    matchProbability: 0.96,
  }],
  evidenceProbability: 0.95,
  outcome: "match",
  evidence: ["Title metadata"],
  reason: "Matched.",
};
assert.equal(workflow.policyDecision(assessment, "general"), "hide");
assert.equal(workflow.policyDecision(assessment, "focus"), "show");

assert.equal(workflow.assessmentOutcome({
  objectiveMatches: [{ matchProbability: 0.65 }],
  evidenceProbability: 0.76,
  outcome: "match",
}), "match", "the browser should use the Jev adapter's validated outcome");
assert.equal(workflow.assessmentOutcome({
  objectiveMatches: [{ matchProbability: 0.62 }],
  evidenceProbability: 0.84,
  outcome: "no_match",
}), "no_match", "browser code must not re-threshold provider probabilities");
assert.equal(workflow.assessmentOutcome({
  objectiveMatches: [{ matchProbability: 0.59 }],
  evidenceProbability: 0.84,
}), "uncertain");

const noMatch = structuredClone(assessment);
noMatch.objectiveMatches[0].matchProbability = 0.04;
noMatch.outcome = "no_match";
assert.equal(workflow.policyDecision(noMatch, "general"), "show");
assert.equal(workflow.policyDecision(noMatch, "focus"), "hide");

const uncertain = structuredClone(assessment);
uncertain.objectiveMatches[0].matchProbability = 0.5;
uncertain.outcome = "uncertain";
assert.equal(workflow.policyDecision(uncertain, "general"), "show");
assert.equal(workflow.policyDecision(uncertain, "focus"), "hide");

const wrongVideoEntry = workflow.createCacheEntry({
  identity: focusIdentity,
  assessment: Object.assign({}, assessment, { videoId: "a-different-video" }),
  createdAt: now - 100,
  ttlMs: 10_000,
});
const wrongVideoRoute = workflow.routeCandidate({
  video: sharedVideo,
  profile: focusProfile,
  preferences: { enabled: true },
  classifier,
  cacheEntries: { [focusIdentity.key]: wrongVideoEntry },
  now,
});
assert.equal(wrongVideoRoute.route, "model_pending");
assert.equal(wrongVideoRoute.cacheStatus, "invalid");
assert.deepEqual(
  wrongVideoRoute.trace.map((event) => `${event.stage}:${event.status}`),
  ["normalize:complete", "rule:miss", "cache:invalid", "metadata:sufficient", "queue:eligible"]
);

console.log(`workflow core test passed (${fixtures.cases.length} General/Focus fixtures, cold and warm)`);
