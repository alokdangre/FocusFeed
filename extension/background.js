// FocusFeed background service worker — owns classifier network requests.

"use strict";

if (typeof importScripts === "function") importScripts("settings.js", "channel-policy.js", "request-broker.js");

var DEFAULT_CLASSIFIER_ENDPOINT = "http://127.0.0.1:3000";
var HEALTH_TIMEOUT_MS = 8000;
var CLASSIFY_TIMEOUT_MS = 25000;
var VIDEO_PROMPT_PREFIX = "typesafe-jev-taxonomy-video-match-";
var OBJECTIVE_PROMPT_PREFIX = "typesafe-jev-taxonomy-map-";
var TAXONOMY_VERSION = "focusfeed-topics-v1";
var RETIRED_CACHE_KEYS = ["focusFeedAssessmentCacheV2", "focusFeedLiveAssessmentCacheV1"];

// Classification caching was removed in 0.9. Purge entries left by earlier builds
// whenever the service worker starts; user preferences are stored under other keys.
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

async function requestJson(path, options, timeoutMs, externalSignal) {
  var endpoint = await classifierEndpoint();
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, timeoutMs);
  var cancel = function () { controller.abort(); };
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
    return body;
  } catch (error) {
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
    body.promptVersion.indexOf(VIDEO_PROMPT_PREFIX) === 0 &&
    typeof body.objectivePromptVersion === "string" &&
    body.objectivePromptVersion.indexOf(OBJECTIVE_PROMPT_PREFIX) === 0 &&
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
  if (request.videos.length < 1 || request.videos.length > 12) {
    var countError = new Error("A classification batch must contain 1-12 videos.");
    countError.code = "invalid_extension_request";
    throw countError;
  }
  var body = await requestJson(
    "/classify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
    CLASSIFY_TIMEOUT_MS,
    signal
  );
  return { ok: true, data: body };
}

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || [
    "CLASSIFIER_HEALTH_CHECK",
    "OBJECTIVES_CLASSIFY_CLOUD",
    "CLASSIFY_VIDEOS",
  ].indexOf(message.type) === -1) return false;

  var operation = message.type === "CLASSIFIER_HEALTH_CHECK"
    ? healthCheck()
    : message.type === "OBJECTIVES_CLASSIFY_CLOUD"
      ? classifyObjectives(message.request)
      : classify(message.request);

  operation.then(sendResponse).catch(function (error) {
    sendResponse({ ok: false, error: serializeError(error) });
  });
  return true;
});

// Live sessions have a separate cancellation path. No retry or provider fallback.
var liveCloudRequests = new Map();
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || (message.type !== "LIVE_CLASSIFY_CLOUD" && message.type !== "LIVE_CLASSIFY_CANCEL")) return false;
  if (!sender || !String(sender.url || "").startsWith(chrome.runtime.getURL("live/live.html"))) {
    sendResponse({ ok: false, error: { message: "Only the live session page can dispatch this request." } });
    return false;
  }
  if (message.type === "LIVE_CLASSIFY_CANCEL") {
    var pending = liveCloudRequests.get(message.requestId);
    if (pending && pending.owner === sender.url) pending.controller.abort();
    sendResponse({ ok: true });
    return false;
  }
  if (liveCloudRequests.size) {
    sendResponse({ ok: false, error: { message: "Another live cloud request is still running." } });
    return false;
  }
  var request = message.request;
  if (!request || !request.requestId) {
    sendResponse({ ok: false, error: { message: "Missing request identity." } });
    return false;
  }
  var controller = new AbortController();
  liveCloudRequests.set(request.requestId, { controller: controller, owner: sender.url });
  classify(request, controller.signal).then(sendResponse).catch(function (error) {
    sendResponse({ ok: false, error: serializeError(error) });
  }).finally(function () {
    liveCloudRequests.delete(request.requestId);
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
var autoBroker = typeof FocusFeedRequestBroker !== "undefined"
  ? FocusFeedRequestBroker.create(classify) : null;
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !/^(FF_SETTINGS_GET|FF_SETTINGS_UPDATE|FF_BLOCK_ADD|FF_BLOCK_REMOVE|FF_AUTO_CLASSIFY|FF_AUTO_CANCEL)$/.test(message.type)) return false;
  var internal = sender && sender.url && sender.url.indexOf(chrome.runtime.getURL("")) === 0;
  if (!internal && !trustedYouTube(sender)) return false;
  var operation;
  if (message.type === "FF_SETTINGS_GET") operation = withPolicyWrite(readSettings);
  if (message.type === "FF_SETTINGS_UPDATE") operation = withPolicyWrite(async function () {
    var next = FocusFeedSettings.update(await readSettings(), message.action);
    await chrome.storage.local.set({ focusfeedSettingsV2: next, enabled: next.enabled,
      activeProfile: FocusFeedSettings.effective(next), focusSession: next.focusSession });
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
    if (trustedYouTube(sender)) autoBroker.cancel(sender.tab.id, message.requestId);
    sendResponse({ ok: true }); return false;
  }
  if (message.type === "FF_AUTO_CLASSIFY") {
    if (!trustedYouTube(sender)) return false;
    operation = (async function () {
      var state = await withPolicyWrite(readSettings);
      if (!state.enabled || state.revision !== message.revision) throw new Error("Settings changed.");
      var profile = FocusFeedSettings.effective(state);
      if (!FocusFeedSettings.valid(profile)) throw new Error("Save confirmed topics first.");
      return autoBroker.submit(sender.tab.id, Object.assign({}, message.request, { profile: { id: profile.id, version: profile.version, mode: profile.mode, objectives: profile.objectives } }));
    })();
  }
  Promise.resolve(operation).then(function (data) { sendResponse({ ok: true, data: data }); })
    .catch(function (error) { sendResponse({ ok: false, error: serializeError(error) }); });
  return true;
});
if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(function (id) { autoBroker.cancel(id); });
