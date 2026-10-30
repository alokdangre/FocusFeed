// Native Home cards in both modes. Only Focus gates admission and continuation requests.
(function (root) {
  "use strict";
  var PAGE = 20, ROUNDS = 4, MIN_MATCHES = 3, MAX_TRACKED = 1000;
  var SELECTORS = "ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2";
  function element(tag, text) { var node = document.createElement(tag); if (text) node.textContent = text; return node; }
  function create(options) {
    var prefs, source = null, entries = new Map(), targets = new WeakMap(), batches = [], current = null;
    var goalKey = "", scheduled = false, epoch = 0, waiting = false, waitTimer, continuationAttempts = 0;
    var halted = false, announced = false, dialog = null, status = null, retryButton = null, extractVideo, refreshing = null;
    function profile() { return prefs && root.FocusFeedSettings && FocusFeedSettings.effective(prefs); }
    function focus() { var p = profile(); return !!(prefs && prefs.enabled && p && p.mode === "focus" && FocusFeedSettings.valid(p)); }
    function post(type, extra) { window.postMessage(Object.assign({ type: type }, extra), location.origin); }
    function askScan() { if (options.requestScan) options.requestScan(); }
    function closeDialog() {
      if (!dialog) return;
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      dialog.removeAttribute("open");
    }
    function clear(keepGate) {
      epoch++; scheduled = false; clearTimeout(waitTimer); waiting = false; continuationAttempts = 0;
      if (source) {
        source.querySelectorAll("[data-focusfeed-focus-withheld]").forEach(function (node) { node.removeAttribute("data-focusfeed-focus-withheld"); });
        source.removeAttribute("data-focusfeed-focus-source");
        if (!keepGate) post("FOCUSFEED_PAGE_GATE_CONFIG", { enabled: false, cancel: false });
      }
      if (dialog) { closeDialog(); dialog.remove(); }
      if (status) status.remove();
      source = null; entries.clear(); targets = new WeakMap(); batches = []; current = null;
      dialog = status = retryButton = null; halted = announced = false; refreshing = null;
    }
    function refreshGoal() {
      // Changing topics resets discovery accounting, not admission or the native
      // cards already on screen. Their old presentation remains until rechecked.
      epoch++; scheduled = false; clearTimeout(waitTimer); waiting = false; continuationAttempts = 0;
      batches = []; current = null; halted = announced = false;
      if (dialog) { closeDialog(); dialog.remove(); dialog = null; }
      setStatus("");
      refreshing = Array.from(entries.values()).filter(function (entry) { return !!entry.batch; });
      var size = PAGE;
      for (var index = 0; index < refreshing.length; index += size) {
        var batch = refreshing.slice(index, index + size); batches.push(batch);
        batch.forEach(function (entry) { entry.batch = batch; entry.action = "pending"; entry.reason = "refreshing"; });
      }
    }
    function configure(state) {
      prefs = state;
      var currentProfile = profile();
      var next = currentProfile ? JSON.stringify([currentProfile.mode, FocusFeedVideo.profileKey(currentProfile)]) : "";
      if (!focus()) clear();
      else if (next !== goalKey) {
        if (source && source.isConnected && location.pathname === "/") refreshGoal();
        else clear(location.pathname === "/");
      }
      goalKey = next;
    }
    function mount() {
      if (!focus() || location.pathname !== "/") { if (source) clear(); return false; }
      var browse = document.querySelector('ytd-browse[page-subtype="home"]:not([hidden])');
      var next = browse && browse.querySelector("ytd-rich-grid-renderer #contents");
      if (!next) return false;
      if (source === next) return true;
      clear(); source = next; source.dataset.focusfeedFocusSource = "true";
      post("FOCUSFEED_PAGE_GATE_CONFIG", { enabled: true });
      status = element("div"); status.className = "focusfeed-focus-status"; status.dataset.focusfeedUi = "focus-status";
      status.setAttribute("role", "status"); status.hidden = true;
      source.parentNode.insertBefore(status, source);
      return true;
    }
    function withheld(card, value) {
      if (value) { if (!card.hasAttribute("data-focusfeed-focus-withheld")) card.setAttribute("data-focusfeed-focus-withheld", "true"); }
      else card.removeAttribute("data-focusfeed-focus-withheld");
    }
    function collect(extract) {
      extractVideo = extract;
      var added = 0;
      entries.forEach(function (entry) {
        var actual = entry.card && source.contains(entry.card) && extract(entry.card);
        if (!actual || actual.videoId !== entry.video.videoId) entry.card = null;
      });
      source.querySelectorAll(SELECTORS).forEach(function (card) {
        var video = extract(card);
        if (!video) return;
        if (!video.videoId || !video.title || !card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"], a[href*="/playlist?"]')) return;
        var entry = entries.get(video.videoId);
        if (!entry) {
          if (entries.size >= MAX_TRACKED) { withheld(card, true); return; }
          entry = { video: video, card: card, batch: null, action: null, reason: "" };
          entries.set(video.videoId, entry); added++;
        } else { entry.video = video; entry.card = card; }
        targets.set(card, entry); withheld(card, !entry.batch);
      });
      if (added && waiting) { waiting = false; clearTimeout(waitTimer); continuationAttempts = 0; }
    }
    function nearEnd() { return source.getBoundingClientRect().bottom <= (root.innerHeight || 800) + 500; }
    function countVisible() {
      return Array.from(entries.values()).filter(function (entry) { return entry.card && entry.card.isConnected && entry.action === "show"; }).length;
    }
    function settled(batch) { return batch.every(function (entry) { return entry.action && entry.action !== "pending"; }); }
    function successful(batch) {
      return settled(batch) && batch.every(function (entry) { return ["model", "cache", "local_cache", "shared", "mixed", "retained_match", "channel_block", "shorts_block"].includes(entry.reason); });
    }
    function setStatus(message, retry) {
      if (!status) return;
      if (status.dataset.message === message) return;
      status.dataset.message = message; status.replaceChildren(); status.hidden = !message;
      if (message) status.appendChild(element("span", message));
      if (retry) {
        retryButton = element("button", "Try again"); retryButton.type = "button";
        retryButton.addEventListener("click", async function () { clear(); if (options.retry) await options.retry(); else askScan(); });
        status.appendChild(retryButton);
      }
    }
    function showDiscovery() {
      if (announced) return;
      announced = true;
      dialog = element("dialog"); dialog.className = "focusfeed-discovery"; dialog.dataset.focusfeedUi = "focus-discovery";
      dialog.setAttribute("aria-labelledby", "focusfeed-discovery-title");
      var title = element("h2", "Your Home feed has few matches for this Focus"); title.id = "focusfeed-discovery-title";
      var recent = batches.slice(-ROUNDS), checked = recent.reduce(function (n, batch) { return n + batch.length; }, 0);
      var found = recent.reduce(function (n, batch) { return n + batch.filter(function (entry) { return entry.action === "show"; }).length; }, 0);
      var detail = element("p", "Found " + found + " confident matches in " + checked + " recommendations across " + recent.length + " batches. Home checks are paused to avoid repeated requests. Search for your saved topics; Focus will keep filtering the results.");
      var actions = element("div"); actions.className = "focusfeed-discovery-actions";
      var queries = profile().objectives.map(function (o) { return o.sourceText || o.text; }).filter(function (text, i, all) { return all.indexOf(text) === i; });
      queries.slice(0, 3).forEach(function (query) {
        var search = element("a", "Search: " + query); search.href = "/results?search_query=" + encodeURIComponent(query); actions.appendChild(search);
      });
      var edit = element("button", "Edit Focus"); edit.type = "button";
      edit.addEventListener("click", function () { if (options.editGoal) options.editGoal(); });
      var keep = element("button", "Keep current matches"); keep.type = "button"; keep.addEventListener("click", closeDialog);
      actions.append(edit, keep); dialog.append(title, detail, actions); (document.body || document.documentElement).appendChild(dialog);
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
    function requestContinuation() {
      if (waiting || halted) return;
      if (continuationAttempts >= ROUNDS) { setStatus("YouTube has not supplied more recommendations. Try again when the feed is ready.", true); return; }
      waiting = true; continuationAttempts++; post("FOCUSFEED_PAGE_GATE_MORE");
      var continuation = source.querySelector("ytd-continuation-item-renderer");
      var retry = continuation && continuation.querySelector("button, yt-button-renderer a");
      if (retry) retry.click();
      waitTimer = setTimeout(function () { waiting = false; setStatus("YouTube has not supplied more recommendations. Try again when the feed is ready.", true); }, 8000);
    }
    function advance() {
      if (!source || !focus() || halted || waiting) return;
      if (refreshing) {
        var existing = refreshing.filter(function (entry) { return entry.card && entry.card.isConnected; });
        if (!settled(existing)) return;
        if (!successful(existing)) { setStatus("Some recommendations could not be checked. Try again when the classifier is available.", true); return; }
        refreshing = null;
      }
      if (current) {
        if (!settled(current)) return;
        if (!successful(current)) { setStatus("Some recommendations could not be checked. Try again when the classifier is available.", true); return; }
        current = null;
      }
      var recent = batches.slice(-ROUNDS);
      var found = recent.reduce(function (n, batch) { return n + batch.filter(function (entry) { return entry.action === "show"; }).length; }, 0);
      if (recent.length === ROUNDS && recent.every(successful) && found < MIN_MATCHES) {
        halted = true; setStatus("Home checks paused. Search for your saved Focus topics to find more matches."); showDiscovery(); return;
      }
      if (countVisible() >= MIN_MATCHES && !nearEnd()) return;
      var candidates = Array.from(entries.values()).filter(function (entry) { return entry.card && !entry.batch; });
      if (!candidates.length) { requestContinuation(); return; }
      var size = PAGE;
      current = candidates.slice(0, size); batches.push(current);
      current.forEach(function (entry) { entry.batch = current; entry.action = "pending"; withheld(entry.card, false); });
      setStatus(""); askScan();
    }
    function scan(extract, runtime) {
      if (!mount()) return false;
      collect(extract); advance();
      entries.forEach(function (entry) {
        if (entry.card && entry.batch) runtime.observe(entry.card, Object.assign({}, entry.video, { managed: true, noAutomaticRetry: true, noNewTopicChecks: halted }));
      });
      advance(); return true;
    }
    function render(card, video, action, reason) {
      var entry = targets.get(card);
      if (!entry || entry.video.videoId !== video.videoId) return false;
      entry.action = reason === "refreshing" ? "pending" : action; entry.reason = reason || "unfiltered";
      if (!scheduled) {
        scheduled = true; var run = epoch;
        Promise.resolve().then(function () { if (run !== epoch) return; scheduled = false; advance(); });
      }
      return false; // The existing renderer applies native visibility and menu behavior.
    }
    return { configure: configure, scan: scan, render: render, clear: clear, suspend: clear,
      owns: function (card) { return !!(source && focus() && source.contains(card)); },
      active: function () { return !!source; } };
  }
  root.FocusFeedHomeFeed = { create: create };
})(globalThis);
