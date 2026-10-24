"use strict";

const assert = require("node:assert/strict");
delete global.FocusFeedChannelPolicy;
require("../channel-policy.js");

const P = global.FocusFeedChannelPolicy;
const profile = {
  id: "default",
  mode: "general",
  objectives: [{ taxonomyId: "topic.gaming" }],
};

function record(videoId, outcome, channelId = "@CaseToo") {
  return {
    route: "model",
    video: { videoId, channelId, channel: "THE CASETOO" },
    assessment: { outcome },
  };
}

assert.equal(P.normalizeChannelId("/@CaseToo/videos"), "@casetoo");
assert.equal(P.normalizeChannelId("https://youtube.com/channel/UCAbC_def12345"), "UCAbC_def12345");
assert.equal(P.normalizeChannelId("THE CASETOO"), "", "display names are not stable identities");

let state = {};
let update = P.recordAssessment(state, record("uncertain", "uncertain"), profile, "session-0", 100);
state = update.state;
assert.equal(update.candidate, null);
update = P.recordAssessment(state, record("one", "match"), profile, "session-1", 200);
state = update.state;
update = P.recordAssessment(state, record("two", "match"), profile, "session-1", 300);
state = update.state;
assert.equal(update.candidate, null, "one session must never prompt");
update = P.recordAssessment(state, record("three", "match"), profile, "session-2", 400);
state = update.state;
assert.ok(update.candidate, "three unwanted decisions across two sessions should prompt");
assert.equal(update.candidate.unwanted, 3);
assert.equal(update.candidate.uncertain, 1);
assert.deepEqual(update.candidate.unwantedSessionIds, ["session-1", "session-2"]);

const duplicate = P.recordAssessment(state, record("three", "match"), profile, "session-2", 500);
assert.equal(duplicate.state[update.candidate.evidenceKey].unwanted, 3, "same session/video is counted once");

const scoped = P.createBlock(update.candidate, "topics", 600);
assert.equal(P.matchesBlock(scoped, { channelId: "@casetoo" }, profile), true);
assert.equal(P.matchesBlock(scoped, { channelId: "@casetoo" }, {
  mode: "general",
  objectives: [{ taxonomyId: "topic.sports" }],
}), false);
assert.equal(P.matchesBlock(scoped, { channelId: "@casetoo" }, {
  mode: "focus",
  objectives: [{ taxonomyId: "topic.gaming" }],
}), false, "topic-scoped blocks must not cross inverse mode semantics");
const globalBlock = P.createBlock(update.candidate, "global", 700);
assert.equal(P.matchesBlock(globalBlock, { channelId: "@casetoo" }, { objectives: [] }), true);
assert.equal(P.matchesBlock(globalBlock, { channelId: "The CaseToo" }, profile), false);

console.log("channel policy passed: stable IDs, evidence threshold, user-scoped/global blocks");
