"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require("../video-model.js"); require("../channel-policy.js"); require("../learning-policy.js");
const P = FocusFeedLearningPolicy, endpoint = "http://127.0.0.1:3000";
const topic = { id: "reviews", text: "Movie reviews except documentaries", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
const profile = { mode: "general", objectives: [topic] }, video = { videoId: "abcdefghijk", channelId: "@reviewer" };
function channel() { return { channelId: "UCreviewer12345", aliases: ["@reviewer"], endpoint, expiresAt: Date.now() + 10000, contract: "contract",
  judgments: [{ key: FocusFeedVideo.objectiveKey(topic), contract: "contract", promptVersion: P.PROMPT, expiresAt: Date.now() + 10000, blockChannel: true }] }; }
test("a channel match hides all its recommendations including per-video exceptions", () => {
  assert.equal(P.action(P.empty(), [channel()], { ...video, title: "Documentary review" }, profile, endpoint).action, "hide");
  assert.equal(P.action(P.empty(), [channel()], video, { ...profile, mode: "focus" }, endpoint), null);
  assert.equal(P.action(P.empty(), [channel()], { ...video, itemType: "collection" }, profile, endpoint), null);
});
test("channel rules are topic-, endpoint-, and freshness-scoped", () => {
  assert.equal(P.action(P.empty(), [channel()], video, { ...profile, objectives: [{ ...topic, text: "Gaming" }] }, endpoint), null);
  assert.equal(P.action(P.empty(), [channel()], video, profile, "https://other.example"), null);
  assert.equal(P.action(P.empty(), [{ ...channel(), expiresAt: 1 }], video, profile, endpoint), null);
  const changed = channel(); changed.contract = "new";
  assert.equal(P.action(P.empty(), [changed], video, profile, endpoint), null);
});
test("a personal negative correction takes precedence for its video, without changing raw scores", () => {
  const data = P.empty(); data.items.push({ ...video, topicKey: FocusFeedVideo.objectiveKey(topic), match: false });
  assert.equal(P.action(data, [channel()], video, profile, endpoint).action, "show");
  assert.equal(P.action(data, [channel()], { ...video, videoId: "lmnopqrstuv" }, profile, endpoint).action, "hide");
  const raw = { outcome: "match", objectiveMatches: [{ objectiveId: topic.id, matchProbability: .95 }] };
  assert.equal(P.apply(data, video, profile, raw).outcome, "no_match"); assert.equal(raw.objectiveMatches[0].matchProbability, .95);
  const another = { id: "other", text: "Music" };
  assert.equal(P.action(data, [channel()], video, { ...profile, objectives: [topic, another] }, endpoint), null, "other active topics still need checks");
});
