// interceptor.js — runs in MAIN world (same JS context as YouTube)
// Monkey-patches fetch() and XMLHttpRequest to intercept YouTube API responses

(function () {
  "use strict";

  const INTERCEPT_ENDPOINTS = [
    "/youtubei/v1/browse",
    "/youtubei/v1/next",
    "/youtubei/v1/search",
  ];

  function shouldIntercept(url) {
    return INTERCEPT_ENDPOINTS.some(function (ep) {
      return url.includes(ep);
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

    return originalFetch.apply(this, args).then(function (response) {
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

  XMLHttpRequest.prototype.open = function (method, url) {
    this._focusfeed_url = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
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
    return originalSend.apply(this, arguments);
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
})();
