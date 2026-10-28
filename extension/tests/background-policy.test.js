"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function setup(fetchImpl) {
  const listeners = [], data = {}, requests = [];
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, console,
    fetch: fetchImpl || (async (_url, options) => {
      if (_url.endsWith("/health")) return { ok: true, json: async () => ({ configured: true, provider: "typesafe-jev", model: "jev-1.13.0", promptVersion: "typesafe-jev-intent-video-match-2026-10-28.1", objectivePromptVersion: "typesafe-jev-intent-validation-2026-10-27.2", taxonomyVersion: "focusfeed-topics-v1" }) };
      if (options.body) requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => _url.endsWith("/cache/clear") ? { cleared: true } : { assessments: requests.at(-1).videos.map(v => ({ videoId: v.videoId, outcome: "match", reason: "fixture",
        objectiveMatches: requests.at(-1).profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: .9 })) })) } };
    }), chrome: { runtime: { getURL: p => "chrome-extension://test/" + p, onMessage: { addListener: l => listeners.push(l) } },
      storage: { local: {
        async get(defaults) { await sleep(2); return defaults === null ? { ...data } : { ...defaults, ...data }; },
        async set(values) { await sleep(2); Object.assign(data, values); }, remove: async () => {} } } } });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), context);
  function dispatch(message, sender = { url: "https://www.youtube.com/watch?v=x", tab: { id: 1 } }) {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of listeners) {
        const result = listener(message, sender, resolve);
        if (result) { handled = true; break; }
      }
      if (!handled) reject(new Error("Message was not accepted"));
    });
  }
  return { dispatch, data, requests };
}
test("concurrent channel writes merge; duplicate/undo cannot remove another tab's block", async () => {
  const h = setup();
  const [a, b] = await Promise.all(["@one", "@two"].map(channelId => h.dispatch({ type: "FF_BLOCK_ADD", channel: { channelId } })));
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(h.data.focusFeedChannelBlocksV1.length, 2);
  const duplicate = await h.dispatch({ type: "FF_BLOCK_ADD", channel: { channelId: "@one" } });
  assert.equal(duplicate.data.created, false);
  await h.dispatch({ type: "FF_BLOCK_REMOVE", id: a.data.block.id });
  assert.equal(h.data.focusFeedChannelBlocksV1.length, 1); assert.equal(h.data.focusFeedChannelBlocksV1[0].channelId, "@two");
  const bad = await h.dispatch({ type: "FF_BLOCK_ADD", channel: { channelId: "same display name" } }); assert.equal(bad.ok, false);
});
test("service worker restart restores settings; provider uses strict profile and rejects stale revision", async () => {
  const h = setup();
  const profile = { id: "general", mode: "general", version: 1, sessionDurationMinutes: 45, updatedAt: "x", objectives: [
    { id: "topic.gaming", text: "Gaming", contentType: "topic", taxonomyId: "topic.gaming", taxonomyVersion: "focusfeed-topics-v1" }] };
  const saved = await h.dispatch({ type: "FF_SETTINGS_UPDATE", action: { type: "saveProfile", profile } });
  assert.equal(saved.ok, true);
  const current = await h.dispatch({ type: "FF_SETTINGS_GET" }); assert.equal(current.data.general.version, 1);
  const request = { requestId: "test-1234", videos: [{ videoId: "v1", title: "Test" }] };
  const stale = await h.dispatch({ type: "FF_AUTO_CLASSIFY", revision: 0, request }); assert.equal(stale.ok, false); assert.equal(h.requests.length, 0);
  const result = await h.dispatch({ type: "FF_AUTO_CLASSIFY", revision: saved.data.revision, request }); assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(h.requests[0].profile).sort(), ["id", "mode", "objectives", "version"]);
  const again = await h.dispatch({ type: "FF_AUTO_CLASSIFY", revision: saved.data.revision, request: { ...request, requestId: "new-tab" } }, { url: "https://www.youtube.com/", tab: { id: 2 } });
  assert.equal(again.ok, true); assert.equal(h.requests.length, 1, "the real worker must reuse scores before HTTP across tabs");
  await assert.rejects(h.dispatch({ type: "FF_AUTO_CLASSIFY", revision: saved.data.revision, request }, { url: "https://example.com", tab: { id: 2 } }), /not accepted/);
  const restarted = setup(); Object.assign(restarted.data, JSON.parse(JSON.stringify(h.data)));
  const read = await restarted.dispatch({ type: "FF_SETTINGS_GET" }); assert.equal(read.data.revision, saved.data.revision);
});

test("cache clear is restricted to extension pages and broadcasts invalidation", async () => {
  const h = setup();
  h.data.focusFeedChannelBlocksV1 = [{ id: "keep", channelId: "@kept" }];
  await assert.rejects(h.dispatch({ type: "FF_CACHE_CLEAR" }), /not accepted/);
  const response = await h.dispatch({ type: "FF_CACHE_CLEAR" }, { url: "chrome-extension://test/popup/popup.html" });
  assert.equal(response.ok, true);
  assert.equal(response.data.cleared, true);
  assert.equal(typeof h.data.focusfeedCacheEpochV1, "number");
  assert.equal(h.data.focusFeedChannelBlocksV1[0].id, "keep");
});
test("missing channel lookup uses the selected video, deduplicates requests and caches its author ID", async () => {
  const calls = [];
  const h = setup(async (url, options) => {
    calls.push({ url, options }); await sleep(2);
    return { ok: true, json: async () => ({ author_url: "https://www.youtube.com/channel/UCcreator123456", author_name: "Creator" }) };
  });
  const message = { type: "FF_CHANNEL_RESOLVE", videoId: "abcdefghijk" };
  const [a, b] = await Promise.all([h.dispatch(message), h.dispatch(message)]);
  assert.equal(a.ok, true); assert.equal(b.data.channelId, "UCcreator123456");
  assert.equal(a.data.videoId, message.videoId); assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://www.youtube.com/oembed");
  assert.equal(url.searchParams.get("url"), "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(calls[0].options.credentials, "omit");
  await h.dispatch(message); assert.equal(calls.length, 1);
  assert.equal((await h.dispatch({ ...message, videoId: "../watch" })).ok, false);
  assert.equal(calls.length, 1);
  await assert.rejects(h.dispatch(message, { url: "https://example.com", tab: { id: 2 } }), /not accepted/);
});
test("failed or invalid author lookups do not invent a channel and can be retried", async () => {
  let count = 0;
  const h = setup(async () => {
    count++;
    return { ok: true, json: async () => ({ author_url: count === 1 ? "https://example.com/@wrong" : "https://www.youtube.com/@RealCreator" }) };
  });
  const message = { type: "FF_CHANNEL_RESOLVE", videoId: "abcdefghijk" };
  assert.equal((await h.dispatch(message)).ok, false);
  assert.equal((await h.dispatch(message)).data.channelId, "@realcreator");
  assert.equal(count, 2);
});
