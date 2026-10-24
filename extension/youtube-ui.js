// YouTube surfaces and menu integration. No private YouTube APIs or guessed identities.
(function (root) {
  "use strict";
  var CARDS = ["ytd-rich-item-renderer", "yt-lockup-view-model", "ytd-compact-video-renderer", "ytd-video-renderer",
    "ytd-reel-item-renderer", "ytm-shorts-lockup-view-model", "ytm-shorts-lockup-view-model-v2",
    "ytd-playlist-video-renderer", "ytd-playlist-panel-video-renderer", "ytd-grid-video-renderer", "ytd-channel-renderer"].join(",");
  function create(adapter) {
    var runtime, target = null, menuToken = 0, toastTimer, toast, overlay, lastPlayback = null;
    var metadata = new WeakMap(), pausedByUs = new WeakSet();
    function setRuntime(value) { runtime = value; }
    function player() {
      if (location.pathname.indexOf("/shorts/") === 0) return document.querySelector("ytd-reel-video-renderer[is-active]");
      if (location.pathname === "/watch" || /^\/(live|clip)\//.test(location.pathname)) return document.querySelector("ytd-watch-flexy:not([hidden]) #primary-inner") || document.querySelector("ytd-watch-flexy #primary");
      return null;
    }
    function currentVideo() {
      var surface = player();
      if (!surface) return null;
      var watch = surface.closest("ytd-watch-flexy");
      var id = new URL(location.href).searchParams.get("v") || location.pathname.split("/shorts/")[1] ||
        location.pathname.split("/live/")[1] || watch && watch.getAttribute("video-id");
      if (!id) return null;
      var owner = surface.querySelector("#owner") || surface.querySelector("#channel-name") || surface.querySelector(".ytd-reel-player-header-renderer") || surface.querySelector("yt-reel-channel-bar-view-model") || surface;
      var link = owner.querySelector('a[href*="/channel/"], a[href*="/@"]');
      var video = adapter.lookup(id) || {};
      return { card: surface, video: Object.assign({}, video, { videoId: id,
        title: (surface.querySelector("h1") || surface.querySelector("h2") || {}).textContent || video.title || "",
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
        if (action === "show") {
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
        title.textContent = action === "pending" ? "Checking this video…" : reason === "channel_block" ? "This channel is blocked" : reason === "unavailable" ? "Could not check this video" : "Outside your feed preferences";
        var detail = document.createElement("p");
        detail.textContent = reason === "channel_block" ? "Manage blocked channels in FocusFeed to unblock it." : action === "pending" ? "FocusFeed is checking your saved topics." : "You can choose to watch this video once.";
        overlay.append(title, detail);
        if (action !== "pending" && reason !== "channel_block") {
          var restore = document.createElement("button"); restore.textContent = "Watch once";
          restore.addEventListener("click", function () { runtime.restore(video.videoId); }); overlay.appendChild(restore);
        }
        var back = document.createElement("a"); back.href = "/"; back.textContent = "Go to Home"; overlay.appendChild(back);
        (document.body || document.documentElement).appendChild(overlay);
        return;
      }
      function flag(name, value) {
        if (value) { if (card.dataset[name] !== "true") card.dataset[name] = "true"; }
        else if (card.dataset[name]) delete card.dataset[name];
      }
      flag("focusfeedAutoHidden", action === "hide"); flag("focusfeedAutoPending", action === "pending");
    }
    function clear() {
      document.querySelectorAll("[data-focusfeed-auto-hidden], [data-focusfeed-auto-pending]").forEach(function (card) {
        delete card.dataset.focusfeedAutoHidden; delete card.dataset.focusfeedAutoPending;
      });
      clearOverlay(); pausedByUs = new WeakSet(); target = null; menuToken++;
      document.querySelectorAll(".focusfeed-menu-action").forEach(function (el) { el.remove(); });
    }
    function resolveTarget(node) {
      var card = node.closest(CARDS);
      if (card) return metadata.get(card) || adapter.extract(card);
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
      if (event.target.closest && event.target.closest(".focusfeed-menu-action, ytd-menu-popup-renderer, yt-sheet-view-model")) return;
      var node = event.target.closest && event.target.closest("ytd-menu-renderer, yt-button-shape, button[aria-haspopup], button[aria-label], yt-icon-button");
      if (!node) { target = null; menuToken++; return; }
      // Match the structural overflow menu, without depending on English labels.
      if (!node.closest("ytd-menu-renderer") && !node.querySelector('[icon*="more"], [icon*="MORE"]') &&
          !/more|menu|action/i.test(node.getAttribute("aria-label") || "")) { target = null; return; }
      target = resolveTarget(node);
      menuToken++;
      document.querySelectorAll(".focusfeed-menu-action").forEach(function (el) { el.remove(); });
      setTimeout(decorate, 0); setTimeout(decorate, 150);
    }
    function decorate() {
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
      button.addEventListener("click", async function (event) {
        event.preventDefault(); event.stopPropagation();
        if (token !== menuToken || !id) return;
        button.disabled = true;
        try {
          var response = await chrome.runtime.sendMessage({ type: "FF_BLOCK_ADD", scope: "global",
            channel: { channelId: id, channelLabel: captured.channel || id, aliases: captured.aliases || [] } });
          if (!response || !response.ok) throw new Error("Could not save channel block");
          button.remove(); target = null;
          // Escape closes YouTube's popup without invoking another menu item.
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          await runtime.reload();
          notify("Blocked " + (captured.channel || id), response.data.created ? function () { return removeBlock(response.data.block); } : null);
        } catch (_) { button.disabled = false; notify("Could not save channel block. Try again."); }
      });
      (menu.querySelector("#items") || menu).appendChild(button);
    }
    document.addEventListener("click", capture, true);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { target = null; menuToken++; }
      if (event.key === "Enter" || event.key === " ") capture(event);
    }, true);
    document.addEventListener("contextmenu", function () { target = null; menuToken++; }, true);
    document.addEventListener("play", function (event) {
      if (event.target.closest && event.target.closest("[data-focusfeed-playback]")) {
        pausedByUs.add(event.target); event.target.pause();
      } else if (runtime) runtime.tick();
    }, true);
    return { setRuntime: setRuntime, render: render, clear: clear, currentVideo: currentVideo, decorate: decorate, cards: CARDS };
  }
  root.FocusFeedYouTubeUI = { create: create };
})(globalThis);
