// Temporary loading states over native cards. Never reconstruct settled YouTube UI.
(function (root) {
  "use strict";
  var THUMB = ".ytLockupViewModelContentImage, ytd-thumbnail, #thumbnail, .ytp-videowall-still-image, .ytp-modern-videowall-still-image, .ytp-suggestion-image, .ytp-autonav-endscreen-upnext-thumbnail";
  function create() {
    var pending = new Map(), statuses = new Map(), thumbnails = new Map(), thumbnailCards = new WeakMap(), frame = null, progress = null, showTimer = null, activity = { pending: 0 };
    function shape(className, box, cardBox, fallback) {
      var node = document.createElement("span"); node.className = "focusfeed-loading-shape " + className;
      var rect = box && box.width > 0 && box.height > 0 ? box : fallback;
      node.style.left = (100 * Math.max(0, rect.left - cardBox.left) / cardBox.width) + "%";
      node.style.top = (100 * Math.max(0, rect.top - cardBox.top) / cardBox.height) + "%";
      node.style.width = (100 * Math.max(0, Math.min(rect.width, cardBox.width - Math.max(0, rect.left - cardBox.left))) / cardBox.width) + "%";
      node.style.height = (100 * Math.max(0, Math.min(rect.height, cardBox.height - Math.max(0, rect.top - cardBox.top))) / cardBox.height) + "%";
      return node;
    }
    function rect(node) {
      if (!node) return null;
      var r = node.getBoundingClientRect();
      return { left: r.left === undefined ? r.x || 0 : r.left, top: r.top || 0, width: r.width || 0, height: r.height || 0, bottom: r.bottom || 0 };
    }
    function measure(card) {
      var box = rect(card);
      if (!box || box.width <= 0 || box.height <= 0 || box.bottom < -200 || box.top > (root.innerHeight || 900) + 600) return null;
      var thumbNode = card.querySelector(THUMB), image = thumbNode && thumbNode.querySelector("img");
      var thumb = rect(image), wrapper = rect(thumbNode), title = rect(card.querySelector("h3, #video-title-link, #video-title, .ytp-videowall-still-info-title, .ytp-modern-videowall-still-info-title, .ytp-suggestion-title, .ytp-autonav-endscreen-upnext-title"));
      // YouTube's image link can include padding below the actual image.
      if (!thumb || !thumb.width || !thumb.height) {
        thumb = wrapper;
        if (thumb && thumb.height <= thumb.width) thumb = Object.assign({}, thumb, { height: Math.min(thumb.height, thumb.width * 9 / 16) });
      }
      var metadata = rect(card.querySelector("yt-content-metadata-view-model, #metadata-line, #channel-name, #byline, ytd-channel-name, .ytp-videowall-still-info-author, .ytp-modern-videowall-still-info-author, .ytp-suggestion-author, .ytp-autonav-endscreen-upnext-author"));
      var avatar = rect(card.querySelector(".ytSpecAvatarShapeHost img, #avatar-link img, #avatar img"));
      if (!avatar || !avatar.width || !avatar.height) avatar = rect(card.querySelector(".ytSpecAvatarShapeHost"));
      if (!avatar || !avatar.width || !avatar.height) avatar = rect(card.querySelector(".ytLockupMetadataViewModelAvatar, #avatar-link, #avatar"));
      if (avatar && avatar.width && avatar.height) {
        var diameter = Math.min(avatar.width, avatar.height, 40);
        avatar = Object.assign({}, avatar, { width: diameter, height: diameter });
      }
      var width = box.width, imageHeight = Math.min(width * .5625, box.height * .74);
      var fallbackThumb = { left: box.left, top: box.top, width: width, height: imageHeight };
      var textLeft = avatar && avatar.width ? avatar.left + avatar.width + 12 : box.left;
      var textTop = thumb && thumb.width ? thumb.top + thumb.height + 14 : box.top + imageHeight + 14;
      var titleFallback = { left: textLeft, top: textTop, width: width * .78, height: 14 };
      var metaFallback = { left: textLeft, top: textTop + 26, width: width * .55, height: 11 };
      var imageBox = thumb && thumb.width && thumb.height ? thumb : fallbackThumb;
      var titleBox = title && title.width && title.height ? title : titleFallback;
      var metaBox = metadata && metadata.width && metadata.height ? metadata : metaFallback;
      var belowImage = titleBox.left < imageBox.left + imageBox.width && titleBox.top >= imageBox.top + imageBox.height - 2;
      // Reserve the native separation even when a text wrapper overlaps its image link.
      if (belowImage) {
        var minimumTop = imageBox.top + imageBox.height + 12;
        titleBox = Object.assign({}, titleBox, { top: Math.max(titleBox.top, minimumTop) });
        if (avatar) avatar = Object.assign({}, avatar, { top: Math.max(avatar.top, minimumTop) });
      }
      return { box: box, thumb: imageBox, title: titleBox,
        meta: metaBox, avatar: avatar, fallbackThumb: fallbackThumb, titleFallback: titleFallback, metaFallback: metaFallback };
    }
    function refresh() {
      frame = null;
      statuses.forEach(function (state, card) {
        if (!card.isConnected) { removeStatus(card); return; }
        positionStatus(card, state);
      });
      thumbnails.forEach(function (_state, img) { if (!img.isConnected) removeThumbnail(img); });
      var updates = [];
      pending.forEach(function (state, card) {
        if (!card.isConnected) { remove(card); return; }
        var layout = measure(card);
        if (layout) updates.push({ card: card, state: state, layout: layout });
      });
      // Batch geometry reads before adding overlays, avoiding a read/write loop.
      updates.forEach(function (update) {
        var state = update.state, layout = update.layout;
        function relative(r) { return r && [r.left - layout.box.left, r.top - layout.box.top, r.width, r.height]; }
        var signature = JSON.stringify([layout.box.width, layout.box.height, relative(layout.thumb), relative(layout.title), relative(layout.meta), relative(layout.avatar)]);
        if (state.node && state.node.isConnected && state.signature === signature) return;
        if (state.node) state.node.remove();
        var overlay = document.createElement("div"); overlay.className = "focusfeed-card-loading";
        overlay.dataset.focusfeedUi = "card-loading"; overlay.setAttribute("aria-hidden", "true");
        var timeline = root.performance && root.performance.now ? root.performance.now() : Date.now();
        overlay.style.animationDelay = -(Math.round(timeline % 1800)) + "ms";
        overlay.appendChild(shape("focusfeed-loading-image", layout.thumb, layout.box, layout.fallbackThumb));
        if (layout.avatar && layout.avatar.width) overlay.appendChild(shape("focusfeed-loading-avatar", layout.avatar, layout.box, layout.avatar));
        var title = Object.assign({}, layout.title, { top: layout.title.top + 3, height: Math.min(layout.title.height, 12), width: layout.title.width * .82 });
        var meta = Object.assign({}, layout.meta, { top: layout.meta.top + 3, height: Math.min(layout.meta.height, 9), width: layout.meta.width * .58 });
        overlay.appendChild(shape("focusfeed-loading-line", title, layout.box, layout.titleFallback));
        if (layout.title.height >= 32) overlay.appendChild(shape("focusfeed-loading-line", Object.assign({}, title, { top: title.top + 20, width: title.width * .74 }), layout.box, layout.titleFallback));
        overlay.appendChild(shape("focusfeed-loading-line", meta, layout.box, layout.metaFallback));
        if (layout.meta.height >= 32) overlay.appendChild(shape("focusfeed-loading-line", Object.assign({}, meta, { top: meta.top + 16, width: meta.width * .72, height: 8 }), layout.box, layout.metaFallback));
        update.card.appendChild(overlay); state.node = overlay; state.signature = signature;
      });
    }
    function schedule() {
      if (frame !== null) return;
      frame = root.requestAnimationFrame ? root.requestAnimationFrame(refresh) : setTimeout(refresh, 0);
    }
    function remove(card) {
      var state = pending.get(card);
      if (!state) return;
      if (state.node) state.node.remove();
      if (state.busy === null) card.removeAttribute("aria-busy"); else card.setAttribute("aria-busy", state.busy);
      card.inert = state.inert;
      pending.delete(card);
    }
    function watchThumbnail(card) {
      var thumb = card.querySelector(THUMB), img = thumb && thumb.querySelector("img");
      var previousImage = thumbnailCards.get(card);
      if (previousImage && previousImage !== img) removeThumbnail(previousImage);
      if (!img || img.complete !== false || !img.getAttribute("src")) { if (img) removeThumbnail(img); return; }
      // Bound the placeholder to the actual image, never the link's bottom
      // padding. The native link keeps its own size, overflow and positioning.
      var anchor = thumb;
      if (root.getComputedStyle && root.getComputedStyle(thumb).position === "static") anchor = thumb.offsetParent || document.documentElement;
      var box = rect(anchor), imageBox = rect(img), wrapper = rect(thumb);
      if (!box || !box.width || !box.height || !wrapper) return;
      if (!imageBox || !imageBox.width || !imageBox.height) imageBox = Object.assign({}, wrapper, {
        height: wrapper.height > wrapper.width ? wrapper.height : Math.min(wrapper.height, wrapper.width * 9 / 16)
      });
      var state = thumbnails.get(img);
      if (state && (state.thumb !== thumb || !state.node.isConnected)) { removeThumbnail(img); state = null; }
      if (!state) {
        var node = document.createElement("span"); node.className = "focusfeed-thumbnail-loading";
        node.dataset.focusfeedUi = "thumbnail-loading"; node.setAttribute("aria-hidden", "true");
        state = { card: card, thumb: thumb, node: node }; thumbnails.set(img, state); thumbnailCards.set(card, img); thumb.appendChild(node); schedule();
      }
      var bounds = [imageBox.left - box.left, imageBox.top - box.top, imageBox.width, imageBox.height];
      var signature = JSON.stringify([box.width, box.height, bounds]);
      if (signature !== state.signature) {
        state.node.style.left = (bounds[0] / box.width * 100) + "%";
        state.node.style.top = (bounds[1] / box.height * 100) + "%";
        state.node.style.width = (bounds[2] / box.width * 100) + "%";
        state.node.style.height = (bounds[3] / box.height * 100) + "%";
        state.signature = signature;
      }
      if (thumb.dataset.focusfeedThumbnailLoading !== "true") thumb.dataset.focusfeedThumbnailLoading = "true";
    }
    function removeThumbnail(img) {
      var state = thumbnails.get(img);
      if (!state) return;
      state.node.remove(); state.thumb.removeAttribute("data-focusfeed-thumbnail-loading"); thumbnails.delete(img);
      if (thumbnailCards.get(state.card) === img) thumbnailCards.delete(state.card);
    }
    function imageFinished(event) {
      removeThumbnail(event.target);
      if (pending.size) schedule();
    }
    function removeStatus(card) {
      var state = statuses.get(card);
      if (!state) return;
      state.node.remove();
      state.children.forEach(function (inert, child) { child.inert = inert; });
      card.inert = state.inert;
      if (state.busy === null) card.removeAttribute("aria-busy"); else card.setAttribute("aria-busy", state.busy);
      card.removeAttribute("data-focusfeed-refreshing");
      card.removeAttribute("data-focusfeed-check-status");
      card.removeEventListener("click", state.block, true);
      card.removeEventListener("auxclick", state.block, true);
      card.removeEventListener("keydown", state.block, true);
      statuses.delete(card);
    }
    function positionStatus(card, state) {
      var layout = measure(card);
      if (!layout) return;
      var thumb = layout.thumb;
      var bounds = [Math.max(0, thumb.left - layout.box.left), Math.max(0, thumb.top - layout.box.top), thumb.width, thumb.height];
      var signature = JSON.stringify([layout.box.width, layout.box.height, bounds]);
      if (state.signature === signature) return;
      state.signature = signature;
      state.node.style.left = (bounds[0] / layout.box.width * 100) + "%";
      state.node.style.top = (bounds[1] / layout.box.height * 100) + "%";
      state.node.style.width = (bounds[2] / layout.box.width * 100) + "%";
      state.node.style.height = (bounds[3] / layout.box.height * 100) + "%";
    }
    function checkStatus(card, mode, retry) {
      var state = statuses.get(card);
      if (!state) {
        var node = document.createElement("div"); node.className = "focusfeed-card-status";
        node.dataset.focusfeedUi = "check-status";
        var pill = document.createElement("div"); pill.className = "focusfeed-status-pill";
        var mark = document.createElement("span"); mark.className = "focusfeed-status-mark"; mark.setAttribute("aria-hidden", "true");
        var label = document.createElement("span"); label.className = "focusfeed-status-label";
        pill.append(mark, label); node.appendChild(pill);
        state = { node: node, label: label, pill: pill, mode: mode, children: new Map(),
          busy: card.getAttribute("aria-busy"), inert: !!card.inert };
        state.block = function (event) {
          if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
          if (state.button && state.button.contains(event.target)) return;
          event.preventDefault(); event.stopImmediatePropagation();
        };
        card.addEventListener("click", state.block, true);
        card.addEventListener("auxclick", state.block, true);
        card.addEventListener("keydown", state.block, true);
        statuses.set(card, state); card.appendChild(node);
        if (mode === "failed") {
          var button = document.createElement("button"); button.type = "button"; button.className = "focusfeed-status-retry";
          button.textContent = "Retry"; button.setAttribute("aria-label", "Retry checking this recommendation");
          button.addEventListener("click", function (event) {
            event.preventDefault(); event.stopPropagation();
            if (statuses.get(card) !== state || !state.retry || button.disabled) return;
            button.disabled = true;
            try { if (state.retry() === false) button.disabled = false; } catch (_) { button.disabled = false; }
          });
          state.button = button; pill.appendChild(button);
        }
      }
      state.retry = retry;
      var text = mode === "failed" ? "Couldn’t check" : mode === "retrying" ? "Retrying check…" : "Updating filters…";
      if (state.label.textContent !== text) state.label.textContent = text;
      card.dataset.focusfeedCheckStatus = mode;
      if (mode !== "failed" && !pending.has(card)) card.dataset.focusfeedRefreshing = "true";
      // Keep the status and Retry accessible while preventing native card navigation.
      card.inert = pending.has(card) ? pending.get(card).inert : state.inert;
      Array.from(card.children).forEach(function (child) {
        if (child === state.node || child.classList.contains("focusfeed-card-loading")) return;
        if (!state.children.has(child)) state.children.set(child, !!child.inert);
        child.inert = true;
      });
      card.setAttribute("aria-busy", mode === "failed" ? "false" : "true");
      positionStatus(card, state);
    }
    function render(card, action, reason, retry) {
      var mode = action === "hide" ? null : ["refresh_failed", "check_failed"].includes(reason) ? "failed" :
        ["refresh_retrying", "check_retrying"].includes(reason) ? "retrying" :
        action === "show" && ["refreshing", "channel_pending"].includes(reason) ? "updating" : null;
      var old = statuses.get(card);
      if (old && old.mode !== mode) removeStatus(card);
      if (action !== "show") { var image = thumbnailCards.get(card); if (image) removeThumbnail(image); }
      if (action === "pending") {
        if (!pending.has(card)) {
          card.removeAttribute("data-focusfeed-reveal");
          pending.set(card, { busy: card.getAttribute("aria-busy"), inert: !!card.inert, node: null });
          card.setAttribute("aria-busy", "true"); card.inert = true;
        }
        schedule();
      } else {
        var wasPending = pending.has(card);
        remove(card);
        if (action === "show") {
          if (wasPending) card.dataset.focusfeedReveal = "true";
          watchThumbnail(card);
        }
      }
      if (mode) checkStatus(card, mode, retry);
    }
    function updateProgress() {
      showTimer = null;
      if (!activity.pending) return;
      if (!progress) {
        progress = document.createElement("div"); progress.className = "focusfeed-feed-progress";
        progress.dataset.focusfeedUi = "feed-progress"; progress.setAttribute("role", "status"); progress.setAttribute("aria-live", "polite");
        var mark = document.createElement("span"); mark.className = "focusfeed-progress-mark"; mark.setAttribute("aria-hidden", "true");
        var label = document.createElement("span"); label.className = "focusfeed-progress-label";
        progress.append(mark, label); (document.body || document.documentElement).appendChild(progress);
      }
      var text = activity.refreshing ? "Updating your recommendations…" : "Checking recommendations…";
      var label = progress.querySelector(".focusfeed-progress-label");
      if (label.textContent !== text) label.textContent = text;
    }
    function setActivity(value) {
      activity = value;
      if (!value.pending) { clearTimeout(showTimer); showTimer = null; if (progress) progress.remove(); progress = null; }
      else if (progress) updateProgress();
      else if (!showTimer) showTimer = setTimeout(updateProgress, 180);
    }
    function clear() {
      clearTimeout(showTimer); showTimer = null;
      if (frame !== null) { if (root.cancelAnimationFrame) root.cancelAnimationFrame(frame); else clearTimeout(frame); frame = null; }
      Array.from(statuses.keys()).forEach(removeStatus);
      Array.from(pending.keys()).forEach(remove);
      Array.from(thumbnails.keys()).forEach(removeThumbnail);
      document.querySelectorAll("[data-focusfeed-reveal]").forEach(function (card) { card.removeAttribute("data-focusfeed-reveal"); });
      if (progress) progress.remove(); progress = null; activity = { pending: 0 };
    }
    document.addEventListener("load", imageFinished, true); document.addEventListener("error", imageFinished, true);
    window.addEventListener("resize", schedule);
    return { render: render, activity: setActivity, clear: clear, stop: function () {
      clear(); document.removeEventListener("load", imageFinished, true); document.removeEventListener("error", imageFinished, true); window.removeEventListener("resize", schedule);
    } };
  }
  root.FocusFeedLoadingUI = { create: create };
})(globalThis);
