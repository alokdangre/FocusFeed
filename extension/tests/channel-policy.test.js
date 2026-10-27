"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require("../channel-policy.js");
const P = FocusFeedChannelPolicy;
test("only stable channel identities match, including observed aliases", () => {
  assert.equal(P.normalizeChannelId("/@CaseToo/videos"), "@casetoo");
  assert.equal(P.normalizeChannelId("https://youtube.com/channel/UCAbC_def12345"), "UCAbC_def12345");
  assert.equal(P.normalizeChannelId("THE CASETOO"), "");
  const block = P.createBlock({ channelId: "UCAbC_def12345", channelLabel: "CaseToo" }, "global", 500);
  block.aliases = ["@casetoo"];
  assert.equal(P.matchesBlock(block, { channelId: "@CaseToo" }, { objectives: [] }), true);
  assert.equal(P.matchesBlock(block, { channelId: "THE CASETOO" }, { objectives: [] }), false);
  assert.equal(P.matchesBlock(block, { channelId: "@unrelated" }, { objectives: [] }), false);
});
test("saved category-scoped blocks preserve their scope and inverse mode semantics", () => {
  const profile = { mode: "general", objectives: [{ taxonomyId: "topic.gaming" }] };
  const block = P.createBlock({ channelId: "@creator", mode: "general", taxonomyIds: P.taxonomyIds(profile) }, "topics");
  assert.equal(P.matchesBlock(block, { channelId: "@creator" }, profile), true);
  assert.equal(P.matchesBlock(block, { channelId: "@creator" }, { ...profile, mode: "focus" }), false);
  assert.equal(P.matchesBlock(block, { channelId: "@creator" }, { mode: "general", objectives: [{ taxonomyId: "topic.sports" }] }), false);
});
test("specific preferences have distinct channel-block scopes", () => {
  const profile = text => ({ mode: "general", objectives: [{ text, matchScope: "intent" }] });
  const reviews = profile("movie reviews"), trailers = profile("movie trailers");
  const block = P.createBlock({ channelId: "@creator", mode: "general", taxonomyIds: P.taxonomyIds(reviews) }, "topics");
  assert.equal(P.matchesBlock(block, { channelId: "@creator" }, reviews), true);
  assert.equal(P.matchesBlock(block, { channelId: "@creator" }, trailers), false);
});
