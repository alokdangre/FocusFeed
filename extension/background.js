// FocusFeed background service worker — owns classifier network requests.

"use strict";

var DEFAULT_CLASSIFIER_ENDPOINT = "http://127.0.0.1:3000";
var HEALTH_TIMEOUT_MS = 8000;
var CLASSIFY_TIMEOUT_MS = 25000;

function normalizeEndpoint(value) {
  var parsed;
  try {
    parsed = new URL(String(value || DEFAULT_CLASSIFIER_ENDPOINT));
  } catch (_error) {
    throw new Error("Classifier endpoint is not a valid URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Classifier endpoint cannot contain credentials.");
  }

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

async function requestJson(path, options, timeoutMs) {
  var endpoint = await classifierEndpoint();
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, timeoutMs);

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
  }
}

function serializeError(error) {
  return {
    code: error && error.code || "network_error",
    message: error && error.message || "Could not reach the classifier.",
    status: error && error.status || null,
  };
}

async function healthCheck() {
  var body = await requestJson("/health", { method: "GET" }, HEALTH_TIMEOUT_MS);
  return { ok: true, data: body };
}

async function classify(request) {
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
    CLASSIFY_TIMEOUT_MS
  );
  return { ok: true, data: body };
}

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || (message.type !== "CLASSIFIER_HEALTH_CHECK" && message.type !== "CLASSIFY_VIDEOS")) {
    return false;
  }

  var operation = message.type === "CLASSIFIER_HEALTH_CHECK"
    ? healthCheck()
    : classify(message.request);

  operation
    .then(sendResponse)
    .catch(function (error) {
      sendResponse({ ok: false, error: serializeError(error) });
    });

  return true;
});
