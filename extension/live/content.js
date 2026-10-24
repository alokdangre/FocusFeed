// The YouTube adapter owns card identity and display. The session tab owns inference.
(function (root) {
  "use strict";

  function create(adapter) {
    var port = null;
    var active = false;
    var runId = null;
    var allowance = 12;
    var admitted = new Set();
    var cards = new Map();
    var sent = new Map();
    var results = new Map();
    var restored = new Set();
    var pending = new Map();
    var timer = null;
    var endHost = null;
    var moreButton = null;
    var gateState = {};
    var queueDepth = 0;
    var domEvents = [];
    var lastState = "";
    var moreTimer = null;
    var gateReleasedAtMore = 0;

    function post(message) {
      if (!port) return;
      try {
        port.postMessage(Object.assign({ runId: runId }, message));
      } catch (_error) {
        stop();
      }
    }

    function gate(enabled, cancel) {
      window.postMessage({
        type: "FOCUSFEED_PAGE_GATE_CONFIG",
        enabled: enabled,
        cancel: Boolean(cancel),
      }, "*");
    }

    function buildButton(label, handler) {
      var element = document.createElement("button");
      element.textContent = label;
      element.addEventListener("click", function (event) {
        if (event.isTrusted) handler();
      });
      return element;
    }

    function placeEndControl() {
      if (!active || !endHost) return;
      var continuation = document.querySelector(
        "ytd-browse[page-subtype='home'] ytd-continuation-item-renderer"
      );
      var container = continuation && continuation.parentElement ||
        document.querySelector("ytd-browse[page-subtype='home'] ytd-rich-grid-renderer #contents");
      if (!container) return;
      if (continuation) {
        if (endHost.parentElement !== container || endHost.nextSibling !== continuation) {
          container.insertBefore(endHost, continuation);
        }
      } else if (endHost.parentElement !== container) {
        container.appendChild(endHost);
      }
    }

    function sessionUi() {
      if (endHost) return;
      endHost = document.createElement("div");
      endHost.id = "focusfeed-load-more-host";
      var endShadow = endHost.attachShadow({ mode: "open" });
      var endStyle = document.createElement("style");
      endStyle.textContent =
        ":host{display:block;width:100%;grid-column:1/-1;padding:28px 0 42px;font:14px/1.5 system-ui;text-align:center}" +
        "section{display:inline-flex;flex-direction:column;gap:7px;align-items:center;padding:18px 24px;border:1px solid #3b82f6;border-radius:14px;background:#111a28;color:#f1f5f9}" +
        "button{font:700 14px system-ui;border:0;border-radius:8px;padding:10px 18px;background:#2563eb;color:white;cursor:pointer}" +
        "button:disabled{cursor:not-allowed;opacity:.55}small{color:#a9bdd4}";
      endShadow.appendChild(endStyle);
      var endSection = document.createElement("section");
      moreButton = buildButton("Load 12 more", function () {
        post({ type: "LOAD_MORE" });
      });
      var hint = document.createElement("small");
      hint.textContent = "No more recommendations load until you choose.";
      endSection.appendChild(moreButton);
      endSection.appendChild(hint);
      endShadow.appendChild(endSection);
      placeEndControl();

      var stylesheet = document.createElement("style");
      stylesheet.id = "focusfeed-live-style";
      stylesheet.textContent =
        "html[data-focusfeed-session]:not([data-focusfeed-awaiting-page]) ytd-browse[page-subtype='home'] ytd-continuation-item-renderer{display:none!important}" +
        "[data-focusfeed-deferred='true'],[data-focusfeed-ai-pending='true'],[data-focusfeed-ai-hidden='true']{display:none!important}";
      document.documentElement.appendChild(stylesheet);
    }

    function update() {
      if (!active || !moreButton) return;
      placeEndControl();
      var deferred = 0;
      var hidden = 0;
      cards.forEach(function (_record, card) {
        if (!card.isConnected) {
          cards.delete(card);
          return;
        }
        if (card.dataset.focusfeedDeferred) deferred += 1;
        if (card.dataset.focusfeedAiHidden) hidden += 1;
      });
      moreButton.disabled = allowance >= 120 || queueDepth > 12;
      var state = {
        admitted: admitted.size,
        allowance: allowance,
        deferredCards: deferred,
        hiddenCards: hidden,
        applyHides: true,
        gate: gateState,
      };
      var serialized = JSON.stringify(state);
      if (serialized !== lastState) {
        lastState = serialized;
        post({ type: "DISPLAY_STATE", state: state });
      }
    }

    function observe(card, rawVideo) {
      if (!active || window.location.pathname !== "/") return;
      var video = FocusFeedLiveEngine.videoInput(rawVideo);
      var id = video.videoId;
      if (!id) {
        delete card.dataset.focusfeedAiHidden;
        delete card.dataset.focusfeedAiPending;
        delete card.dataset.focusfeedDeferred;
        cards.delete(card);
        update();
        return;
      }
      var fp = FocusFeedLiveEngine.fingerprint(video);
      cards.set(card, { id: id, fingerprint: fp });
      delete card.dataset.focusfeedAiHidden;
      delete card.dataset.focusfeedAiPending;
      if (!admitted.has(id) && admitted.size >= allowance) {
        card.dataset.focusfeedDeferred = "true";
        update();
        return;
      }
      delete card.dataset.focusfeedDeferred;
      admitted.add(id);
      var result = results.get(id);
      if (result && result.fingerprint !== fp) {
        results.delete(id);
        result = null;
      }
      if (!result || result.status === "pending") {
        card.dataset.focusfeedAiPending = "true";
      } else if (result.action === "hide" && !restored.has(id)) {
        card.dataset.focusfeedAiHidden = "true";
      }
      if (sent.get(id) !== fp) {
        sent.set(id, fp);
        var rect = card.getBoundingClientRect();
        pending.set(id, {
          video: video,
          priority: rect.top < innerHeight && rect.bottom > 0 ? 100 : 10,
        });
        if (!timer) {
          timer = setTimeout(function () {
            timer = null;
            post({ type: "CANDIDATES", candidates: Array.from(pending.values()) });
            pending.clear();
          }, 80);
        }
      }
      update();
    }

    function removeHomeUi(cancel) {
      gate(false, cancel);
      document.documentElement.removeAttribute("data-focusfeed-session");
      document.documentElement.removeAttribute("data-focusfeed-awaiting-page");
      cards.forEach(function (_record, card) {
        delete card.dataset.focusfeedDeferred;
        delete card.dataset.focusfeedAiPending;
        delete card.dataset.focusfeedAiHidden;
      });
      cards.clear();
      var stylesheet = document.getElementById("focusfeed-live-style");
      if (stylesheet) stylesheet.remove();
      if (endHost) endHost.remove();
      endHost = null;
      moreButton = null;
    }

    function suspendHome() {
      if (!active) return;
      clearTimeout(moreTimer);
      moreTimer = null;
      removeHomeUi(true);
      post({ type: "HOME_LEFT" });
    }

    function resumeHome() {
      if (!active || window.location.pathname !== "/") return;
      sessionUi();
      document.documentElement.dataset.focusfeedSession = "true";
      gate(true);
      adapter.scan();
      update();
      post({ type: "HOME_RESUMED" });
    }

    function stop(cancel) {
      active = false;
      runId = null;
      clearTimeout(timer);
      timer = null;
      clearTimeout(moreTimer);
      moreTimer = null;
      pending.clear();
      removeHomeUi(cancel);
      results.clear();
      sent.clear();
      admitted.clear();
      restored.clear();
    }

    chrome.runtime.onConnect.addListener(function (connection) {
      if (connection.name !== "focusfeed-live") return;
      if (port) {
        connection.postMessage({
          type: "ERROR",
          message: "Another FocusFeed session is connected to this tab. Close it first.",
        });
        connection.disconnect();
        return;
      }
      port = connection;
      post({ type: "HELLO", home: window.location.pathname === "/" });
      connection.onMessage.addListener(function (message) {
        if (message.type === "HELLO_REQUEST") {
          post({ type: "HELLO", home: window.location.pathname === "/" });
          return;
        }
        if (message.type === "START") {
          if (window.location.pathname !== "/") {
            post({ type: "ERROR", message: "Open YouTube Home first." });
            return;
          }
          stop();
          runId = message.runId;
          allowance = 12;
          active = true;
          queueDepth = 0;
          domEvents = [];
          lastState = "";
          resumeHome();
          return;
        }
        if (!active || message.runId !== runId) return;
        if (message.type === "RESULT") {
          adapter.scan();
          if (sent.get(message.record.video.videoId) !== message.record.fingerprint) return;
          results.set(message.record.video.videoId, message.record);
          adapter.scan();
          domEvents.push({
            at: Date.now(),
            videoId: message.record.video.videoId,
            route: message.record.route,
            action: message.record.action,
            applyHides: true,
          });
          if (domEvents.length > 400) domEvents.shift();
          post({ type: "DISPLAY_RESULT", event: domEvents[domEvents.length - 1] });
        }
        if (message.type === "STATS") {
          queueDepth = message.queueDepth || 0;
          update();
        }
        if (message.type === "RESTORE") {
          restored.add(message.videoId);
          adapter.scan();
          update();
        }
        if (message.type === "MORE") {
          allowance = Math.min(120, message.allowance);
          adapter.scan();
          update();
          clearTimeout(moreTimer);
          moreTimer = setTimeout(function () {
            if (active && admitted.size < allowance) {
              gateReleasedAtMore = gateState.released || 0;
              document.documentElement.dataset.focusfeedAwaitingPage = "true";
              window.postMessage({ type: "FOCUSFEED_PAGE_GATE_MORE" }, "*");
              var continuation = document.querySelector(
                "ytd-browse[page-subtype='home'] ytd-continuation-item-renderer"
              );
              if (continuation) continuation.scrollIntoView({ block: "end" });
            }
          }, 200);
        }
        if (message.type === "STOP") stop();
      });
      connection.onDisconnect.addListener(function () {
        if (port === connection) {
          port = null;
          stop();
        }
      });
    });

    window.addEventListener("message", function (event) {
      if (active && event.source === window && event.data &&
          event.data.type === "FOCUSFEED_PAGE_GATE_STATE") {
        gateState = event.data.state || {};
        if ((gateState.released || 0) > gateReleasedAtMore) {
          document.documentElement.removeAttribute("data-focusfeed-awaiting-page");
        }
        update();
      }
    });
    window.addEventListener("yt-navigate-start", suspendHome);
    window.addEventListener("yt-navigate-finish", resumeHome);
    window.addEventListener("pagehide", function () { stop(true); });

    function preferencesChanged() {
      if (active) {
        post({ type: "PREFERENCES_CHANGED" });
        stop();
      }
    }

    return { observe: observe, preferencesChanged: preferencesChanged };
  }

  root.FocusFeedLiveContent = { create: create };
})(globalThis);
