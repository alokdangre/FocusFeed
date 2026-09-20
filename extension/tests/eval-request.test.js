"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedEvalDataset;
delete global.FocusFeedEvalRequest;
require("../eval/dataset.js");
require("../eval/request-builder.js");

const scenario = global.FocusFeedEvalDataset.scenarios[0];
const request = global.FocusFeedEvalRequest.build(scenario, 2, "fixed-id");
const serialized = JSON.stringify(request);

assert.equal(request.requestId, "eval-dev-interview-focus-2-fixed-id");
assert.deepEqual(request.videos, scenario.cases.map((testCase) => testCase.video));
assert.notEqual(request.videos, scenario.cases);
assert.equal(serialized.includes("expected"), false, "gold expected labels must not enter the model request");
assert.equal(serialized.includes("labelNote"), false, "gold rationales must not enter the model request");
assert.equal(serialized.includes("clear-positive"), false, "evaluation tags must not enter the model request");
assert.equal(serialized.includes("keyword-trap"), false, "difficulty tags must not enter the model request");

request.videos[0].title = "mutated";
request.profile.usefulTopics.push("mutated");
assert.notEqual(request.videos[0].title, scenario.cases[0].video.title);
assert.equal(scenario.profile.usefulTopics.includes("mutated"), false);

console.log("evaluation request leakage test passed");
