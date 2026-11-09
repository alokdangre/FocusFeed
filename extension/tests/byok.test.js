"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { webcrypto } = require("node:crypto");
require("../byok-contract.js"); require("../byok-client.js");
const secret = "ts_test_only_do_not_use", endpoint = "https://api.typesafe.ai";
const objective = { id: "intent-review", text: "movie reviews", sourceText: "movie reviews", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
const profile = { id: "general", mode: "general", version: 1, objectives: [objective] };
function area(data = {}) {
  return { data, setAccessLevel: async ({ accessLevel }) => { assert.equal(accessLevel, "TRUSTED_CONTEXTS"); },
    get: async key => key === null ? { ...data } : typeof key === "string" ? { [key]: data[key] } : { ...key, ...data },
    set: async values => { Object.assign(data, values); }, remove: async key => { delete data[key]; } };
}
function harness(fetcher) {
  const session = area(), local = area(), calls = []; let boundaries = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (fetcher) return fetcher(url, init);
    if (url.endsWith("/models")) return { ok: true, json: async () => ({ models: [{ name: "jev-1.13.0" }] }) };
    const payload = JSON.parse(init.body);
    return { ok: true, json: async () => ({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(payload.questions).map(id => [id, { type: "noul", noul: .1 }])), usage: { input_tokens: 20, output_tokens: 2 } }) };
  };
  const client = FocusFeedByok.create({ session, local, fetch, onBoundary: async () => { boundaries++; } });
  return { client, local, session, calls, get boundaries() { return boundaries; } };
}
test("key stays in trusted session storage; status, local preferences and results contain no key", async () => {
  const h = harness(), status = await h.client.save(secret);
  assert.equal(status.keyConfigured, true); assert.equal(h.local.data.classifierEndpoint, endpoint);
  assert.doesNotMatch(JSON.stringify([status, h.local.data]), new RegExp(secret));
  const result = await h.client.request("/objectives/classify", { body: JSON.stringify({ requestId: "objective-test", mode: "general", objectives: ["movie reviews"] }) });
  assert.equal(result.objectives[0].validatedObjective.text, "movie reviews");
  assert.equal(result.objectives[0].validatedObjective.matchScope, "intent");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  for (const { url, init } of h.calls) { assert.equal(new URL(url).origin, endpoint); assert.equal(init.redirect, "error"); assert.equal(init.headers.Authorization, "Bearer " + secret); }
  await h.client.remove(); assert.equal((await h.client.status()).keyConfigured, false);
  assert.doesNotMatch(JSON.stringify(h.session.data), new RegExp(secret));
  await assert.rejects(h.client.premium(), { code: "byok_key_required" });
});
test("rejected keys and provider error bodies cannot leak credentials or replace a working key", async () => {
  const h = harness(async (_url, init) => init.headers.Authorization.endsWith("bad") ? { ok: false, status: 401, json: async () => ({ error: secret }) } :
    { ok: true, json: async () => ({ models: [{ name: "jev-1.13.0" }] }) });
  const before = await h.client.save(secret);
  await assert.rejects(h.client.save("bad"), error => error.code === "byok_key_rejected" && !error.message.includes(secret));
  assert.equal((await h.client.status()).userId, before.userId);
});
test("fresh sessions cannot spend a key even when local account state claims access", async () => {
  const h = harness(); h.local.data.focusfeedAccountV1 = { premium: true, mode: "byok", validUntil: Date.now() + 60000 };
  await assert.rejects(h.client.request("/classify", { body: "{}" }), { code: "byok_key_required" });
  assert.equal(h.calls.length, 0);
});
test("selected pairs keep exact topic intent and fail closed on incomplete probabilities", async () => {
  const h = harness(async (url, init) => url.endsWith("/models") ? { ok: true, json: async () => ({ models: [{ name: "jev-1.13.0" }] }) } :
    { ok: true, json: async () => ({ model: "jev-1.13.0", answers: {} }) });
  await h.client.save(secret);
  const request = { requestId: "video-pairs-test", profile: { ...profile, objectives: [objective, { ...objective, id: "intent-other", text: "gaming streams" }] },
    videos: [{ videoId: "example1234", title: "Science behind Interstellar" }], pairs: [{ videoId: "example1234", objectiveId: objective.id }] };
  const built = FocusFeedByok.build("/classify", request);
  assert.deepEqual(Object.keys(built.payload.questions), ["v0_o0_match"]);
  assert.match(built.payload.questions.v0_o0_match.instructions.question, /Do not broaden movie reviews/);
  await assert.rejects(h.client.request("/classify", { body: JSON.stringify(request) }), { code: "invalid_provider_response" });
  request.pairs.push({ videoId: "not-in-request", objectiveId: objective.id });
  assert.throws(() => FocusFeedByok.build("/classify", request), { code: "invalid_extension_request" });
});
test("channel blocks require sufficient distinct upload evidence; collections preserve mode boundaries", async () => {
  const channel = { channelId: "UCexample12345", uploads: [{ videoId: "one", title: "Review" }] };
  const work = FocusFeedByok.build("/channels/classify", { requestId: "channel-test", profile, channel });
  const result = await work.decode({ model: "jev-1.13.0", answers: { o0_dominant: { type: "noul", noul: .99 } } });
  assert.equal(result.matches[0].blockChannel, false);
  const collection = { videoId: "collection:RDsample", collectionId: "RDsample", itemType: "collection", title: "Movie reviews", entries: [] };
  const general = FocusFeedByok.build("/classify", { requestId: "collection-test", profile, videos: [collection] });
  const focus = FocusFeedByok.build("/classify", { requestId: "collection-test", profile: { ...profile, mode: "focus" }, videos: [collection] });
  assert.match(general.payload.questions.v0_o0_match.instructions.question, /explicitly listed playable entry/);
  assert.match(focus.payload.questions.v0_o0_match.instructions.question, /isolated matching entry is insufficient/);
});
test("removing a key aborts an in-flight check and discards late provider output", async () => {
  let release, pending;
  const h = harness(async (url, init) => {
    if (url.endsWith("/models")) return { ok: true, json: async () => ({ models: [{ name: "jev-1.13.0" }] }) };
    pending = init; await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ model: "jev-1.13.0", answers: { o0_nonsense: { type: "noul", noul: .01 } } }) };
  });
  await h.client.save(secret);
  const check = h.client.request("/objectives/classify", { body: JSON.stringify({ requestId: "late-check", objectives: ["movies"] }) });
  await new Promise(setImmediate); await h.client.remove();
  assert.equal(pending.signal.aborted, true); release();
  await assert.rejects(check, { code: "cancelled" });
});
test("a stale session read cannot dispatch a removed key", async () => {
  const h = harness(); await h.client.save(secret);
  const get = h.session.get; let release, pause = true;
  h.session.get = async key => {
    const snapshot = await get(key);
    if (pause) { pause = false; await new Promise(resolve => { release = resolve; }); }
    return snapshot;
  };
  const check = h.client.request("/objectives/classify", { body: JSON.stringify({ requestId: "stale-read", objectives: ["movies"] }) });
  await new Promise(setImmediate); await h.client.remove(); release();
  await assert.rejects(check, { code: "cancelled" });
  assert.equal(h.calls.length, 1, "only the initial free model check ran");
});
function background(initial = { classifierEndpoint: endpoint }) {
  const listeners = [], local = area(initial), session = area(), calls = [];
  const runtimeRoot = process.env.OWNFEED_TEST_EXTENSION || path.join(__dirname, "..");
  const context = vm.createContext({ console, URL, AbortController, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout,
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ models: [{ name: "jev-1.13.0" }] }) }; },
    chrome: { storage: { local, session, onChanged: { addListener() {} } }, runtime: { getURL: p => "chrome-extension://ownfeed/" + p, onMessage: { addListener: fn => listeners.push(fn) } }, tabs: {} } });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), "utf8"), context));
  vm.runInContext(fs.readFileSync(path.join(runtimeRoot, "background.js"), "utf8"), context);
  const dispatch = (message, sender) => new Promise((resolve, reject) => {
    for (const listener of listeners) if (listener(message, sender, resolve)) return;
    reject(new Error("Message not accepted"));
  });
  return { dispatch, calls, local, session };
}
test("YouTube content scripts cannot set/read/remove keys; extension pages get sanitized status", async () => {
  const h = background(), youtube = { url: "https://www.youtube.com/", tab: { id: 1 } }, own = { url: "chrome-extension://ownfeed/popup/popup.html" };
  for (const type of ["FF_BYOK_SAVE", "FF_BYOK_STATUS", "FF_BYOK_REMOVE"]) await assert.rejects(h.dispatch({ type, key: secret }, youtube), /not accepted/);
  const saved = await h.dispatch({ type: "FF_BYOK_SAVE", key: secret }, own); assert.equal(saved.ok, true, JSON.stringify(saved));
  const status = await h.dispatch({ type: "FF_ACCOUNT_STATUS" }, youtube);
  assert.equal(status.data.mode, "byok"); assert.equal(status.data.premium, true);
  assert.doesNotMatch(JSON.stringify([saved, status, h.local.data]), new RegExp(secret));
  assert.equal(h.calls.length, 1, "status does not make a paid inference request");
  await h.dispatch({ type: "FF_BYOK_REMOVE" }, own);
});
test("packaged fresh-install defaults select BYOK without contacting an OwnFeed backend", { skip: !process.env.OWNFEED_TEST_EXTENSION }, async () => {
  const h = background({});
  const status = await h.dispatch({ type: "FF_ACCOUNT_STATUS" }, { url: "chrome-extension://ownfeed/popup/popup.html" });
  assert.equal(status.ok, true); assert.equal(status.data.mode, "byok"); assert.equal(status.data.keyConfigured, false);
  assert.equal(h.calls.length, 0);
});
