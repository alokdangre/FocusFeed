// FocusFeed background service worker — owns classifier network requests.

"use strict";

if (typeof importScripts === "function") importScripts("settings.js", "channel-policy.js", "video-model.js", "request-broker.js", "score-cache.js", "learning-policy.js", "channel-evidence.js", "channel-investigations.js", "channel-learning.js");

var DEFAULT_CLASSIFIER_ENDPOINT = "http://127.0.0.1:3000";
var HEALTH_TIMEOUT_MS = 8000;
var CLASSIFY_TIMEOUT_MS = 80000;
var VIDEO_PROMPT_VERSION = "typesafe-jev-intent-video-match-2026-10-29.1";
var OBJECTIVE_PROMPT_VERSION = "typesafe-jev-intent-validation-2026-10-27.2";
var TAXONOMY_VERSION = "focusfeed-topics-v1";
var RETIRED_CACHE_KEYS = ["focusFeedAssessmentCacheV2", "focusFeedLiveAssessmentCacheV1", "classifierEvalRuns",
  "classifierLabRuns", "focusfeedLiveObservabilityV1", "focusFeedChannelEvidenceV1", "focusfeedAutoObservabilityV1"];

// Remove obsolete generated data on upgrade. Saved preferences and blocks are separate.
if (chrome.storage.local && typeof chrome.storage.local.remove === "function") {
  chrome.storage.local.remove(RETIRED_CACHE_KEYS).catch(function () {});
}

function normalizeEndpoint(value) {
  var parsed;
  try {
    parsed = new URL(String(value || DEFAULT_CLASSIFIER_ENDPOINT));
  } catch (_error) {
    throw new Error("Classifier endpoint is not a valid URL.");
  }
  if (parsed.username || parsed.password) throw new Error("Classifier endpoint cannot contain credentials.");
  var local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("Use HTTPS, or HTTP only for localhost development.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function classifierEndpoint() {
  return chrome.storage.local.get({ classifierEndpoint: DEFAULT_CLASSIFIER_ENDPOINT })
    .then(function (result) { return normalizeEndpoint(result.classifierEndpoint); });
}

async function requestJson(path, options, timeoutMs, externalSignal, selectedEndpoint) {
  var endpoint = selectedEndpoint || await classifierEndpoint();
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, timeoutMs);
  var cancel = function () { controller.abort(); };
  var auditId = options && options.body && JSON.parse(options.body).requestId || path + "-" + Date.now();
  var started = Date.now();
  if (scoreCache && path !== "/classify") scoreCache.http({ requestId: auditId, path: path, status: "dispatched", kind: "auxiliary" });
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    externalSignal.addEventListener("abort", cancel, { once: true });
  }
  try {
    var response = await fetch(endpoint + path, Object.assign({}, options, {
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    }));
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var backendMessage = body && body.error && body.error.message;
      var error = new Error(backendMessage || "Classifier request failed.");
      error.code = body && body.error && body.error.code || "http_error";
      error.status = response.status;
      error.details = body && body.error && body.error.details || [];
      throw error;
    }
    if (scoreCache && path !== "/classify") scoreCache.http({ requestId: auditId, path: path, status: "completed", kind: "auxiliary", durationMs: Date.now() - started,
      usage: body.diagnostics && body.diagnostics.usage,
      providerCalls: /\/(objectives|channels)\/classify$/.test(path) ? 1 : 0,
      providerQuestions: path === "/objectives/classify" ? (body.objectives || []).length : path === "/channels/classify" ? Number(body.diagnostics && body.diagnostics.questionCount) || (body.matches || []).length : 0 });
    return body;
  } catch (error) {
    if (scoreCache && path !== "/classify") scoreCache.http({ requestId: auditId, path: path, status: "failed", kind: "auxiliary", durationMs: Date.now() - started, code: error.code || "network_error" });
    if (error && error.name === "AbortError") {
      var timeoutError = new Error("Classifier request timed out.");
      timeoutError.code = "timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener("abort", cancel);
  }
}

function serializeError(error) {
  return {
    code: error && error.code || "network_error",
    message: error && error.message || "Could not reach the classifier.",
    status: error && error.status || null,
    details: Array.isArray(error && error.details) ? error.details : [],
  };
}

async function healthCheck() {
  var body = await requestJson("/health", { method: "GET" }, HEALTH_TIMEOUT_MS);
  if (body && body.configured === false) {
    var error = new Error("Set TYPESAFE_API_KEY on the classifier server, then restart it.");
    error.code = "typesafe_configuration_error";
    throw error;
  }
  var compatible = body &&
    body.provider === "typesafe-jev" &&
    typeof body.promptVersion === "string" &&
    body.promptVersion === VIDEO_PROMPT_VERSION &&
    typeof body.objectivePromptVersion === "string" &&
    body.objectivePromptVersion === OBJECTIVE_PROMPT_VERSION &&
    body.taxonomyVersion === TAXONOMY_VERSION;
  if (!compatible) {
    var versionError = new Error(
      "The FocusFeed API is running an older build. Stop it, run bash backend/run_local.sh again, then retry."
    );
    versionError.code = "incompatible_backend_contract";
    throw versionError;
  }
  return { ok: true, data: body };
}
var contracts = new Map();
async function contractFor(endpoint) {
  var saved = contracts.get(endpoint);
  if (saved && saved.expiresAt > Date.now()) return saved.promise;
  var value = { expiresAt: Date.now() + 300000, promise: healthCheck().then(function (r) { return r.data; }) };
  contracts.set(endpoint, value);
  value.promise.catch(function () { if (contracts.get(endpoint) === value) contracts.delete(endpoint); });
  return value.promise;
}

async function classifyObjectives(request) {
  if (!request || !request.requestId || !Array.isArray(request.objectives)) {
    var error = new Error("Objective classification request is incomplete.");
    error.code = "invalid_extension_request";
    throw error;
  }
  if (request.objectives.length < 1 || request.objectives.length > 8) {
    var countError = new Error("Enter 1-8 objectives.");
    countError.code = "invalid_extension_request";
    throw countError;
  }
  await healthCheck();
  var body = await requestJson(
    "/objectives/classify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
    CLASSIFY_TIMEOUT_MS
  );
  return { ok: true, data: body };
}

async function classify(request, signal) {
  if (!request || !request.requestId || !request.profile || !Array.isArray(request.videos)) {
    var error = new Error("Classification request is incomplete.");
    error.code = "invalid_extension_request";
    throw error;
  }
  if (request.videos.length < 1 || request.videos.length > 20) {
    var countError = new Error("A classification batch must contain 1-20 videos.");
    countError.code = "invalid_extension_request";
    throw countError;
  }
  var started = Date.now();
  if (scoreCache) scoreCache.http({ requestId: request.requestId, parentRequestId: request.parentRequestId, status: "dispatched", path: "/classify",
    request: { requestId: request.requestId, profile: request.profile, videos: request.videos, pairs: request.pairs },
    videoIds: request.videos.map(function (v) { return v.videoId; }), topicIds: request.profile.objectives.map(function (o) { return o.id; }) });
  var body;
  try { body = await requestJson(
    "/classify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: request.requestId, profile: request.profile, videos: request.videos, pairs: request.pairs }),
    },
    CLASSIFY_TIMEOUT_MS,
    signal,
    request.endpoint
  ); } catch (error) {
    if (scoreCache) scoreCache.http({ requestId: request.requestId, status: "failed", path: "/classify", durationMs: Date.now() - started, code: error.code || "network_error" });
    throw error;
  }
  if (scoreCache) scoreCache.http({ requestId: request.requestId, status: "completed", path: "/classify", durationMs: Date.now() - started,
    cache: body.diagnostics && body.diagnostics.cache, usage: body.diagnostics && body.diagnostics.usage,
    jevRequests: body.diagnostics && body.diagnostics.jevRequests });
  return { ok: true, data: body };
}

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || [
    "CLASSIFIER_HEALTH_CHECK",
    "OBJECTIVES_CLASSIFY_CLOUD",
  ].indexOf(message.type) === -1) return false;

  var operation = message.type === "CLASSIFIER_HEALTH_CHECK"
    ? (contracts.clear(), healthCheck())
    : classifyObjectives(message.request);

  operation.then(sendResponse).catch(function (error) {
    sendResponse({ ok: false, error: serializeError(error) });
  });
  return true;
});

// Serialize read-modify-write operations so simultaneous tabs cannot lose a block.
var policyWrite = Promise.resolve();
function withPolicyWrite(operation) {
  var result = policyWrite.then(operation);
  policyWrite = result.catch(function () {});
  return result;
}
async function readSettings() {
  var prefs = await chrome.storage.local.get(null);
  var state = FocusFeedSettings.migrate(prefs);
  if (!prefs[FocusFeedSettings.KEY]) await chrome.storage.local.set({ focusfeedSettingsV2: state });
  return state;
}
function trustedYouTube(sender) {
  try { return !!sender.tab && /(^|\.)youtube\.com$/.test(new URL(sender.url).hostname); }
  catch (_) { return false; }
}
var channelLookups = new Map();
function resolveYouTubeChannel(videoId) {
  if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return Promise.reject(new Error("A valid YouTube video ID is required."));
  var cached = channelLookups.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 8000);
  var url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("url", "https://www.youtube.com/watch?v=" + videoId); url.searchParams.set("format", "json");
  var job = { expiresAt: Date.now() + 15 * 60000 };
  job.promise = (async function () {
    var started = Date.now(), auditId = "channel-" + videoId + "-" + started;
    if (scoreCache) scoreCache.http({ requestId: auditId, path: "/oembed", kind: "auxiliary", status: "dispatched", videoIds: [videoId] });
    try {
      var response = await fetch(url.href, { signal: controller.signal, credentials: "omit" });
      if (!response.ok) throw new Error("YouTube did not return channel metadata. Reopen the menu to retry.");
      var body = await response.json();
      var author = new URL(body.author_url);
      if (author.protocol !== "https:" || !/(^|\.)youtube\.com$/.test(author.hostname)) throw new Error("YouTube returned an invalid channel URL.");
      var id = FocusFeedChannelPolicy.normalizeChannelId(author.href);
      if (!id) throw new Error("YouTube did not supply a channel ID or handle for this video.");
      if (scoreCache) scoreCache.http({ requestId: auditId, path: "/oembed", kind: "auxiliary", status: "completed", durationMs: Date.now() - started });
      return { videoId: videoId, channelId: id, channelLabel: String(body.author_name || id).slice(0, 200) };
    } catch (error) {
      if (scoreCache) scoreCache.http({ requestId: auditId, path: "/oembed", kind: "auxiliary", status: "failed", durationMs: Date.now() - started, code: error.name || "lookup_error" });
      throw error;
    } finally { clearTimeout(timeout); }
  })();
  channelLookups.set(videoId, job);
  if (channelLookups.size > 100) channelLookups.delete(channelLookups.keys().next().value);
  job.promise.catch(function () { if (channelLookups.get(videoId) === job) channelLookups.delete(videoId); });
  return job.promise;
}
var autoBroker = typeof FocusFeedRequestBroker !== "undefined"
  ? FocusFeedRequestBroker.create(classify) : null;
var scoreCache = typeof FocusFeedScoreCache !== "undefined" ? FocusFeedScoreCache.create(
  function (id, request) { return autoBroker.submit(id, request); },
  { storage: chrome.storage.session, cancelQueued: function (id) { autoBroker.cancelQueued(id); },
    progress: function (owner, requestId, assessment, origin) {
      if (chrome.tabs && chrome.tabs.sendMessage) Promise.resolve(chrome.tabs.sendMessage(owner, {
        type: "FF_AUTO_PROGRESS", requestId: requestId, assessment: assessment, origin: origin
      })).catch(function () {});
    } }) : null;
var channelLearning = typeof FocusFeedChannelLearning !== "undefined" ? FocusFeedChannelLearning.create({
  storage: chrome.storage.local, write: withPolicyWrite, fetch: function (url, options) { return fetch(url, options); },
  request: requestJson, endpoint: classifierEndpoint, contract: contractFor,
}) : null;
var admissions = new Map();
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !/^(FF_REQUEST_STATS|FF_SETTINGS_GET|FF_SETTINGS_UPDATE|FF_OPEN_PREFERENCES|FF_CACHE_CLEAR|FF_CHANNEL_RESOLVE|FF_BLOCK_ADD|FF_BLOCK_REMOVE|FF_AUTO_CLASSIFY|FF_AUTO_CANCEL|FF_CORRECTION_ADD|FF_CORRECTION_UNDO|FF_CHANNEL_LEARN|FF_CHANNEL_ALLOW|FF_COLLECTION_HIDE)$/.test(message.type)) return false;
  var internal = sender && sender.url && sender.url.indexOf(chrome.runtime.getURL("")) === 0;
  if (!internal && !trustedYouTube(sender)) return false;
  var operation;
  if (message.type === "FF_REQUEST_STATS") { if (!internal) return false; operation = scoreCache.snapshot(); }
  if (message.type === "FF_CHANNEL_RESOLVE") operation = resolveYouTubeChannel(message.videoId);
  if (message.type === "FF_OPEN_PREFERENCES") {
    operation = chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html?mode=focus") });
  }
  if (message.type === "FF_CACHE_CLEAR") {
    if (!internal) return false;
    operation = (async function () {
      var result = await requestJson("/cache/clear", { method: "POST" }, HEALTH_TIMEOUT_MS);
      autoBroker.cancelAll();
      admissions.forEach(function (token) { token.active = false; });
      scoreCache.clear(); contracts.clear();
      var invalidation = { focusfeedCacheEpochV1: Date.now() };
      if (channelLearning) await channelLearning.clear(invalidation);
      else await chrome.storage.local.set(invalidation);
      return result;
    })();
  }
  if (message.type === "FF_SETTINGS_GET") operation = withPolicyWrite(readSettings);
  if (message.type === "FF_CORRECTION_UNDO") operation = channelLearning.undo(message.id);
  if (message.type === "FF_COLLECTION_HIDE") operation = channelLearning.hideCollection(message.video);
  if (message.type === "FF_CHANNEL_ALLOW") { if (!internal) return false; operation = channelLearning.allowChannel(message.channelId, message.topicKey); }
  if (message.type === "FF_CORRECTION_ADD" || message.type === "FF_CHANNEL_LEARN") operation = (async function () {
    var state = await withPolicyWrite(readSettings), profile = FocusFeedSettings.effective(state);
    if (!state.enabled || profile.mode !== "general" || !FocusFeedSettings.valid(profile) || message.revision !== state.revision) throw new Error("Preferences changed. Reopen the video menu.");
    if (message.type === "FF_CORRECTION_ADD") return channelLearning.correct(message, profile);
    var video = FocusFeedVideo.videoInput(message.video);
    if (video.itemType === "collection") return { status: "skipped", reason: "Collection feedback does not investigate its creators." };
    if (message.triggerId) {
      var values = await chrome.storage.local.get({ focusfeedCorrectionsV1: { items: [] } });
      if (!values.focusfeedCorrectionsV1.items.some(function (c) { return c.id === message.triggerId && c.videoId === video.videoId; })) return { status: "cancelled" };
    }
    if (!video.channelId && /^[A-Za-z0-9_-]{11}$/.test(video.videoId)) {
      var trace = channelLearning.startInvestigation(video, profile, message.triggerId);
      await channelLearning.recordInvestigation(trace, { status: "running", stage: "resolve_channel" });
      try {
        var resolved = await resolveYouTubeChannel(video.videoId); video.channelId = resolved.channelId;
      } catch (error) {
        await channelLearning.recordInvestigation(trace, { status: "failed", error: channelLearning.investigationError(error), finishedAt: Date.now() });
        throw error;
      }
    }
    return channelLearning.learn(video, profile, message.triggerId, trace);
  })();
  if (message.type === "FF_SETTINGS_UPDATE") operation = withPolicyWrite(async function () {
    var next = FocusFeedSettings.update(await readSettings(), message.action);
    await chrome.storage.local.set({ focusfeedSettingsV2: next });
    return next;
  });
  if (message.type === "FF_BLOCK_ADD" || message.type === "FF_BLOCK_REMOVE") operation = withPolicyWrite(async function () {
    var prefs = await chrome.storage.local.get({ focusFeedChannelBlocksV1: [] });
    var blocks = prefs.focusFeedChannelBlocksV1;
    if (message.type === "FF_BLOCK_REMOVE") blocks = blocks.filter(function (b) { return b.id !== message.id; });
    else {
      var candidate = message.channel || {};
      if (!FocusFeedChannelPolicy.normalizeChannelId(candidate.channelId)) throw new Error("Channel identity is unavailable.");
      var block = FocusFeedChannelPolicy.createBlock(candidate, message.scope || "global");
      block.aliases = (candidate.aliases || []).map(FocusFeedChannelPolicy.normalizeChannelId).filter(Boolean);
      var existing = blocks.find(function (b) { return b.scope === block.scope && b.channelId === block.channelId &&
        (b.scope === "global" || (b.mode === block.mode && JSON.stringify(b.taxonomyIds) === JSON.stringify(block.taxonomyIds))); });
      if (existing) return { block: existing, created: false };
      blocks.push(block);
      await chrome.storage.local.set({ focusFeedChannelBlocksV1: blocks });
      return { block: block, created: true };
    }
    await chrome.storage.local.set({ focusFeedChannelBlocksV1: blocks });
    return { removed: true };
  });
  if (message.type === "FF_AUTO_CANCEL") {
    if (trustedYouTube(sender)) {
      admissions.forEach(function (token) { if (token.owner === sender.tab.id && (!message.requestId || token.requestId === message.requestId)) token.active = false; });
      scoreCache.cancel(sender.tab.id, message.requestId);
    }
    sendResponse({ ok: true }); return false;
  }
  if (message.type === "FF_AUTO_CLASSIFY") {
    if (!trustedYouTube(sender)) return false;
    var token = { owner: sender.tab.id, requestId: message.request && message.request.requestId, active: true };
    var admissionKey = sender.tab.id + ":" + token.requestId;
    admissions.set(admissionKey, token);
    operation = (async function () {
      try {
      var state = await withPolicyWrite(readSettings);
      if (!state.enabled || state.revision !== message.revision) throw new Error("Settings changed.");
      var profile = FocusFeedSettings.effective(state);
      if (!FocusFeedSettings.valid(profile)) throw new Error("Save confirmed topics first.");
      if (!message.request || !Array.isArray(message.request.videos) || !message.request.videos.length || message.request.videos.length > 40 ||
          new Set(message.request.videos.map(function (v) { return v.videoId; })).size !== message.request.videos.length) throw new Error("A work window must contain 1-40 unique videos.");
      var prefs = await chrome.storage.local.get({ focusfeedCacheEpochV1: 0, focusfeedCorrectionsV1: { items: [] } });
      var endpoint = await classifierEndpoint(), contract = await contractFor(endpoint);
      if (!token.active) throw new Error("Request cancelled.");
      var namespace = JSON.stringify([endpoint, contract.model, contract.promptVersion, prefs.focusfeedCacheEpochV1,
        /^jev-\d+\.\d+\.\d+$/.test(contract.model) ? "pinned" : message.request.requestId]);
      return await scoreCache.submit(sender.tab.id, Object.assign({}, message.request, { endpoint: endpoint,
        corrections: profile.mode === "general" ? prefs.focusfeedCorrectionsV1.items : [],
        profile: { id: profile.id, version: profile.version, mode: profile.mode, objectives: profile.objectives } }), namespace, function () { return !token.active; });
      } finally { if (admissions.get(admissionKey) === token) admissions.delete(admissionKey); }
    })();
  }
  Promise.resolve(operation).then(function (data) { sendResponse({ ok: true, data: data }); })
    .catch(function (error) { sendResponse({ ok: false, error: serializeError(error) }); });
  return true;
});
if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(function (id) {
  admissions.forEach(function (token) { if (token.owner === id) token.active = false; }); scoreCache.cancel(id);
});
