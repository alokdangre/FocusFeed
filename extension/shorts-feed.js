// Conceal Shorts until approved, and advance rejected items using native controls.
(function (root) {
  "use strict";
  var ALLOWED = "data-focusfeed-shorts-allowed", GATE = "data-focusfeed-shorts-filtering";
  var REFRESH = ["refreshing", "refresh_retrying", "refresh_failed", "channel_pending"];
  var FAILED = ["check_failed", "check_retrying", "refresh_failed", "refresh_retrying", "unavailable", "invalid_assessment"];
  function create(options) {
    var enabled = false, state = null, current = null, permitted = new Set(), cardPermits = new Map(), status = null, skipTimer = null, suspended = false, navigating = false;
    var queue = options.queue || FocusFeedShortsQueue.create(), lastAllowed = null, direction = 1, explicitIntent = false, visit = 0, encountered = new Map(), updateError = "";
    var CARDS = "ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer";
    function onShorts() { return /^\/shorts(?:\/|$)/.test(location.pathname); }
    function revoke() {
      permitted.forEach(function (node) { node.removeAttribute(ALLOWED); }); permitted.clear();
    }
    function cancelSkip() { clearTimeout(skipTimer); skipTimer = null; }
    function reset() { cancelSkip(); revoke(); current = null; }
    function dismiss() { if (status) status.remove(); status = null; }
    function message(text, retry) {
      if (status && status.dataset.message === text) return;
      dismiss(); status = document.createElement("div"); status.className = "focusfeed-shorts-status";
      status.dataset.focusfeedUi = "shorts-status"; status.dataset.message = text; status.setAttribute("role", "status");
      var label = document.createElement("span"); label.textContent = text; status.appendChild(label);
      if (retry) {
        var button = document.createElement("button"); button.textContent = "Try again";
        button.addEventListener("click", function () {
          if (retry === "settings" && options.retryUpdate) Promise.resolve(options.retryUpdate()).catch(function () {});
          else if (current && current.phase === "failed") options.retry(current.id);
        }); status.appendChild(button);
      }
      (document.body || document.documentElement).appendChild(status);
    }
    function snapshot() {
      var playing = options.current();
      if (!playing || !playing.video.isShort) return null;
      var media = playing.card.querySelector("video");
      return { card: playing.card, context: playing.context || playing.card, media: media, id: playing.video.videoId,
        video: playing.video, epoch: queue.epoch(), fingerprint: FocusFeedVideo.fingerprint(playing.video),
        token: JSON.stringify([location.pathname, FocusFeedVideo.fingerprint(playing.video),
          media && (media.currentSrc || media.getAttribute("src") || "")]) };
    }
    function same(a, b) { return !!(a && b && a.epoch === b.epoch && a.card === b.card && a.media === b.media && a.token === b.token); }
    function clearRemovedSlots() {
      document.querySelectorAll("[data-focusfeed-shorts-removed], [data-focusfeed-shorts-current]").forEach(function (node) {
        node.removeAttribute("data-focusfeed-shorts-removed"); node.removeAttribute("data-focusfeed-shorts-current");
      });
    }
    function restoreRecycledSlots() {
      document.querySelectorAll("[data-focusfeed-shorts-removed]").forEach(function (node) {
        if (!queue.isRemoved(node.getAttribute("video-id"))) {
          node.removeAttribute("data-focusfeed-shorts-removed"); node.removeAttribute("data-focusfeed-shorts-current");
        }
      });
    }
    function syncRemovedSlots(active) {
      document.querySelectorAll("ytd-reel-video-renderer[video-id]").forEach(function (node) {
        var id = node.getAttribute("video-id"), ownsMedia = active && active.media && node.contains(active.media);
        var removed = queue.isRemoved(id) && !(ownsMedia && id !== active.id);
        var currentSlot = removed && active && (node === active.context || node === active.card || ownsMedia);
        node.toggleAttribute("data-focusfeed-shorts-removed", removed);
        node.toggleAttribute("data-focusfeed-shorts-current", !!currentSlot);
        if (removed) options.pause(node);
      });
    }
    function directionFor(next) {
      if (!encountered.has(next.id)) encountered.set(next.id, encountered.size);
      if (explicitIntent) return direction;
      var renderers = Array.from(document.querySelectorAll("ytd-reel-video-renderer"));
      var previousSlot = lastAllowed && renderers.indexOf(lastAllowed.context), nextSlot = renderers.indexOf(next.context);
      if (previousSlot >= 0 && nextSlot >= 0 && previousSlot !== nextSlot) return nextSlot < previousSlot ? -1 : 1;
      var before = lastAllowed && encountered.get(lastAllowed.id), after = encountered.get(next.id);
      return before !== undefined && after !== undefined && before !== after ? after < before ? -1 : 1 : direction;
    }
    function navigationIntent(event) {
      var target = event.target;
      if (target && target.closest && target.closest('[data-focusfeed-ui], input, textarea, [contenteditable="true"]')) return;
      var next = event.type === "wheel" ? Math.sign(event.deltaY || 0) : event.type === "keydown" ?
        ["ArrowUp", "PageUp"].includes(event.key) ? -1 : ["ArrowDown", "PageDown"].includes(event.key) ? 1 : 0 :
          target && target.closest && target.closest('#navigation-button-up, button[aria-label="Previous video"]') ? -1 :
            target && target.closest && target.closest('#navigation-button-down, button[aria-label="Next video"]') ? 1 : 0;
      if (next) { direction = next; explicitIntent = true; }
    }
    document.addEventListener("wheel", navigationIntent, { capture: true, passive: true });
    document.addEventListener("keydown", navigationIntent, true);
    document.addEventListener("click", navigationIntent, true);
    function prepare() {
      cardPermits.forEach(function (entry, node) {
        var video = node.isConnected && options.extract && options.extract(entry.owner);
        if (!video || FocusFeedVideo.fingerprint(video) !== entry.token) { node.removeAttribute(ALLOWED); cardPermits.delete(node); }
      });
      if (!enabled || suspended || !onShorts()) { if (current) reset(); dismiss(); return; }
      queue.beginVisit();
      var currentVisit = queue.stats().visit;
      if (currentVisit !== visit) { visit = currentVisit; lastAllowed = null; encountered.clear(); direction = 1; explicitIntent = false; }
      restoreRecycledSlots();
      var next = snapshot();
      syncRemovedSlots(next);
      if (queue.isUpdating()) {
        reset();
        if (next) { current = Object.assign(next, { phase: "pending", advanced: false, attempts: 0, direction: direction }); options.pause(next.card); }
        message(updateError ? "Could not update Shorts. Try again." : "Updating Shorts…", updateError ? "settings" : false); return;
      }
      if (!same(current, next)) {
        reset();
        if (next) {
          current = Object.assign(next, { phase: "pending", advanced: false, attempts: 0, direction: directionFor(next) });
          queue.offer(next.id);
          var saved = queue.decision(next.video);
          if (saved) {
            if (saved.action === "show") { allow(); return; }
            queue.remove(next.id); syncRemovedSlots(next);
            current.phase = "rejected";
          }
          options.pause(next.card);
        }
        if (!current || current.phase === "pending") message("Preparing next Shorts…");
      }
      if (current && current.phase !== "allowed") options.pause(current.card);
      if (!navigating && current && current.phase === "rejected" && !current.advanced && (current.attempts < 3 || nativeNext() || followingRenderer(current))) queueAdvance(current);
    }
    function allow() {
      if (queue.isUpdating() || queue.isRemoved(current.id)) return;
      lastAllowed = { id: current.id, context: current.context };
      [current.card, current.context, current.card.closest("ytd-shorts"), current.context.closest("ytd-shorts"),
        current.card.querySelector("#shorts-player")].filter(Boolean).forEach(function (node) {
        if (!node.hasAttribute(ALLOWED)) node.setAttribute(ALLOWED, "true"); permitted.add(node);
      });
      current.phase = "allowed"; cancelSkip(); dismiss(); options.resume(current.card);
    }
    function usable(node) { return node && !node.closest('[hidden], [disabled], [aria-disabled="true"]') && node.getClientRects().length; }
    function nativeNext() {
      var backwards = current && current.direction < 0;
      var selector = backwards ? '#navigation-button-up button, button#navigation-button-up, #navigation-button-up yt-icon-button' : '#navigation-button-down button, button#navigation-button-down, #navigation-button-down yt-icon-button';
      var button = Array.from(document.querySelectorAll(selector)).find(usable);
      if (button) return button;
      // Captured layouts expose the action's accessible name without a stable ID.
      var host = current && (current.card.closest("ytd-shorts") || current.context.closest("ytd-shorts")) || document;
      return Array.from(host.querySelectorAll(backwards ? 'button[aria-label="Previous video"]' : 'button[aria-label="Next video"]')).find(usable);
    }
    function followingRenderer(record) {
      var renderers = Array.from(document.querySelectorAll("ytd-reel-video-renderer"));
      var index = renderers.indexOf(record.context), step = record.direction || 1;
      if (index < 0) return null;
      for (var i = index + step; i >= 0 && i < renderers.length; i += step) {
        var following = renderers[i];
        if (queue.isRemoved(following.getAttribute("video-id"))) continue;
        return following.scrollIntoView && !following.closest("[hidden]") ? following : null;
      }
      return null;
    }
    function preparedSuccessor(record) {
      var renderers = Array.from(document.querySelectorAll("ytd-reel-video-renderer")), index = renderers.indexOf(record.context);
      if (index < 0) return null;
      var step = record.direction || 1;
      for (var i = index + step; i >= 0 && i < renderers.length; i += step) {
        var candidate = renderers[i], id = candidate.getAttribute("video-id");
        if (queue.isRemoved(id)) continue;
        var video = options.lookup && options.lookup(id), saved = video && queue.decision(video);
        if (!saved) return null;
        if (saved.action === "show") return candidate.scrollIntoView && !candidate.closest("[hidden]") ? candidate : null;
      }
      return null;
    }
    function advance(record) {
      skipTimer = null;
      if (!enabled || suspended || navigating || queue.isUpdating() || document.hidden || current !== record || record.phase !== "rejected" || !same(record, snapshot())) return;
      record.attempts++;
      var prepared = preparedSuccessor(record), next = nativeNext();
      if (prepared) {
        record.advanced = true; prepared.scrollIntoView({ behavior: "instant", block: "start" });
      } else if (next) {
        record.advanced = true; next.click();
      } else {
        var following = followingRenderer(record);
        if (following) {
          record.advanced = true; following.scrollIntoView({ behavior: "instant", block: "start" });
        }
      }
      if (options.requestScan) options.requestScan();
      if (!record.advanced && record.attempts < 3) queueAdvance(record);
      else if (!record.advanced) message("Waiting for YouTube’s next Short…");
    }
    function queueAdvance(record) {
      if (!skipTimer) skipTimer = setTimeout(function () { advance(record); }, record.attempts ? 250 : 0);
    }
    function render(card, video, action, reason) {
      if (!enabled || suspended || !onShorts()) return false;
      if (!queue.isUpdating()) queue.remember(video, action, reason);
      prepare();
      if (!current || current.card !== card || current.id !== video.videoId) return false;
      if (queue.isUpdating()) return true;
      if (queue.isRemoved(video.videoId)) { action = "hide"; reason = "visit_removed"; }
      var checking = action === "pending" || REFRESH.includes(reason), failed = FAILED.includes(reason);
      if (!video.videoId && state.aiAccess !== false && root.FocusFeedSettings && FocusFeedSettings.valid(FocusFeedSettings.effective(state))) checking = true;
      if (action === "show" && !checking) { allow(); return true; }
      revoke(); options.pause(card);
      if (failed) { current.phase = "failed"; cancelSkip(); message("Could not check Shorts. Try again.", true); }
      else if (checking) { current.phase = "pending"; cancelSkip(); message("Preparing next Shorts…"); }
      else {
        current.phase = "rejected"; message(current.attempts >= 3 && !current.advanced ? "Waiting for YouTube’s next Short…" : "Finding the next Short…");
        if (!navigating && !current.advanced && (current.attempts < 3 || nativeNext() || followingRenderer(current))) queueAdvance(current);
      }
      return true;
    }
    var observer = new MutationObserver(function (mutations) {
      // Mutation observers run before paint; revoke reused-player approval without
      // waiting for the normal debounced content scan. Own UI changes are ignored.
      if (mutations.some(function (mutation) {
        var node = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        return node && !node.closest("[data-focusfeed-ui]") &&
          (node.closest("ytd-shorts, ytd-reel-video-renderer, #shorts-player") || mutation.type === "childList");
      })) prepare();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["video-id", "is-active", "src", "hidden", "title", "disabled", "aria-disabled"] });
    function configure(value, context) {
      var changed = !state || !value || state.revision !== value.revision;
      if (onShorts()) queue.beginVisit(); else { queue.endVisit(); lastAllowed = null; clearRemovedSlots(); }
      var profile = value && root.FocusFeedSettings && FocusFeedSettings.effective(value);
      var nextScope = value ? JSON.stringify([context && context.scope, context && context.localPolicy, value.enabled, value.hideShorts, value.aiAccess,
        profile && FocusFeedVideo.profileKey(profile), profile && profile.mode]) : "";
      changed = queue.commitPolicy(nextScope) || changed;
      state = value; enabled = !!(value && value.enabled && !value.hideShorts); suspended = false; navigating = false;
      updateError = "";
      document.documentElement.toggleAttribute(GATE, enabled);
      if (!enabled || changed) {
        reset(); cardPermits.forEach(function (_entry, node) { node.removeAttribute(ALLOWED); }); cardPermits.clear();
      }
      if (!enabled) { clearRemovedSlots(); dismiss(); } else prepare();
    }
    function remember(video, action, reason, freshness) {
      if (enabled) queue.remember(video, action, reason, freshness);
    }
    return { configure: configure, prepare: prepare, render: render, remember: remember,
      beginUpdate: function () {
        if (!onShorts()) return;
        updateError = ""; queue.beginUpdate(); reset();
        cardPermits.forEach(function (_entry, node) { node.removeAttribute(ALLOWED); }); cardPermits.clear();
        prepare();
      },
      updateFailed: function (error) { updateError = error && error.message || "Could not read saved settings"; cancelSkip(); revoke(); prepare(); },
      transition: function (start) { navigating = start; cancelSkip(); if (!start) prepare(); },
      card: function (card, video, action, reason) {
        var allowed = enabled && !queue.isUpdating() && !queue.isRemoved(video.videoId) && action === "show" && !REFRESH.includes(reason);
        [card].concat(Array.from(card.querySelectorAll(CARDS + ", yt-lockup-view-model"))).forEach(function (node) {
          if (allowed) {
            if (!node.hasAttribute(ALLOWED)) node.setAttribute(ALLOWED, "true");
            cardPermits.set(node, { owner: card, token: FocusFeedVideo.fingerprint(video) });
          } else { node.removeAttribute(ALLOWED); cardPermits.delete(node); }
        });
      }, active: function () { return enabled && !suspended && onShorts(); },
      blocked: function (media) {
        prepare();
        return !!(enabled && onShorts() && (!current || current.phase !== "allowed" || !same(current, snapshot())) && media.closest("ytd-reel-video-renderer, #shorts-player"));
      },
      suspend: function () { suspended = true; reset(); dismiss(); },
      stop: function () {
        observer.disconnect(); configure(null); queue.endVisit(); clearRemovedSlots(); document.documentElement.removeAttribute(GATE);
        document.removeEventListener("wheel", navigationIntent, true); document.removeEventListener("keydown", navigationIntent, true); document.removeEventListener("click", navigationIntent, true);
      } };
  }
  root.FocusFeedShortsFeed = { create: create };
})(globalThis);
