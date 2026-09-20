"use strict";

const assert = require("node:assert/strict");

const rawBatch = {
  assessments: [
    {
      videoId: "video-2",
      topics: ["gaming"],
      contentPurpose: "entertainment",
      goalRelevance: "unrelated",
      unwantedMatch: "yes",
      evidenceSufficiency: "sufficient",
      evidence: ["Gaming appears in the title."],
      reason: "The title indicates gaming content.",
    },
    {
      videoId: "video-1",
      topics: ["algorithms"],
      contentPurpose: "tutorial",
      goalRelevance: "directly_useful",
      unwantedMatch: "no",
      evidenceSufficiency: "sufficient",
      evidence: ["Interview problems appear in the title."],
      reason: "The video directly supports interview preparation.",
    },
    {
      videoId: "video-1",
      topics: [],
      contentPurpose: "unclear",
      goalRelevance: "unclear",
      unwantedMatch: "unclear",
      evidenceSufficiency: "insufficient",
      evidence: [],
      reason: "Duplicate result.",
    },
    {
      videoId: "unexpected-video",
      topics: [],
      contentPurpose: "other",
      goalRelevance: "unrelated",
      unwantedMatch: "no",
      evidenceSufficiency: "sufficient",
      evidence: [],
      reason: "This ID was not requested.",
    },
  ],
};

const createOptionsSeen = [];
const promptOptionsSeen = [];

global.LanguageModel = {
  availability: async () => "available",
  create: async (options) => {
    createOptionsSeen.push(options);
    return ({
      prompt: async (_prompt, promptOptions) => {
        promptOptionsSeen.push(promptOptions);
        return JSON.stringify(rawBatch);
      },
      destroy() {},
    });
  },
};

const originalInfo = console.info;
console.info = () => {};
require("../local-classifier.js");

async function main() {
  const stages = [];
  const request = {
    requestId: "classifier-observability-test",
    profile: {
      id: "test",
      version: 1,
      goal: "Prepare for coding interviews",
      usefulTopics: ["algorithms"],
      unwantedTopics: ["gaming"],
      exceptions: [],
      languages: ["English"],
      mode: "focus",
    },
    videos: [
      { videoId: "video-1", title: "Interview algorithms" },
      { videoId: "video-2", title: "Gaming highlights" },
      { videoId: "video-3", title: "An unclear title" },
    ],
  };
  const response = await global.FocusFeedLocalClassifier.classify(request, {
    onStage(event) { stages.push(event); },
  });

  const variants = global.FocusFeedLocalClassifier.promptVariants;
  assert.deepEqual(variants.map((variant) => [variant.id, variant.status]), [
    ["baseline", "baseline"],
    ["few-shot-v2", "rejected"],
    ["few-shot-v3", "needs-revision"],
    ["few-shot-v4", "candidate"],
  ]);
  variants.forEach((variant) => {
    assert.ok(variant.label);
    assert.ok(variant.summary);
    assert.ok(variant.changes.length > 0, `${variant.id} must explain its changes`);
    if (variant.id !== "baseline") {
      assert.ok(variant.finding, `${variant.id} must expose its result or pending qualification state`);
    }
  });
  assert.equal(response.classifier.promptVariant, "few-shot-v4");
  assert.equal(response.classifier.promptVersion, "local-2026-09-20.3");
  assert.equal(createOptionsSeen[0].initialPrompts.length, 3, "v4 must contain one batched user/assistant few-shot pair");
  const v4ExampleInput = JSON.parse(createOptionsSeen[0].initialPrompts[1].content.split("\n").slice(1).join("\n"));
  const v4ExampleOutput = JSON.parse(createOptionsSeen[0].initialPrompts[2].content);
  assert.equal(v4ExampleInput.videos.length, 5);
  assert.equal(v4ExampleOutput.assessments.length, 5);
  assert.equal(v4ExampleInput.videos[2].videoId, "example-critical");
  assert.equal(v4ExampleOutput.assessments[2].unwantedMatch, "no");
  assert.equal(promptOptionsSeen[0].responseConstraint.properties.assessments.items.properties.evidence.maxItems, 1);
  assert.equal(promptOptionsSeen[0].responseConstraint.properties.assessments.items.properties.reason.maxLength, undefined);
  assert.equal(promptOptionsSeen[0].omitResponseConstraintInput, false);

  assert.deepEqual(
    response.assessments.map((assessment) => assessment.videoId),
    ["video-1", "video-2", "video-3"],
    "assessments must retain request order"
  );
  assert.equal(response.assessments[2].goalRelevance, "unclear");
  assert.equal(response.diagnostics.requestedAssessmentCount, 3);
  assert.equal(response.diagnostics.returnedAssessmentCount, 4);
  assert.equal(response.diagnostics.acceptedAssessmentCount, 2);
  assert.equal(response.diagnostics.missingAssessmentCount, 1);
  assert.equal(response.diagnostics.duplicateAssessmentCount, 1);
  assert.equal(response.diagnostics.unexpectedAssessmentCount, 1);
  assert.deepEqual(response.diagnostics.missingVideoIds, ["video-3"]);
  assert.deepEqual(response.diagnostics.unexpectedVideoIds, ["unexpected-video"]);
  assert.equal(response.diagnostics.rawOutput, JSON.stringify(rawBatch));

  ["totalMs", "availabilityMs", "sessionCreateMs", "inferenceMs", "parsingMs", "validationMs"].forEach((key) => {
    assert.equal(typeof response.timing[key], "number", `${key} should be measured`);
  });

  assert.deepEqual(
    stages.map((event) => `${event.id}:${event.status}`),
    [
      "availability:running", "availability:complete",
      "session:running", "session:complete",
      "inference:running", "inference:complete",
      "parsing:running", "parsing:complete",
      "validation:running", "validation:complete",
      "complete:complete",
    ]
  );

  const rejected = await global.FocusFeedLocalClassifier.classify(request, { promptVariant: "few-shot-v2" });
  assert.equal(rejected.classifier.promptVariant, "few-shot-v2");
  assert.equal(rejected.classifier.promptVersion, "local-2026-09-20.1");
  assert.equal(createOptionsSeen[1].initialPrompts.length, 7, "v2 must remain reproducible as three one-video examples");
  assert.equal(promptOptionsSeen[1].omitResponseConstraintInput, true);

  const baseline = await global.FocusFeedLocalClassifier.classify(request, { promptVariant: "baseline" });
  assert.equal(baseline.classifier.promptVariant, "baseline");
  assert.equal(baseline.classifier.promptVersion, "local-2026-09-18.1");
  assert.equal(createOptionsSeen[2].initialPrompts.length, 1, "baseline must preserve the original zero-shot prompt");
  assert.equal(promptOptionsSeen[2].responseConstraint.properties.assessments.items.properties.evidence.maxItems, 3);
  assert.equal(promptOptionsSeen[2].omitResponseConstraintInput, false);

  const v3 = await global.FocusFeedLocalClassifier.classify(request, { promptVariant: "few-shot-v3" });
  assert.equal(v3.classifier.promptVariant, "few-shot-v3");
  assert.equal(v3.classifier.promptVersion, "local-2026-09-20.2");
  assert.equal(createOptionsSeen[3].initialPrompts.length, 3, "v3 must remain reproducible as one batched example");
  const v3ExampleInput = JSON.parse(createOptionsSeen[3].initialPrompts[1].content.split("\n").slice(1).join("\n"));
  const v3ExampleOutput = JSON.parse(createOptionsSeen[3].initialPrompts[2].content);
  assert.equal(v3ExampleInput.videos.length, 4);
  assert.equal(v3ExampleOutput.assessments.length, 4);
  console.log("local classifier observability test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  console.info = originalInfo;
});
