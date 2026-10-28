"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
require("../video-model.js"); require("../channel-policy.js"); require("../settings.js");
require("../learning-policy.js"); require("../channel-evidence.js"); require("../channel-learning.js");
const P = FocusFeedLearningPolicy;
const topic = text => ({ id: "intent-" + text, text, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" });
const video = { videoId: "abcdefghijk", title: "A movie", channelId: "@reviewer", channel: "Reviewer" };
const tick = () => new Promise(resolve => setImmediate(resolve));
function html(extra = {}) {
  const data = { metadata: { channelMetadataRenderer: { externalId: "UCreviewer12345", title: "Reviewer", description: "Film reviews with } and quotes \"", vanityChannelUrl: "https://www.youtube.com/@reviewer" } },
    contents: { twoColumnBrowseResultsRenderer: { tabs: [
      { tabRenderer: { title: "Home", selected: false, content: { videoRenderer: { videoId: "unrelatedxx", title: { simpleText: "Unrelated recommended video" } } } } },
      { tabRenderer: { title: "Videos", selected: true, content: { richGridRenderer: { contents: Array.from({ length: 12 }, (_, i) => ({ videoRenderer: {
        videoId: String(i).padStart(11, "a"), title: { simpleText: "Film " + i + " review" }
      } })) } } } }
    ] } }, ...extra };
  return '<script>var ytInitialData = ' + JSON.stringify(data) + '; window.thisMustNeverExecute=true;</script>';
}
function harness() {
  const profile = { id: "general", version: 1, mode: "general", objectives: [topic("movie reviews")] };
  const data = { focusfeedSettingsV2: FocusFeedSettings.update(FocusFeedSettings.migrate({}), { type: "saveProfile", profile }) };
  const calls = [], fetches = [];
  let writing = Promise.resolve();
  const options = {
    storage: { async get(defaults) { return { ...defaults, ...data }; }, async set(values) { Object.assign(data, values); } },
    write(operation) { const result = writing.then(operation); writing = result.catch(() => {}); return result; },
    endpoint: async () => "http://127.0.0.1:3000",
    contract: async () => ({ model: "jev-1.13.0", channelPromptVersion: P.PROMPT }),
    fetch: async (url, init) => { fetches.push({ url, init }); return { ok: true, text: async () => html() }; },
    request: async (_path, options) => {
      const request = JSON.parse(options.body); calls.push(request);
      return { requestId: request.requestId, channelId: request.channel.channelId, classifier: { model: "jev-1.13.0", promptVersion: P.PROMPT },
        matches: request.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, blockChannel: true, dominantProbability: .98, sufficientProbability: .98 })) };
    }
  };
  const service = FocusFeedChannelLearning.create(options);
  const current = () => FocusFeedSettings.effective(data.focusfeedSettingsV2);
  const correct = (match = true, target = video) => service.correct({ revision: data.focusfeedSettingsV2.revision, video: target,
    topicKey: FocusFeedVideo.objectiveKey(current().objectives[0]), match }, current());
  return { service, options, data, calls, fetches, current, correct };
}
test("public channel extraction verifies identity, samples only Videos, and never executes scripts", () => {
  const evidence = FocusFeedChannelEvidence.parse(html(), "@reviewer");
  assert.equal(evidence.channelId, "UCreviewer12345"); assert.equal(evidence.uploads.length, 12);
  assert.ok(evidence.uploads.every(v => v.title.startsWith("Film"))); assert.equal(globalThis.thisMustNeverExecute, undefined);
  assert.throws(() => FocusFeedChannelEvidence.parse(html(), "@impostor"), /did not match/);
  assert.throws(() => FocusFeedChannelEvidence.parse("<html>Consent required</html>", "@reviewer"), /did not supply/);
  assert.throws(() => FocusFeedChannelEvidence.parse(html({ metadata: {} }), "@reviewer"), /identity/);
});
test("channel evidence supports modern video lockups and rejects playlist seeds", () => {
  const data = FocusFeedChannelEvidence.initialData(html());
  data.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.content = { contents: [
    { lockupViewModel: { contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST", contentId: "PLseed", metadata: { lockupMetadataViewModel: { title: { content: "Not a video" } } } } },
    { lockupViewModel: { contentType: "LOCKUP_CONTENT_TYPE_VIDEO", contentId: "abcdefghijk", metadata: { lockupMetadataViewModel: { title: { content: "Actual upload" } } } } }
  ] };
  const parsed = FocusFeedChannelEvidence.parse('<script>window["ytInitialData"] = ' + JSON.stringify(data) + '</script>', "@reviewer");
  assert.deepEqual(parsed.uploads.map(v => v.title), ["Actual upload"]);
});
test("duplicate tabs share investigation; new broader topics reuse known topics without uploads", async () => {
  const h = harness();
  await Promise.all([h.service.learn(video, h.current()), h.service.learn(video, h.current())]);
  assert.equal(h.fetches.length, 1); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].channel.uploads.length, 12);
  assert.equal(h.fetches[0].init.credentials, "omit");
  await h.service.learn(video, h.current()); assert.equal(h.calls.length, 1);
  const broad = { ...h.current(), objectives: [topic("movies and anything about them")] };
  h.data.focusfeedSettingsV2.general = broad;
  await h.service.learn(video, broad);
  assert.equal(h.calls.length, 2); assert.equal(h.fetches.length, 1);
  assert.deepEqual(h.calls[1].channel.knownTopics, ["movie reviews"]); assert.deepEqual(h.calls[1].channel.uploads, []);
  assert.equal(P.action(P.empty(), h.data[P.PROFILES], video, broad, "http://127.0.0.1:3000").action, "hide");
});
test("corrections persist immediately even if channel retrieval fails; concurrent writes and stale Undo are safe", async () => {
  const h = harness(); h.options.fetch = async () => { throw new Error("offline"); };
  const [a, b] = await Promise.all([h.correct(), h.correct(true, { ...video, videoId: "lmnopqrstuv" })]);
  assert.equal(h.data[P.CORRECTIONS].items.length, 2);
  await assert.rejects(h.service.learn(video, h.current(), a.id), /offline/);
  assert.equal(h.data[P.CORRECTIONS].items.length, 2);
  const replacement = await h.correct(false);
  assert.equal((await h.service.undo(a.id)).removed, false, "an old Undo cannot remove a newer correction");
  await h.service.undo(replacement.id);
  assert.equal(h.data[P.CORRECTIONS].items.find(c => c.videoId === video.videoId).id, a.id);
  assert.ok(h.data[P.CORRECTIONS].items.some(c => c.id === b.id));
});
test("Undo retracts channel rules learned from the correction without deleting other corrections", async () => {
  const h = harness(), saved = await h.correct();
  await h.service.learn(video, h.current(), saved.id);
  assert.equal(h.data[P.PROFILES][0].judgments[0].triggerId, saved.id);
  await h.service.undo(saved.id);
  assert.equal(h.data[P.CORRECTIONS].items.length, 0); assert.equal(h.data[P.PROFILES][0].judgments.length, 0);
  assert.equal(h.data[P.CORRECTIONS].allowedChannels.length, 1);
});
test("late channel results cannot repopulate cleared profiles, change topics, or survive correction Undo", async () => {
  for (const change of ["clear", "topic", "undo"]) {
    const h = harness(), saved = await h.correct(); let finish;
    const original = h.options.request;
    h.options.request = (...args) => new Promise(resolve => { finish = () => original(...args).then(resolve); });
    const result = h.service.learn(video, h.current(), saved.id);
    while (!finish) await tick();
    if (change === "clear") await h.service.clear();
    if (change === "topic") h.data.focusfeedSettingsV2.general.objectives = [topic("gaming")];
    if (change === "undo") await h.service.undo(saved.id);
    finish(); assert.equal((await result).status, "cancelled");
    assert.equal((h.data[P.PROFILES] || []).length, 0);
  }
});
test("invalid and incomplete provider results never become channel rules", async () => {
  const h = harness(); const original = h.options.request;
  h.options.request = async (...args) => { const body = await original(...args); body.matches[0].dominantProbability = NaN; return body; };
  await assert.rejects(h.service.learn(video, h.current()), /Invalid channel probability/);
  assert.equal((h.data[P.PROFILES] || []).length, 0);
});
test("Undo also retracts broader rules derived from a corrected channel topic", async () => {
  const h = harness(), saved = await h.correct();
  await h.service.learn(video, h.current(), saved.id);
  const broad = { ...h.current(), objectives: [topic("anything about movies")] }; h.data.focusfeedSettingsV2.general = broad;
  await h.service.learn(video, broad);
  assert.equal(h.data[P.PROFILES][0].judgments.length, 2);
  assert.ok(h.data[P.PROFILES][0].judgments[1].triggerIds.includes(saved.id));
  await h.service.undo(saved.id);
  assert.equal(h.data[P.PROFILES][0].judgments.length, 0);
});
test("a late automatic channel result cannot replace a newer correction-triggered result", async () => {
  const h = harness(); let finishAuto;
  const original = h.options.request;
  h.options.request = (...args) => {
    const request = JSON.parse(args[1].body);
    if (request.channel.confirmedVideo) return original(...args);
    return new Promise(resolve => { finishAuto = async () => {
      const response = await original(...args); response.matches[0].blockChannel = false; response.matches[0].dominantProbability = .2; resolve(response);
    }; });
  };
  const automatic = h.service.learn(video, h.current());
  while (!finishAuto) await tick();
  const saved = await h.correct(); await h.service.learn(video, h.current(), saved.id);
  await finishAuto(); await automatic;
  const result = h.data[P.PROFILES][0].judgments[0];
  assert.equal(result.blockChannel, true); assert.equal(result.triggerId, saved.id);
});
