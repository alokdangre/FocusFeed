"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedEvalDataset;
require("../eval/dataset.js");

const dataset = global.FocusFeedEvalDataset;
const purposes = new Set(["tutorial", "practice", "news", "commentary", "entertainment", "music", "other", "unclear"]);
const relevance = new Set(["directly_useful", "supporting", "unrelated", "unclear"]);
const unwanted = new Set(["yes", "no", "unclear"]);
const sufficiency = new Set(["sufficient", "insufficient"]);

assert.equal(dataset.version, "2026-09-20.2");
assert.equal(dataset.scenarios.length, 8);
assert.equal(dataset.scenarios.filter((scenario) => scenario.split === "development").length, 6);
assert.equal(dataset.scenarios.filter((scenario) => scenario.split === "heldout").length, 2);

const cases = dataset.scenarios.flatMap((scenario) => scenario.cases);
assert.equal(cases.length, 32);
assert.equal(new Set(cases.map((testCase) => testCase.video.videoId)).size, cases.length, "video IDs must be unique");

for (const scenario of dataset.scenarios) {
  assert.ok(["development", "heldout"].includes(scenario.split));
  assert.equal(scenario.cases.length, 4);
  assert.ok(scenario.profile.goal.length > 10);
  assert.ok(["focus", "balanced"].includes(scenario.profile.mode));

  for (const testCase of scenario.cases) {
    assert.ok(testCase.video.videoId);
    assert.ok(testCase.video.title);
    assert.equal(Object.hasOwn(testCase.video, "expected"), false, "gold labels must not be embedded in video metadata");
    assert.ok(purposes.has(testCase.expected.contentPurpose));
    assert.ok(relevance.has(testCase.expected.goalRelevance));
    assert.ok(unwanted.has(testCase.expected.unwantedMatch));
    assert.ok(sufficiency.has(testCase.expected.evidenceSufficiency));
    assert.ok(testCase.labelNote.length > 10);
  }
}

assert.ok(cases.some((testCase) => testCase.tags.includes("keyword-trap")));
assert.ok(cases.some((testCase) => testCase.tags.includes("abstention")));
assert.ok(cases.some((testCase) => testCase.tags.includes("hard-negative")));
assert.ok(cases.some((testCase) => testCase.tags.includes("exception")));

console.log("evaluation dataset integrity test passed");
