"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function setup() {
  const listeners = [], data = {}, requests = [];
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, console,
    fetch: async (_url, options) => {
      if (options.body) requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => _url.endsWith("/cache/clear") ? { cleared: true } : { assessments: [] } };
    }, chrome: { runtime: { getURL: p => "chrome-extension://test/" + p, onMessage: { addListener: l => listeners.push(l) } },
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
