// YouTube surfaces and menu integration. No private YouTube APIs or guessed identities.
(function (root) {
  "use strict";
  var PLAYER_CARDS = "a.ytp-videowall-still, a.ytp-modern-videowall-still, a.ytp-suggestion-link, a.ytp-autonav-endscreen-link-container";
  var CARDS = ["ytd-rich-item-renderer", "yt-lockup-view-model", "ytd-compact-video-renderer", "ytd-video-renderer",
    "ytd-radio-renderer", "ytd-playlist-renderer", "ytd-compact-radio-renderer", "ytd-compact-playlist-renderer",
    "ytd-reel-item-renderer", "ytm-shorts-lockup-view-model", "ytm-shorts-lockup-view-model-v2",
    "ytd-playlist-video-renderer", "ytd-playlist-panel-video-renderer", "ytd-grid-video-renderer", "ytd-channel-renderer", PLAYER_CARDS].join(",");
  function create(adapter) {
    var runtime, target = null, menuToken = 0, toastTimer, toast, overlay, lastPlayback = null, reviewBanner = null;
    var metadata = new WeakMap(), pausedByUs = new WeakSet();
    var prefs = null, configured = false, menuOwner = null, observedMenus = null, menuObserver = null;
    var resolvedChannels = new Map(), resolvingToken = null, failedLookupToken = null;
    var previews = root.FocusFeedPreviewController ? root.FocusFeedPreviewController.create() : null;
    var loading = root.FocusFeedLoadingUI ? root.FocusFeedLoadingUI.create() : null;
    var home = root.FocusFeedHomeFeed ? root.FocusFeedHomeFeed.create({
      requestScan: adapter.requestScan,
      retry: function () { return runtime.reload(true); },
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
      document.documentElement.removeAttribute("data-focusfeed-initializing");
      prefs = state;
      if (!state.enabled || !state.general || FocusFeedSettings.effective(state).mode !== "general") reviewHidden(false);
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
    function reviewHidden(enabled) {
      var active = enabled !== false && prefs && prefs.enabled && FocusFeedSettings.effective(prefs).mode === "general";
      document.documentElement.toggleAttribute("data-focusfeed-review-hidden", active);
      if (reviewBanner) reviewBanner.remove(); reviewBanner = null;
      if (active) {
        reviewBanner = document.createElement("div"); reviewBanner.className = "focusfeed-review-banner"; reviewBanner.dataset.focusfeedUi = "true";
        var label = document.createElement("span"); label.textContent = "Reviewing filtered videos · use ⋯ to correct a topic";
        var close = document.createElement("button"); close.textContent = "Done";
        close.addEventListener("click", function () { reviewHidden(false); }); reviewBanner.append(label, close);
        (document.body || document.documentElement).appendChild(reviewBanner);
      }
      return { reviewing: !!active };
    }
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
      if (watch && watch.getAttribute("video-id") && watch.getAttribute("video-id") !== id) return null;
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
      card.toggleAttribute("data-focusfeed-reviewable", action === "hide" && reason !== "channel_block" && reason !== "shorts_block" && card !== player());
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
      if (loading) loading.render(card, action);
    }
    function clear(preserveCards) {
      document.documentElement.removeAttribute("data-focusfeed-initializing");
      configured = false;
      if (loading) loading.clear();
      if (!preserveCards) document.querySelectorAll("[data-focusfeed-auto-hidden], [data-focusfeed-auto-pending]").forEach(function (card) {
        delete card.dataset.focusfeedAutoHidden; delete card.dataset.focusfeedAutoPending;
      });
      clearOverlay(); pausedByUs = new WeakSet(); target = null; menuToken++;
      menuOwner = null;
      if (home) home.suspend();
      if (!preserveCards) {
        if (previews) previews.configure(false);
        document.documentElement.removeAttribute("data-focusfeed-hide-shorts");
      }
      document.querySelectorAll(".focusfeed-menu-action, .focusfeed-topic-action").forEach(function (el) { el.remove(); });
      reviewHidden(false);
    }
    function resolveTarget(node) {
      var card = node.closest("ytd-rich-item-renderer") || node.closest(CARDS);
      if (card) return withChannel(adapter.extract(card) || metadata.get(card));
      var surface = player();
      if (surface && (surface.contains(node) || node.closest("ytd-watch-metadata, #info #menu, #primary-inner #actions"))) { var playing = currentVideo(); return playing && playing.video; }
      var header = node.closest("ytd-c4-tabbed-header-renderer, yt-page-header-renderer, ytd-page-header-renderer, ytd-channel-tagline-renderer");
      if (header) {
        var id = FocusFeedChannelPolicy.normalizeChannelId(location.pathname);
        return id ? { channelId: id, channel: (document.querySelector("h1") || {}).textContent || id, aliases: [id] } : null;
      }
      return null;
    }
    function withChannel(video) {
      var found = video && resolvedChannels.get(video.videoId);
      return found && !FocusFeedChannelPolicy.normalizeChannelId(video.channelId)
        ? Object.assign({}, video, { channelId: found.channelId, channel: video.channel || found.channelLabel }) : video;
    }
    async function findChannel(video, owner, token) {
      if (!video || video.collection || FocusFeedChannelPolicy.normalizeChannelId(video.channelId) || !/^[A-Za-z0-9_-]{11}$/.test(video.videoId || "")) return;
      resolvingToken = token; failedLookupToken = null;
      try {
        var response = await chrome.runtime.sendMessage({ type: "FF_CHANNEL_RESOLVE", videoId: video.videoId });
        if (token !== menuToken) return;
        var current = owner && resolveTarget(owner);
        if (owner && (!owner.isConnected || !current || current.videoId !== video.videoId)) return;
        if (current && FocusFeedChannelPolicy.normalizeChannelId(current.channelId)) { target = current; return; }
        var found = response && response.ok && response.data;
        if (!found || found.videoId !== video.videoId || !FocusFeedChannelPolicy.normalizeChannelId(found.channelId)) throw new Error("Channel lookup failed.");
        resolvedChannels.set(video.videoId, found);
        if (resolvedChannels.size > 100) resolvedChannels.delete(resolvedChannels.keys().next().value);
        if (adapter.rememberChannel) adapter.rememberChannel(found);
        target = withChannel(current || video);
      } catch (_) { if (token === menuToken) failedLookupToken = token; }
      finally { if (token === menuToken) { resolvingToken = null; decorate(); } }
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
      menuOwner = node.closest("ytd-rich-item-renderer") || node.closest(CARDS) || node.closest("ytd-watch-metadata, #info #menu, #primary-inner #actions");
      menuToken++;
      document.querySelectorAll(".focusfeed-menu-action, .focusfeed-topic-action").forEach(function (el) { el.remove(); });
      watchMenus();
      Promise.resolve().then(decorate);
      findChannel(target, menuOwner, menuToken);
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
      var latest = menuOwner && resolveTarget(menuOwner);
      if (latest && latest.videoId === target.videoId) target = latest;
      var choices = FocusFeedChannelPolicy.creators(target);
      var menu = Array.from(document.querySelectorAll("ytd-menu-popup-renderer, yt-sheet-view-model [role='menu'], yt-sheet-view-model yt-list-view-model, yt-contextual-sheet-layout yt-list-view-model, yt-contextual-sheet-layout [role='menu']"))
        .find(function (el) { return el.getClientRects().length && !el.closest("[hidden], [aria-hidden='true']"); });
      if (!menu) return;
      if (target.collection) { menu.querySelectorAll(".focusfeed-menu-action, .focusfeed-topic-action").forEach(function (node) { node.remove(); }); return; }
      var signature = JSON.stringify([menuToken, choices, resolvingToken === menuToken, failedLookupToken === menuToken, prefs && prefs.revision,
        document.documentElement.hasAttribute("data-focusfeed-review-hidden")]);
      var existing = menu.querySelector(".focusfeed-menu-action");
      if (existing && existing.dataset.signature === signature) return;
      menu.querySelectorAll(".focusfeed-menu-action, .focusfeed-topic-action").forEach(function (node) { node.remove(); });
      if (!choices.length) choices = [{ channelId: "", label: "", aliases: [] }];
      choices.forEach(function (choice) {
        var id = choice.channelId;
        var button = document.createElement("button"); button.className = "focusfeed-menu-action";
        button.dataset.signature = signature;
        button.setAttribute("role", "menuitem"); button.disabled = !id;
        var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("width", "24"); icon.setAttribute("height", "24"); icon.setAttribute("aria-hidden", "true");
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 1.5a8.5 8.5 0 0 1 6.52 13.95L6.55 5.48A8.46 8.46 0 0 1 12 3.5ZM5.48 6.55l11.97 11.97A8.5 8.5 0 0 1 5.48 6.55Z");
        icon.appendChild(path);
        var labels = document.createElement("span");
        var main = document.createElement("span"); main.textContent = !id && resolvingToken === menuToken ? "Finding channel…" : choices.length > 1 ? "Block " + choice.label : "Block channel";
        var sub = document.createElement("small"); sub.textContent = id ? choice.label || id : resolvingToken === menuToken ? "Finding channel…" :
          failedLookupToken === menuToken ? "Could not identify this channel. Reopen the menu to retry." : "Channel identity unavailable";
        labels.append(main, sub); button.append(icon, labels);
        button.setAttribute("aria-label", "Block channel: " + sub.textContent); button.setAttribute("title", sub.textContent);
        var captured = Object.assign({}, target, { channelId: id, channel: choice.label, aliases: choice.aliases }), token = menuToken;
        var owner = menuOwner;
        button.addEventListener("click", async function (event) {
          event.preventDefault(); event.stopPropagation();
          if (token !== menuToken || !id) return;
          var currentOwner = owner && resolveTarget(owner);
          if (owner && (!owner.isConnected || !currentOwner || currentOwner.videoId !== captured.videoId ||
              !FocusFeedChannelPolicy.creators(currentOwner).some(function (creator) { return creator.channelId === id || creator.aliases.includes(id); }))) {
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
      });
      topicActions(menu);
    }
    function topicActions(menu) {
      if (!prefs || !prefs.enabled || target.playback || !/^[A-Za-z0-9_-]{11}$/.test(target.videoId || "") || typeof FocusFeedLearningPolicy === "undefined") return;
      var profile = FocusFeedSettings.effective(prefs);
      if (profile.mode !== "general" || !FocusFeedSettings.valid(profile)) return;
      var captured = Object.assign({}, target), owner = menuOwner, token = menuToken, revision = prefs.revision;
      var restoring = document.documentElement.hasAttribute("data-focusfeed-review-hidden");
      profile.objectives.forEach(function (objective) {
        var button = document.createElement("button"); button.className = "focusfeed-topic-action"; button.setAttribute("role", "menuitem");
        button.textContent = (restoring ? "This isn't “" : "Hide as “") + objective.text + "”";
        button.addEventListener("click", async function (event) {
          event.preventDefault(); event.stopPropagation();
          var current = owner && resolveTarget(owner);
          if (token !== menuToken || revision !== prefs.revision || owner && (!owner.isConnected || !current || current.videoId !== captured.videoId)) {
            notify("This video or topic changed. Reopen its menu."); return;
          }
          button.disabled = true;
          try {
            var record = runtime.snapshot().records.find(function (r) { return r.video.videoId === captured.videoId; });
            var response = await chrome.runtime.sendMessage({ type: "FF_CORRECTION_ADD", revision: revision, video: captured,
              topicKey: FocusFeedVideo.objectiveKey(objective), match: !restoring, assessment: record && record.assessment });
            if (!response || !response.ok) throw new Error("Could not save the correction.");
            await runtime.reload();
            notify(restoring ? "Saved: this isn't “" + objective.text + "”" : "Hidden as “" + objective.text + "”. Checking its channel…", async function () {
              var undone = await chrome.runtime.sendMessage({ type: "FF_CORRECTION_UNDO", id: response.data.id });
              if (!undone || !undone.ok) throw new Error("Could not undo correction.");
              await runtime.reload();
            });
            if (!restoring) {
              var feedbackToast = toast;
              chrome.runtime.sendMessage({ type: "FF_CHANNEL_LEARN", video: captured, revision: revision, triggerId: response.data.id }).then(function (result) {
                if (toast !== feedbackToast || !toast) return;
                var label = toast.querySelector("span");
                if (!result || !result.ok) label.textContent = "Video hidden. Its channel could not be checked yet.";
                else if (result.data && result.data.blockedTopics && result.data.blockedTopics.includes(objective.text)) label.textContent = "Hidden this channel's recommendations for “" + objective.text + "”.";
                else if (result.data && result.data.status === "deferred") label.textContent = "Video hidden. Its channel check is deferred.";
                else label.textContent = "Video hidden. No channel-wide match established.";
              }).catch(function () { if (toast === feedbackToast && toast) toast.querySelector("span").textContent = "Video hidden. Its channel could not be checked yet."; });
            }
            menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          } catch (error) { button.disabled = false; notify(error.message); }
        });
        (menu.querySelector("#items") || menu).appendChild(button);
      });
    }
    document.addEventListener("click", capture, true);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        target = null; menuToken++;
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
      activity: function (value) { if (loading) loading.activity(value); },
      scanHome: function (extract) { return configured && home && home.scan(extract, runtime); },
      manages: function (card) { return home && home.owns(card); },
      currentVideo: currentVideo, decorate: decorate, cards: CARDS, reviewHidden: reviewHidden,
      stop: function () { clear(); if (loading) loading.stop(); if (home) home.clear(); if (menuObserver) menuObserver.disconnect(); if (previews) previews.stop(); } };
  }
  root.FocusFeedYouTubeUI = { create: create, playerCards: PLAYER_CARDS };
})(globalThis);
