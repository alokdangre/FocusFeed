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
assert.equal(workflow.parseDurationSec(""), null);
assert.equal(workflow.matchesLiteralKeyword("A car crash explained", "car"), true);
assert.equal(workflow.matchesLiteralKeyword("How cartoon animation works", "car"), false);
assert.equal(workflow.matchesLiteralKeyword("C++ [beginner] guide", "C++ [beginner]"), true);

const emptyCache = {};
const warmCache = fixtures.buildWarmCache(now);
assert.equal(typeof fixtures.buildInvalidationCache, "function");

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

const invalidationOnlyCache = fixtures.buildInvalidationCache(now);
for (const fixture of fixtures.cases.filter((item) => item.cacheSeed === "compatible")) {
  const route = workflow.routeCandidate({
    video: fixture.video,
    profile: fixture.profile,
    preferences: fixture.preferences,
    classifier: fixture.classifier,
    cacheEntries: invalidationOnlyCache,
    now,
  });
  assert.equal(route.cacheStatus, "miss", `${fixture.id} must not receive a synthetic compatible cache hit`);
}

const sharedVideo = fixtures.cases.find((item) => item.id === "cached-focus").video;
const focusProfile = fixtures.cases.find((item) => item.id === "cached-focus").profile;
const balancedProfile = fixtures.cases.find((item) => item.id === "cached-balanced").profile;
const classifier = fixtures.classifier;

const focusIdentity = workflow.buildCacheIdentity(sharedVideo, focusProfile, classifier);
const balancedIdentity = workflow.buildCacheIdentity(sharedVideo, balancedProfile, classifier);
assert.notEqual(
  focusIdentity.signature,
  balancedIdentity.signature,
  "mode is currently part of the provider request, so changing it must invalidate the assessment cache"
);

const changedMetadataIdentity = workflow.buildCacheIdentity(
  Object.assign({}, sharedVideo, { title: sharedVideo.title + " updated" }),
  focusProfile,
  classifier
);
assert.notEqual(changedMetadataIdentity.signature, focusIdentity.signature);
assert.notEqual(changedMetadataIdentity.key, focusIdentity.key);

const changedProviderIdentity = workflow.buildCacheIdentity(sharedVideo, focusProfile, Object.assign({}, classifier, {
  provider: "bedrock",
  model: "amazon.nova-micro-v1:0",
}));
assert.notEqual(changedProviderIdentity.signature, focusIdentity.signature);

const wrongVideoEntry = workflow.createCacheEntry({
  identity: focusIdentity,
  assessment: {
    videoId: "a-different-video",
    goalRelevance: "unrelated",
    unwantedMatch: "yes",
    evidenceSufficiency: "sufficient",
    evidence: ["Wrong video"],
  },
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
assert.equal(wrongVideoRoute.route, "model_pending", "a cached assessment for another video must not resolve this candidate");
assert.equal(wrongVideoRoute.cacheStatus, "invalid");
assert.deepEqual(
  wrongVideoRoute.trace.map((event) => `${event.stage}:${event.status}`),
  ["normalize:complete", "rule:miss", "cache:invalid", "metadata:sufficient", "queue:eligible"]
);

const malformedExpiryRoute = workflow.routeCandidate({
  video: sharedVideo,
  profile: focusProfile,
  preferences: { enabled: true },
  classifier,
  cacheEntries: {
    [focusIdentity.key]: Object.assign({}, wrongVideoEntry, {
      assessment: Object.assign({}, wrongVideoEntry.assessment, { videoId: sharedVideo.videoId }),
      expiresAt: "not-a-timestamp",
    }),
  },
  now,
});
assert.equal(malformedExpiryRoute.route, "model_pending", "malformed cache timestamps must fail open");
assert.equal(malformedExpiryRoute.cacheStatus, "invalid");

const insufficient = { evidenceSufficiency: "insufficient", unwantedMatch: "yes", goalRelevance: "unrelated" };
assert.equal(workflow.policyDecision(insufficient, "focus"), "show");
assert.equal(workflow.policyDecision({ evidenceSufficiency: "sufficient", unwantedMatch: "no", goalRelevance: "unrelated" }, "focus"), "hide");
assert.equal(workflow.policyDecision({ evidenceSufficiency: "sufficient", unwantedMatch: "no", goalRelevance: "unrelated" }, "balanced"), "show");

console.log(`workflow core test passed (${fixtures.cases.length} visible fixtures, cold and warm)`);
