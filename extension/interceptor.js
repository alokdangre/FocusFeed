// interceptor.js — runs in MAIN world (same JS context as YouTube)
// Monkey-patches fetch() and XMLHttpRequest to intercept YouTube API responses

(function () {
  "use strict";
  if (globalThis.__focusFeedInterceptorInstalled) return;

  const INTERCEPT_ENDPOINTS = [
    "/youtubei/v1/browse",
    "/youtubei/v1/next",
    "/youtubei/v1/search",
  ];

  var pageGate = FocusFeedPageGate.create(function (state) {
    window.postMessage({ type: "FOCUSFEED_PAGE_GATE_STATE", state: state }, "*");
  });
  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data) return;
    if (event.data.type === "FOCUSFEED_PAGE_GATE_CONFIG") pageGate.configure(event.data.enabled, event.data.cancel);
    if (event.data.type === "FOCUSFEED_PAGE_GATE_MORE" && window.location.pathname === "/") pageGate.allowOne();
  });
  window.addEventListener("yt-navigate-start", function () { pageGate.configure(false, true); });
  window.addEventListener("pagehide", function () { pageGate.configure(false, true); });

  async function waitForPage(input, init, url) {
    if (!pageGate.state().enabled || window.location.pathname !== "/") return;
    var body = init && init.body;
    var signal = init && init.signal || (input instanceof Request && input.signal);
    if (body === undefined && input instanceof Request) {
      try { body = await input.clone().text(); } catch (_) { return; }
    }
    if (FocusFeedPageGate.isHomeContinuation(url, body, window.location.href)) await pageGate.wait(signal);
  }

  function shouldIntercept(url) {
    return INTERCEPT_ENDPOINTS.some(function (ep) {
      return String(url).includes(ep);
    });
  }

  // --- Patch fetch() ---
  const originalFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var url =
      args[0] instanceof Request ? args[0].url : String(args[0]);

    if (!shouldIntercept(url)) {
      return originalFetch.apply(this, args);
    }

    var receiver = this;
    return waitForPage(args[0], args[1], url).then(function () {
      return originalFetch.apply(receiver, args);
    }).then(function (response) {
      var clone = response.clone();
      clone
        .json()
        .then(function (json) {
          window.postMessage(
            {
              type: "FOCUSFEED_FEED_DATA",
              source: "fetch",
              endpoint: url,
              data: json,
            },
            "*"
          );
        })
        .catch(function () {
          // not JSON, ignore
        });
      return response;
    });
  };

  // --- Patch XMLHttpRequest ---
  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  var originalAbort = XMLHttpRequest.prototype.abort;

  XMLHttpRequest.prototype.open = function (method, url) {
    if (this._focusfeed_wait) this._focusfeed_wait.abort();
    this._focusfeed_wait = null;
    this._focusfeed_url = url;
    this._focusfeed_async = arguments[2] !== false;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var args = arguments;
    if (xhr._focusfeed_url && shouldIntercept(xhr._focusfeed_url)) {
      xhr.addEventListener("load", function () {
        try {
          var json = JSON.parse(xhr.responseText);
          window.postMessage(
            {
              type: "FOCUSFEED_FEED_DATA",
              source: "xhr",
              endpoint: xhr._focusfeed_url,
              data: json,
            },
            "*"
          );
        } catch (e) {
          // not JSON, ignore
        }
      });
    }
    if (xhr._focusfeed_async && pageGate.state().enabled &&
        FocusFeedPageGate.isHomeContinuation(xhr._focusfeed_url, args[0], window.location.href)) {
      var controller = new AbortController();
      xhr._focusfeed_wait = controller;
      pageGate.wait(controller.signal).then(function () {
        if (controller.signal.aborted || xhr._focusfeed_wait !== controller) return;
        xhr._focusfeed_wait = null;
        originalSend.apply(xhr, args);
      }).catch(function () {
        if (xhr._focusfeed_wait !== controller) return;
        xhr._focusfeed_wait = null;
        originalAbort.call(xhr);
        xhr.dispatchEvent(new ProgressEvent("abort"));
        xhr.dispatchEvent(new ProgressEvent("loadend"));
      });
      return;
    }
    return originalSend.apply(this, args);
  };

  XMLHttpRequest.prototype.abort = function () {
    if (this._focusfeed_wait) this._focusfeed_wait.abort();
    return originalAbort.apply(this, arguments);
  };

  // --- Capture ytInitialData (homepage first load embeds feed data in HTML) ---
  function captureInitialData() {
    if (window.ytInitialData) {
      window.postMessage(
        {
          type: "FOCUSFEED_FEED_DATA",
          source: "ytInitialData",
          endpoint: "ytInitialData",
          data: window.ytInitialData,
        },
        "*"
      );
      console.log("[FocusFeed] Captured ytInitialData from page");
    }
  }

  // ytInitialData may not exist yet at document_start, poll briefly
  var initAttempts = 0;
  var initInterval = setInterval(function () {
    initAttempts++;
    if (window.ytInitialData) {
      captureInitialData();
      clearInterval(initInterval);
    } else if (initAttempts > 30) {
      clearInterval(initInterval);
    }
  }, 200);

  // Also capture on SPA navigations (YouTube updates ytInitialData on navigate)
  var origPushState = history.pushState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    setTimeout(captureInitialData, 1000);
  };

  console.log("[FocusFeed] Interceptor injected — watching YouTube API calls");
  globalThis.__focusFeedInterceptorInstalled = true;
})();
