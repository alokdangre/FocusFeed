// Own the presentation of Home recommendations. Native elements remain YouTube's data source.
(function (root) {
  "use strict";
  var PAGE = 12, MAX_TRACKED = 1000;
  var SELECTORS = "ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2";
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function create(options) {
    var prefs = null, source = null, sourceAria = null, host = null, grid, pool, loading, status, more, shorts, discovery;
    var entries = new Map(), targets = new WeakMap(), staged = [], allowance = PAGE;
    var batches = [], goalKey = "", discoveryKey = "";
    var scheduled = false, waiting = false, waitTimer = null, alive = 0, notice = "";
    function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
    function post(type, extra) { window.postMessage(Object.assign({ type: type }, extra), location.origin); }
    function askScan() { if (options.requestScan) options.requestScan(); }
    function configure(state) {
      prefs = state;
      if (!state.enabled) { clear(); return; }
      var profile = root.FocusFeedSettings && FocusFeedSettings.effective(state);
      var nextGoal = JSON.stringify(profile || null);
      if (nextGoal !== goalKey) {
        goalKey = nextGoal; batches = []; discoveryKey = "";
        var admitted = Array.from(entries.values()).filter(function (entry) { return entry.admitted; });
        admitted.forEach(function (entry) { entry.action = "pending"; entry.reason = "model_pending"; });
        for (var i = 0; i < admitted.length; i += PAGE) batches.push(admitted.slice(i, i + PAGE));
        if (discovery) discovery.hidden = true;
      }
      if (shorts) shorts.checked = state.hideShorts === true;
    }
    function suspend() {
      alive++; scheduled = false; clearTimeout(waitTimer); waiting = false;
      if (source) {
        source.removeAttribute("data-focusfeed-home-source");
        if (sourceAria === null) source.removeAttribute("aria-hidden"); else source.setAttribute("aria-hidden", sourceAria);
      }
      if (host) host.remove();
      if (source) post("FOCUSFEED_PAGE_GATE_CONFIG", { enabled: false, cancel: false });
      source = null;
    }
    function clear() {
      suspend(); host = null; entries.clear(); targets = new WeakMap(); staged = []; allowance = PAGE;
      batches = []; discovery = null; discoveryKey = ""; notice = "";
    }
    function mount() {
      if (!prefs || !prefs.enabled) { if (host) clear(); return false; }
      if (location.pathname !== "/") { if (source) suspend(); return false; }
      var home = document.querySelector('ytd-browse[page-subtype="home"]:not([hidden])');
      var nativeGrid = home && home.querySelector("ytd-rich-grid-renderer");
      var nextSource = nativeGrid && nativeGrid.querySelector("#contents");
      if (!nextSource) { if (source) suspend(); return false; }
      if (host && source === nextSource && host.isConnected) return true;
      if (host) {
        suspend(); source = nextSource; sourceAria = source.getAttribute("aria-hidden"); source.parentNode.insertBefore(host, source);
        source.dataset.focusfeedHomeSource = "true"; source.setAttribute("aria-hidden", "true"); post("FOCUSFEED_PAGE_GATE_CONFIG", { enabled: true });
        if (shorts) shorts.checked = prefs.hideShorts === true;
        return true;
      }
      clear(); source = nextSource; sourceAria = source.getAttribute("aria-hidden");
      host = element("section", "focusfeed-home"); host.dataset.focusfeedUi = "home";
      host.setAttribute("aria-label", "FocusFeed recommendations");
      var toolbar = element("div", "focusfeed-toolbar");
      toolbar.appendChild(element("strong", "", "FocusFeed"));
      var label = element("label", "focusfeed-shorts-toggle");
      shorts = element("input"); shorts.type = "checkbox"; shorts.checked = prefs.hideShorts === true;
      label.append(shorts, document.createTextNode("Hide Shorts"));
      shorts.addEventListener("change", async function () {
        shorts.disabled = true;
        try { await options.settings({ type: "setHideShorts", enabled: shorts.checked }); }
        catch (error) { shorts.checked = prefs.hideShorts === true; notice = error.message; flush(); }
        finally { if (shorts) shorts.disabled = false; }
      });
      toolbar.appendChild(label);
      status = element("span", "focusfeed-feed-status", "Preparing recommendations…");
      status.setAttribute("role", "status"); toolbar.appendChild(status);
      grid = element("div", "focusfeed-grid");
      loading = element("div", "focusfeed-grid focusfeed-loading"); loading.setAttribute("aria-hidden", "true");
      for (var i = 0; i < 6; i++) {
        var skeleton = element("div", "focusfeed-skeleton");
        skeleton.append(element("div"), element("span"), element("span")); loading.appendChild(skeleton);
      }
      more = element("button", "focusfeed-more", "Load more recommendations"); more.type = "button";
      more.addEventListener("click", loadMore);
      discovery = element("section", "focusfeed-discovery"); discovery.hidden = true;
      discovery.setAttribute("aria-label", "Find videos for your focus goal");
      pool = element("div"); pool.hidden = true; pool.setAttribute("aria-hidden", "true");
      host.append(toolbar, grid, loading, discovery, more, pool);
      host.addEventListener("toggle", function (event) {
        if (event.target.tagName === "DETAILS" && event.target.open) {
          host.querySelectorAll("details[open]").forEach(function (details) { if (details !== event.target) details.open = false; });
        }
      }, true);
      source.parentNode.insertBefore(host, source);
      source.dataset.focusfeedHomeSource = "true";
      source.setAttribute("aria-hidden", "true");
      post("FOCUSFEED_PAGE_GATE_CONFIG", { enabled: true });
      return true;
    }
    function collect(extract) {
      var added = 0;
      source.querySelectorAll(SELECTORS).forEach(function (card) {
        var video = extract(card);
        if (!video || !/^[a-zA-Z0-9_-]{1,80}$/.test(video.videoId || "") || !video.title) return;
        // A renderer class alone is not proof that this entry is a playable video.
        if (!card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]')) return;
        var entry = entries.get(video.videoId);
        if (!entry) {
          if (entries.size >= MAX_TRACKED) return;
          entry = { video: Object.assign({}, video), action: null, admitted: false, node: null, target: null };
          entries.set(video.videoId, entry); added++;
        } else entry.video = Object.assign({}, video);
      });
      if (added && waiting) { waiting = false; notice = ""; clearTimeout(waitTimer); allowance += PAGE; }
    }
    function scan(extract, runtime) {
      if (!mount()) return false;
      collect(extract);
      if (!staged.length && allowance > 0) {
        for (var entry of entries.values()) {
          if (entry.admitted) continue;
          entry.admitted = true; entry.action = "pending";
          entry.target = element("span"); entry.target.dataset.videoId = entry.video.videoId;
          pool.appendChild(entry.target); targets.set(entry.target, entry); staged.push(entry);
          if (staged.length >= allowance) break;
        }
        if (staged.length) { allowance = 0; batches.push(staged.slice()); }
      }
      entries.forEach(function (entry) {
        if (entry.admitted) runtime.observe(entry.target, Object.assign({}, entry.video, { managed: true }));
      });
      flush();
      return true;
    }
    function makeCard(entry) {
      var video = entry.video;
      var card = element("article", "focusfeed-card"); card.dataset.videoId = video.videoId;
      var thumb = element("a", "focusfeed-thumbnail");
      var href = video.isShort ? "/shorts/" + encodeURIComponent(video.videoId) : "/watch?v=" + encodeURIComponent(video.videoId);
      thumb.href = href; thumb.setAttribute("aria-label", video.title);
      var image = element("img"); image.src = "https://i.ytimg.com/vi/" + encodeURIComponent(video.videoId) + "/hqdefault.jpg";
      image.alt = ""; image.loading = "lazy"; image.width = 480; image.height = 270; thumb.appendChild(image);
      if (video.duration || video.isLive || video.isShort) thumb.appendChild(element("span", "focusfeed-duration", video.isLive ? "LIVE" : video.isShort ? "Shorts" : video.duration));
      var title = element("a", "focusfeed-card-title", video.title); title.href = href;
      var channel = element("a", "focusfeed-card-channel", video.channel || "Channel unavailable");
      var id = FocusFeedChannelPolicy.normalizeChannelId(video.channelId);
      if (id) channel.href = id[0] === "@" ? "/" + id : "/channel/" + encodeURIComponent(id);
      var details = element("details", "focusfeed-card-menu");
      var summary = element("summary", "", "⋮"); summary.setAttribute("aria-label", "More actions for " + video.title);
      var block = element("button", "", id ? "Block channel" : "Channel identity unavailable"); block.type = "button"; block.disabled = !id;
      block.addEventListener("click", async function () {
        block.disabled = true;
        try { await options.block(Object.assign({}, entry.video)); details.open = false; }
        catch (error) { notice = error.message; flush(); block.disabled = !FocusFeedChannelPolicy.normalizeChannelId(entry.video.channelId); }
      });
      details.append(summary, block); card.append(thumb, title, channel, details);
      return card;
    }
    function paintPublished(entry) {
      // Never replace a published slot with another video or collapse it under the pointer.
      var state = entry.action === "show" ? "show" : entry.action === "pending" ? "pending" : "filtered";
      var signature = JSON.stringify([state, entry.video.title, entry.video.channel, entry.video.channelId, entry.video.duration, entry.video.isShort, entry.video.isLive]);
      if (entry.signature === signature) return;
      entry.signature = signature;
      if (state === "show") {
        var updated = makeCard(entry);
        if (entry.node) { entry.node.replaceWith(updated); entry.node = updated; }
        else { entry.node = updated; grid.appendChild(updated); }
      } else if (entry.node) {
        // Keep the original footprint for a changed/expired/blocked published video.
        var height = entry.node.getBoundingClientRect().height;
        if (height > 0) entry.node.style.height = height + "px";
        entry.node.className = "focusfeed-card focusfeed-card-held";
        entry.node.replaceChildren(element("div", "", state === "pending" ? "Checking this video…" : "Video filtered"));
      }
    }
    function flush() {
      if (!host) return;
      if (staged.length && staged.every(function (entry) { return entry.action !== "pending"; })) {
        staged.forEach(function (entry) { if (entry.action === "show") paintPublished(entry); });
        staged = [];
      }
      entries.forEach(function (entry) {
        if (entry.node || (entry.admitted && entry.action === "show" && staged.indexOf(entry) === -1)) paintPublished(entry);
      });
      loading.hidden = !staged.length;
      var rows = Array.from(entries.values());
      var pending = rows.some(function (entry) { return entry.admitted && entry.action === "pending"; });
      var unavailable = rows.some(function (entry) { return entry.admitted && (entry.reason === "unavailable" || entry.reason === "invalid_assessment"); });
      var visible = rows.filter(function (entry) { return entry.node && entry.action === "show"; }).length;
      var rejected = rows.filter(function (entry) { return entry.admitted && entry.action === "hide"; }).length;
      var full = entries.size >= MAX_TRACKED && rows.every(function (entry) { return entry.admitted; });
      var message = pending ? "Filtering recommendations…" : unavailable ? "Some videos could not be checked. Retrying when the classifier is available." : waiting ? "Waiting for YouTube…" : notice || (full ? "This feed is full. Reload YouTube for a fresh feed." : visible ? visible + " videos · " + rejected + " filtered" : "No matching videos in this batch. Load more to continue.");
      setText(status, message);
      renderDiscovery(pending || unavailable || waiting, visible);
      more.disabled = pending || waiting || full;
      var busy = String(pending || waiting); if (host.getAttribute("aria-busy") !== busy) host.setAttribute("aria-busy", busy);
    }
    function renderDiscovery(busy, visible) {
      if (!discovery) return;
      var profile = prefs && root.FocusFeedSettings && FocusFeedSettings.effective(prefs);
      var successful = batches.filter(function (batch) {
        return batch.length && batch.every(function (entry) {
          return entry.action !== "pending" && ["model", "cache", "shared", "channel_block", "shorts_block"].indexOf(entry.reason) !== -1;
        });
      });
      discovery.hidden = !!(busy || visible || !profile || profile.mode !== "focus" ||
        !FocusFeedSettings.valid(profile) || successful.length < 2);
      if (discovery.hidden) return;
      var queries = profile.objectives.map(function (o) { return o.sourceText || o.text; })
        .filter(function (text, index, all) { return all.indexOf(text) === index; });
      var checked = successful.reduce(function (total, batch) { return total + batch.length; }, 0);
      var signature = JSON.stringify([queries, checked]);
      if (signature === discoveryKey) return;
      discoveryKey = signature;
      var title = element("strong", "", "Find videos for your focus goal");
      var detail = element("p", "", "No confident matches in " + checked + " recommendations checked. Search for your saved preferences; Focus will keep filtering the results.");
      var actions = element("div", "focusfeed-discovery-actions");
      queries.slice(0, 3).forEach(function (query) {
        var link = element("a", "", "Search: " + query);
        link.href = "/results?search_query=" + encodeURIComponent(query);
        actions.appendChild(link);
      });
      var edit = element("button", "", "Edit focus"); edit.type = "button";
      edit.addEventListener("click", async function () {
        edit.disabled = true;
        try { if (options.editGoal) await options.editGoal(); }
        catch (error) { notice = error.message; flush(); }
        finally { edit.disabled = false; }
      });
      actions.appendChild(edit); discovery.replaceChildren(title, detail, actions);
    }
    function render(target, video, action, reason) {
      var entry = targets.get(target);
      if (!entry) return false;
      if (video.videoId !== entry.video.videoId) return true;
      // Normalized classification data has the same ID; retain display/source fields.
      entry.action = action;
      entry.reason = reason || (action === "pending" ? "model_pending" : "unfiltered");
      if (action === "hide") target.dataset.focusfeedAutoHidden = "true";
      else delete target.dataset.focusfeedAutoHidden;
      if (!scheduled) {
        scheduled = true; var epoch = alive;
        Promise.resolve().then(function () { if (epoch !== alive) return; scheduled = false; flush(); });
      }
      return true;
    }
    function loadMore() {
      if (!host || staged.length || waiting || more.disabled) return;
      notice = "";
      if (Array.from(entries.values()).some(function (entry) { return !entry.admitted; })) {
        allowance += PAGE; askScan(); return;
      }
      waiting = true; flush();
      post("FOCUSFEED_PAGE_GATE_MORE");
      // Preserve the real continuation element and its native request path.
      var continuation = source.querySelector("ytd-continuation-item-renderer");
      var retry = continuation && continuation.querySelector("button, yt-button-renderer a");
      if (retry) retry.click();
      waitTimer = setTimeout(function () {
        waiting = false; notice = "YouTube has not supplied more videos yet. Scroll to the end or try again."; flush();
      }, 8000);
    }
    return { configure: configure, scan: scan, render: render, clear: clear, suspend: suspend,
      owns: function (card) { return !!(source && source.contains(card)); },
      active: function () { return !!host && host.isConnected; } };
  }
  root.FocusFeedHomeFeed = { create: create };
})(globalThis);
