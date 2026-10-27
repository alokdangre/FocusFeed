// YouTube surfaces and menu integration. No private YouTube APIs or guessed identities.
(function (root) {
  "use strict";
  var CARDS = ["ytd-rich-item-renderer", "yt-lockup-view-model", "ytd-compact-video-renderer", "ytd-video-renderer",
    "ytd-reel-item-renderer", "ytm-shorts-lockup-view-model", "ytm-shorts-lockup-view-model-v2",
    "ytd-playlist-video-renderer", "ytd-playlist-panel-video-renderer", "ytd-grid-video-renderer", "ytd-channel-renderer"].join(",");
  function create(adapter) {
    var runtime, target = null, menuToken = 0, toastTimer, toast, overlay, lastPlayback = null;
    var metadata = new WeakMap(), pausedByUs = new WeakSet();
    var prefs = null, configured = false, menuOwner = null, observedMenus = null, menuObserver = null;
    var previews = root.FocusFeedPreviewController ? root.FocusFeedPreviewController.create() : null;
    var home = root.FocusFeedHomeFeed ? root.FocusFeedHomeFeed.create({
      requestScan: adapter.requestScan,
      settings: settingsAction,
      block: blockChannel,
      editGoal: async function () {
        var response = await chrome.runtime.sendMessage({ type: "FF_OPEN_PREFERENCES" });
        if (!response || !response.ok) throw new Error("Could not open Focus settings. Open the extension popup to edit your goal.");
      },
    }) : null;
    function settingsAction(action) {
      return chrome.runtime.sendMessage({ type: "FF_SETTINGS_UPDATE", action: action }).then(function (response) {
        if (!response || !response.ok) throw new Error("Could not save display settings. Try again.");
        return runtime.reload();
      });
    }
    function configure(state) {
      prefs = state;
      configured = true;
      if (previews) previews.configure(state.enabled);
      if (home) home.configure(state);
      document.documentElement.toggleAttribute("data-focusfeed-hide-shorts", state.enabled && state.hideShorts === true);
    }
    async function blockChannel(video) {
      var id = FocusFeedChannelPolicy.normalizeChannelId(video.channelId);
      if (!id) throw new Error("Channel identity unavailable.");
      var response = await chrome.runtime.sendMessage({ type: "FF_BLOCK_ADD", scope: "global",
        channel: { channelId: id, channelLabel: video.channel || id, aliases: video.aliases || [] } });
      if (!response || !response.ok) throw new Error("Could not save channel block. Try again.");
      await runtime.reload();
      notify("Blocked " + (video.channel || id), response.data.created ? function () { return removeBlock(response.data.block); } : null);
    }
    function setRuntime(value) { runtime = value; }
    function player() {
      if (location.pathname.indexOf("/shorts/") === 0) return document.querySelector("ytd-reel-video-renderer[is-active]");
      if (location.pathname === "/watch" || /^\/(live|clip)\//.test(location.pathname)) return document.querySelector("ytd-watch-flexy:not([hidden]) #player-container-outer") || document.querySelector("ytd-watch-flexy:not([hidden]) #primary-inner") || document.querySelector("ytd-watch-flexy #primary");
      return null;
    }
    function currentVideo() {
      var surface = player();
      if (!surface) return null;
      var watch = surface.closest("ytd-watch-flexy");
      var id = new URL(location.href).searchParams.get("v") || location.pathname.split("/shorts/")[1] ||
        location.pathname.split("/live/")[1] || watch && watch.getAttribute("video-id");
      if (!id) return null;
      var context = watch || surface;
      var owner = context.querySelector("#owner") || context.querySelector("#channel-name") || context.querySelector(".ytd-reel-player-header-renderer") || context.querySelector("yt-reel-channel-bar-view-model") || context;
      var link = owner.querySelector('a[href*="/channel/"], a[href*="/@"]');
      var video = adapter.lookup(id) || {};
      return { card: surface, video: Object.assign({}, video, { videoId: id,
        title: video.title || (context.querySelector("h1") || context.querySelector("h2") || {}).textContent || "",
        channel: link && link.textContent.trim() || video.channel || "",
        channelId: video.channelId || link && FocusFeedChannelPolicy.normalizeChannelId(link.getAttribute("href")) || "",
        aliases: [video.channelId, link && link.getAttribute("href")].filter(Boolean),
        isShort: location.pathname.indexOf("/shorts/") === 0, playback: true }) };
    }
    function clearOverlay() {
      if (overlay) overlay.remove();
      overlay = null;
      document.querySelectorAll("[data-focusfeed-playback]").forEach(function (el) { el.removeAttribute("data-focusfeed-playback"); });
      lastPlayback = null;
    }
    function notify(message, undo) {
      if (toast) toast.remove();
      clearTimeout(toastTimer);
      toast = document.createElement("div"); toast.className = "focusfeed-toast";
      toast.setAttribute("role", "status");
      var text = document.createElement("span"); text.textContent = message; toast.appendChild(text);
      if (undo) {
        var button = document.createElement("button"); button.textContent = "Undo";
        button.addEventListener("click", async function () {
          button.disabled = true;
          try { await undo(); toast.remove(); } catch (_) { button.disabled = false; text.textContent = "Could not undo. Try again."; }
        });
        toast.appendChild(button);
      }
      (document.body || document.documentElement).appendChild(toast);
      toastTimer = setTimeout(function () { if (toast) toast.remove(); }, 12000);
    }
    async function removeBlock(block) {
      var result = await chrome.runtime.sendMessage({ type: "FF_BLOCK_REMOVE", id: block.id });
      if (!result || !result.ok) throw new Error("Could not unblock channel");
      await runtime.reload();
    }
    function render(card, video, action, reason) {
      metadata.set(card, video);
      if (card === player()) {
        // A delayed semantic result must never cover a video the user opened.
        var explicitBlock = action === "hide" && (reason === "channel_block" || reason === "shorts_block");
        if (!explicitBlock) {
          clearOverlay();
          card.querySelectorAll("video").forEach(function (v) {
            if (pausedByUs.has(v)) {
              pausedByUs.delete(v);
              if (v.play) { var promise = v.play(); if (promise) promise.catch(function () {}); }
            }
          });
          return;
        }
        card.dataset.focusfeedPlayback = "true";
        // Pause on every scan, including autoplay and player replacement.
        card.querySelectorAll("video").forEach(function (v) { if (!v.paused) { pausedByUs.add(v); v.pause(); } });
        var key = video.videoId + ":" + action + ":" + reason;
        if (lastPlayback === key && overlay && overlay.isConnected) return;
        clearOverlay(); card.dataset.focusfeedPlayback = "true"; lastPlayback = key;
        overlay = document.createElement("div"); overlay.className = "focusfeed-playback";
        overlay.setAttribute("role", "region"); overlay.setAttribute("aria-label", "FocusFeed playback filter");
        var title = document.createElement("strong");
        title.textContent = reason === "shorts_block" ? "Shorts are hidden" : "This channel is blocked";
        var detail = document.createElement("p");
        detail.textContent = "Manage blocked channels in FocusFeed to unblock it.";
        overlay.append(title, detail);
        if (reason === "shorts_block") {
          detail.textContent = "Turn off Hide Shorts to watch Shorts.";
          var allowShorts = document.createElement("button"); allowShorts.textContent = "Show Shorts";
          allowShorts.addEventListener("click", function () {
            allowShorts.disabled = true;
            settingsAction({ type: "setHideShorts", enabled: false }).catch(function (error) { allowShorts.disabled = false; detail.textContent = error.message; });
          }); overlay.appendChild(allowShorts);
        }
        var back = document.createElement("a"); back.href = "/"; back.textContent = "Go to Home"; overlay.appendChild(back);
        card.appendChild(overlay);
        return;
      }
      if (home && home.render(card, video, action, reason)) return;
      // Hiding a native card does not stop its media, even if CSS removes its pixels.
      if (action !== "show") card.querySelectorAll("video").forEach(function (v) { if (!v.paused) v.pause(); });
      function flag(name, value) {
        if (value) { if (card.dataset[name] !== "true") card.dataset[name] = "true"; }
        else if (card.dataset[name]) delete card.dataset[name];
      }
      flag("focusfeedAutoHidden", action === "hide"); flag("focusfeedAutoPending", action === "pending");
      nativePresentation(card, video, action, reason);
    }
    function nativePresentation(card, video, action, reason) {
      card.dataset.focusfeedSurface = "native";
      var holder = card.querySelector(".focusfeed-native-placeholder");
      if (prefs && !prefs.enabled) {
        if (holder) holder.remove();
        var oldActions = card.querySelector(".focusfeed-native-actions"); if (oldActions) oldActions.remove();
        return;
      }
      if (action === "show") {
        if (holder) holder.remove();
        if (!card.querySelector(".focusfeed-native-actions")) {
          var details = document.createElement("details"); details.className = "focusfeed-native-actions focusfeed-card-menu";
          details.dataset.focusfeedUi = "actions";
          var summary = document.createElement("summary"); summary.textContent = "⋮"; summary.setAttribute("aria-label", "FocusFeed video actions");
          var block = document.createElement("button"); block.type = "button";
          block.addEventListener("click", async function () {
            var current = adapter.extract(card) || metadata.get(card);
            if (!current) return;
            block.disabled = true;
            try { await blockChannel(current); details.open = false; }
            catch (error) { block.disabled = false; notify(error.message); }
          });
          details.append(summary, block); card.appendChild(details);
        }
        var button = card.querySelector(".focusfeed-native-actions button");
        if (button) {
          var available = !!FocusFeedChannelPolicy.normalizeChannelId(video.channelId);
          var copy = available ? "Block channel" : "Channel identity unavailable";
          if (button.textContent !== copy) button.textContent = copy;
          button.disabled = !available;
        }
        return;
      }
      var actions = card.querySelector(".focusfeed-native-actions"); if (actions) actions.remove();
      if (!holder) {
        holder = document.createElement("div"); holder.className = "focusfeed-native-placeholder";
        holder.dataset.focusfeedUi = "placeholder"; holder.setAttribute("role", "status"); card.appendChild(holder);
      }
      var key = video.videoId + ":" + action + ":" + reason;
      if (holder.dataset.state === key) return;
      holder.dataset.state = key;
      holder.textContent = action === "pending" ? "Checking video…" : reason === "shorts_block" ? "Shorts hidden" : "Video filtered";
      if (action === "hide" && reason !== "channel_block" && reason !== "shorts_block") {
        var once = document.createElement("button"); once.type = "button"; once.textContent = "Show once";
        once.addEventListener("click", function () { var current = adapter.extract(card) || metadata.get(card); if (current) runtime.restore(current.videoId); });
        holder.appendChild(once);
      }
    }
    function clear() {
      configured = false;
      document.querySelectorAll("[data-focusfeed-auto-hidden], [data-focusfeed-auto-pending]").forEach(function (card) {
        delete card.dataset.focusfeedAutoHidden; delete card.dataset.focusfeedAutoPending;
      });
      document.querySelectorAll("[data-focusfeed-surface]").forEach(function (card) { delete card.dataset.focusfeedSurface; });
      clearOverlay(); pausedByUs = new WeakSet(); target = null; menuToken++;
      menuOwner = null;
      if (home) home.suspend();
      if (previews) previews.configure(false);
      document.documentElement.removeAttribute("data-focusfeed-hide-shorts");
      document.querySelectorAll(".focusfeed-menu-action, .focusfeed-native-placeholder, .focusfeed-native-actions").forEach(function (el) { el.remove(); });
    }
    function resolveTarget(node) {
      var card = node.closest(CARDS);
      if (card) return adapter.extract(card) || metadata.get(card);
      var surface = player();
      if (surface && surface.contains(node)) { var playing = currentVideo(); return playing && playing.video; }
      var header = node.closest("ytd-c4-tabbed-header-renderer, yt-page-header-renderer, ytd-page-header-renderer, ytd-channel-tagline-renderer");
      if (header) {
        var id = FocusFeedChannelPolicy.normalizeChannelId(location.pathname);
        return id ? { channelId: id, channel: (document.querySelector("h1") || {}).textContent || id, aliases: [id] } : null;
      }
      return null;
    }
    function capture(event) {
      if (event.target.closest && event.target.closest("[data-focusfeed-ui], .focusfeed-menu-action, ytd-menu-popup-renderer, yt-sheet-view-model")) return;
      var node = event.target.closest && event.target.closest("ytd-menu-renderer, yt-button-shape, button[aria-haspopup], button[aria-label], yt-icon-button");
      if (!node) { target = null; menuToken++; return; }
      // Match the structural overflow menu, without depending on English labels.
      if (!node.closest("ytd-menu-renderer") && !node.querySelector('[icon*="more"], [icon*="MORE"]') &&
          !node.matches('[aria-haspopup="true"], [aria-haspopup="menu"]') && !node.querySelector('[aria-haspopup="true"], [aria-haspopup="menu"]') &&
          !/more|menu|action/i.test(node.getAttribute("aria-label") || "")) { target = null; return; }
      target = resolveTarget(node);
      menuOwner = node.closest(CARDS);
      menuToken++;
      document.querySelectorAll(".focusfeed-menu-action").forEach(function (el) { el.remove(); });
      watchMenus();
      Promise.resolve().then(decorate);
    }
    function watchMenus() {
      if (typeof MutationObserver === "undefined") return;
      var container = document.querySelector("ytd-popup-container");
      if (!container || container === observedMenus) return;
      if (menuObserver) menuObserver.disconnect();
      observedMenus = container; menuObserver = new MutationObserver(decorate);
      menuObserver.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "aria-hidden", "style"] });
    }
    function decorate() {
      watchMenus();
      if (previews) previews.sweep();
      if (!target) return;
      var id = FocusFeedChannelPolicy.normalizeChannelId(target.channelId);
      var menu = Array.from(document.querySelectorAll("ytd-menu-popup-renderer, yt-sheet-view-model [role='menu'], yt-sheet-view-model yt-list-view-model"))
        .find(function (el) { return el.getClientRects().length && !el.closest("[hidden], [aria-hidden='true']"); });
      if (!menu || menu.querySelector(".focusfeed-menu-action")) return;
      var button = document.createElement("button"); button.className = "focusfeed-menu-action";
      button.setAttribute("role", "menuitem"); button.disabled = !id;
      var icon = document.createElement("span"); icon.textContent = "⊘"; icon.setAttribute("aria-hidden", "true");
      var labels = document.createElement("span");
      var main = document.createElement("span"); main.textContent = "Block channel";
      var sub = document.createElement("small"); sub.textContent = id ? target.channel || id : "Channel identity unavailable";
      labels.append(main, sub); button.append(icon, labels);
      var captured = Object.assign({}, target), token = menuToken;
      var owner = menuOwner;
      button.addEventListener("click", async function (event) {
        event.preventDefault(); event.stopPropagation();
        if (token !== menuToken || !id) return;
        var currentOwner = owner && (adapter.extract(owner) || metadata.get(owner));
        if (owner && (!owner.isConnected || !currentOwner || currentOwner.videoId !== captured.videoId ||
            FocusFeedChannelPolicy.normalizeChannelId(currentOwner.channelId) !== id)) {
          notify("This video changed. Reopen its menu."); return;
        }
        button.disabled = true;
        try {
          await blockChannel(captured);
          button.remove(); target = null;
          // Escape closes YouTube's popup without invoking another menu item.
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        } catch (_) { button.disabled = false; notify("Could not save channel block. Try again."); }
      });
      (menu.querySelector("#items") || menu).appendChild(button);
    }
    document.addEventListener("click", capture, true);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        target = null; menuToken++;
        document.querySelectorAll(".focusfeed-card-menu[open]").forEach(function (details) { details.open = false; });
      }
      if (event.key === "Enter" || event.key === " ") capture(event);
    }, true);
    document.addEventListener("contextmenu", function () { target = null; menuToken++; }, true);
    document.addEventListener("play", function (event) {
      if (event.target.closest && event.target.closest("[data-focusfeed-playback]")) {
        pausedByUs.add(event.target); event.target.pause();
      } else if (runtime) runtime.tick();
    }, true);
    return { setRuntime: setRuntime, render: render, clear: clear, configure: configure,
      scanHome: function (extract) { return configured && home && home.scan(extract, runtime); },
      manages: function (card) { return home && home.owns(card); },
      currentVideo: currentVideo, decorate: decorate, cards: CARDS,
      stop: function () { clear(); if (home) home.clear(); if (menuObserver) menuObserver.disconnect(); if (previews) previews.stop(); } };
  }
  root.FocusFeedYouTubeUI = { create: create };
})(globalThis);
