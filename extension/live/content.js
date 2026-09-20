// The YouTube adapter owns card identity and display. The session tab owns inference.
(function (root) {
  "use strict";
  function create(adapter) {
    var port = null;
    var active = false;
    var runId = null;
    var allowance = 12;
    var applyHides = false;
    var admitted = new Set();
    var cards = new Map();
    var sent = new Map();
    var results = new Map();
    var restored = new Set();
    var pending = new Map();
    var timer = null;
    var host = null;
    var summary = null;
    var modeButton = null;
    var moreButton = null;
    var gateState = {};
    var stats = {};
    var budget = {};
    var queueDepth = 0;
    var domEvents = [];
    var lastState = "";
    var moreTimer = null;
    var gateReleasedAtMore = 0;
    function post(message) {
      if (!port) return;
      try { port.postMessage(Object.assign({ runId: runId }, message)); } catch (_) { stop(); }
    }
    function gate(enabled, cancel) {
      window.postMessage({ type: "FOCUSFEED_PAGE_GATE_CONFIG", enabled: enabled, cancel: Boolean(cancel) }, "*");
    }
    function panel() {
      if (host) return;
      host = document.createElement("div");
      host.id = "focusfeed-live-panel";
      var shadow = host.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = ":host{position:fixed;bottom:18px;left:20px;right:20px;z-index:2147483000;font:13px/1.5 system-ui;color:#f1f5f9}section{padding:12px 16px;border:1px solid #455269;border-radius:12px;background:#111a28;box-shadow:0 5px 25px #0007}nav{display:flex;gap:8px;flex-wrap:wrap;align-items:center}button{font:inherit;border:1px solid #68788c;background:#24334a;color:inherit;border-radius:6px;padding:6px 10px;cursor:pointer}button.primary{border-color:#3b82f6;background:#2563eb;font-weight:700}button:disabled{cursor:not-allowed;opacity:.55}p{margin:6px 0 0;color:#b9c8d8}strong{margin-right:12px}";
      shadow.appendChild(style);
      var section = document.createElement("section");
      var nav = document.createElement("nav");
      var brand = document.createElement("strong"); brand.textContent = "FocusFeed"; nav.appendChild(brand);
      function button(label, fn) {
        var element = document.createElement("button"); element.textContent = label;
        element.addEventListener("click", function (event) { if (event.isTrusted) fn(); });
        nav.appendChild(element); return element;
      }
      moreButton = button("Load 12 more", function () { post({ type: "LOAD_MORE" }); });
      moreButton.className = "primary";
      modeButton = button("Apply AI hides", function () { setMode(!applyHides); post({ type: "MODE", applyHides: applyHides }); });
      button("Restore AI hides", function () {
        results.forEach(function (_, id) { restored.add(id); }); adapter.scan(); update();
        post({ type: "RESTORED", videoIds: Array.from(restored) });
      });
      button("Stop session", function () { post({ type: "USER_STOP" }); stop(); });
      summary = document.createElement("p"); section.appendChild(nav); section.appendChild(summary); shadow.appendChild(section);
      document.documentElement.appendChild(host);
      var stylesheet = document.createElement("style"); stylesheet.id = "focusfeed-live-style";
      stylesheet.textContent = "html[data-focusfeed-session]:not([data-focusfeed-awaiting-page]) ytd-browse[page-subtype='home'] ytd-continuation-item-renderer{display:none!important}" +
        "[data-focusfeed-deferred='true'],[data-focusfeed-ai-hidden='true']{display:none!important}" +
        ".focusfeed-live-label{font:12px/1.4 system-ui!important;color:#aad4ff!important;padding:5px 0!important;pointer-events:none}";
      document.documentElement.appendChild(stylesheet);
    }
    function update() {
      if (!active || !summary) return;
      var deferred = 0; var hidden = 0;
      cards.forEach(function (_, card) {
        if (!card.isConnected) { cards.delete(card); return; }
        if (card.dataset.focusfeedDeferred) deferred += 1;
        if (card.dataset.focusfeedAiHidden) hidden += 1;
      });
      var text = admitted.size + "/" + allowance + " admitted · " + deferred + " waiting for Load more · " +
        (stats.rule || 0) + " rules · " + (stats.cache || 0) + " cache · " + (stats.model || 0) + " AI · " +
        (stats.model_pending || 0) + " pending · " + (budget.calls || 0) + "/" + (budget.callBudget || 3) + " model calls · " +
        hidden + " AI hidden · " + (gateState.waiting || 0) + " page requests held";
      if (summary.textContent !== text) summary.textContent = text;
      modeButton.textContent = applyHides ? "Preview only" : "Apply AI hides";
      moreButton.disabled = allowance >= 120 || queueDepth > 12;
      var state = { admitted: admitted.size, allowance: allowance, deferredCards: deferred, hiddenCards: hidden, applyHides: applyHides, gate: gateState };
      var serialized = JSON.stringify(state);
      if (serialized !== lastState) { lastState = serialized; post({ type: "DISPLAY_STATE", state: state }); }
    }
    function setMode(value) { applyHides = Boolean(value); adapter.scan(); update(); }
    function observe(card, rawVideo) {
      if (!active || window.location.pathname !== "/") return;
      var video = FocusFeedLiveEngine.videoInput(rawVideo);
      var id = video.videoId;
      if (!id) {
        // YouTube may recycle a previously hidden card before its new ID arrives.
        delete card.dataset.focusfeedAiHidden; delete card.dataset.focusfeedDeferred;
        var pendingLabel = card.querySelector(":scope > .focusfeed-live-label"); if (pendingLabel) pendingLabel.remove();
        cards.delete(card); update(); return;
      }
      var fp = FocusFeedLiveEngine.fingerprint(video);
      cards.set(card, { id: id, fingerprint: fp });
      delete card.dataset.focusfeedAiHidden;
      if (!admitted.has(id) && admitted.size >= allowance) {
        card.dataset.focusfeedDeferred = "true";
        var oldLabel = card.querySelector(":scope > .focusfeed-live-label"); if (oldLabel) oldLabel.remove();
        update(); return;
      }
      delete card.dataset.focusfeedDeferred;
      admitted.add(id);
      var result = results.get(id);
      if (result && result.fingerprint !== fp) { results.delete(id); result = null; }
      // The synchronous explicit rule remains authoritative even after an async result.
      var rule = adapter.rule(video);
      if (result && !rule && applyHides && result.action === "hide" && !restored.has(id)) {
        card.dataset.focusfeedAiHidden = "true";
      }
      var label = card.querySelector(":scope > .focusfeed-live-label");
      if (!label) { label = document.createElement("div"); label.className = "focusfeed-live-label"; card.appendChild(label); }
      var labelText = rule ? "FocusFeed · rule · " + rule.action : result
        ? "FocusFeed · " + result.route + " · " + (result.status === "resolved" ? result.action : result.status) + " · " + result.reason
        : "FocusFeed · pending — visible while classifying";
      if (label.textContent !== labelText) label.textContent = labelText;
      if (sent.get(id) !== fp) {
        sent.set(id, fp);
        var rect = card.getBoundingClientRect();
        pending.set(id, { video: video, priority: rect.top < innerHeight && rect.bottom > 0 ? 100 : 10 });
        if (!timer) timer = setTimeout(function () {
          timer = null;
          post({ type: "CANDIDATES", candidates: Array.from(pending.values()) }); pending.clear();
        }, 80);
      }
      update();
    }
    function stop(cancel) {
      active = false; runId = null;
      clearTimeout(timer); timer = null; clearTimeout(moreTimer); moreTimer = null; pending.clear();
      gate(false, cancel);
      document.documentElement.removeAttribute("data-focusfeed-session");
      document.documentElement.removeAttribute("data-focusfeed-awaiting-page");
      cards.forEach(function (_, card) {
        delete card.dataset.focusfeedDeferred; delete card.dataset.focusfeedAiHidden;
        var label = card.querySelector(":scope > .focusfeed-live-label"); if (label) label.remove();
      });
      cards.clear(); results.clear(); sent.clear(); admitted.clear(); restored.clear();
      var style = document.getElementById("focusfeed-live-style"); if (style) style.remove();
      if (host) host.remove(); host = null;
    }
    chrome.runtime.onConnect.addListener(function (connection) {
      // tabs.connect(tabId) delivers an internal named port directly to this
      // content script. Port.sender.url is not guaranteed at this endpoint;
      // external extensions/pages use onConnectExternal instead.
      if (connection.name !== "focusfeed-live") return;
      if (port) { connection.postMessage({ type: "ERROR", message: "Another FocusFeed session is connected to this tab. Close it first." }); connection.disconnect(); return; }
      port = connection;
      post({ type: "HELLO", home: window.location.pathname === "/" });
      connection.onMessage.addListener(function (message) {
        if (message.type === "HELLO_REQUEST") {
          post({ type: "HELLO", home: window.location.pathname === "/" }); return;
        }
        if (message.type === "START") {
          if (window.location.pathname !== "/") { post({ type: "ERROR", message: "Open YouTube Home first." }); return; }
          stop(); runId = message.runId; allowance = 12; applyHides = false; active = true; stats = {}; budget = {}; queueDepth = 0; domEvents = []; lastState = "";
          panel(); document.documentElement.dataset.focusfeedSession = "true"; gate(true); adapter.scan(); update(); return;
        }
        if (!active || message.runId !== runId) return;
        if (message.type === "RESULT") {
          // Rescan current metadata before using a late result on a recycled card.
          adapter.scan();
          if (sent.get(message.record.video.videoId) !== message.record.fingerprint) return;
          results.set(message.record.video.videoId, message.record); adapter.scan();
          domEvents.push({ at: Date.now(), videoId: message.record.video.videoId, route: message.record.route, action: message.record.action, applyHides: applyHides });
          if (domEvents.length > 400) domEvents.shift();
          post({ type: "DISPLAY_RESULT", event: domEvents[domEvents.length - 1] });
        }
        if (message.type === "STATS") { stats = message.counts || {}; budget = message.budget || {}; queueDepth = message.queueDepth || 0; update(); }
        if (message.type === "MODE") setMode(message.applyHides);
        if (message.type === "RESTORE") { restored.add(message.videoId); adapter.scan(); update(); }
        if (message.type === "MORE") {
          allowance = Math.min(120, message.allowance); adapter.scan(); update();
          clearTimeout(moreTimer);
          moreTimer = setTimeout(function () {
            if (active && admitted.size < allowance) {
              gateReleasedAtMore = gateState.released || 0;
              document.documentElement.dataset.focusfeedAwaitingPage = "true";
              window.postMessage({ type: "FOCUSFEED_PAGE_GATE_MORE" }, "*");
              var continuation = document.querySelector("ytd-browse[page-subtype='home'] ytd-continuation-item-renderer");
              if (continuation) continuation.scrollIntoView({ block: "end" });
            }
          }, 200);
        }
        if (message.type === "STOP") stop();
      });
      connection.onDisconnect.addListener(function () { if (port === connection) { port = null; stop(); } });
    });
    window.addEventListener("message", function (event) {
      if (active && event.source === window && event.data && event.data.type === "FOCUSFEED_PAGE_GATE_STATE") {
        gateState = event.data.state || {};
        if ((gateState.released || 0) > gateReleasedAtMore) document.documentElement.removeAttribute("data-focusfeed-awaiting-page");
        update();
      }
    });
    window.addEventListener("yt-navigate-start", function () { post({ type: "NAVIGATED" }); stop(true); });
    window.addEventListener("pagehide", function () { stop(true); });
    function preferencesChanged() { if (active) { post({ type: "PREFERENCES_CHANGED" }); stop(); } }
    return { observe: observe, preferencesChanged: preferencesChanged };
  }
  root.FocusFeedLiveContent = { create: create };
})(globalThis);
