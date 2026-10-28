// Hover media is separate from the Watch/Shorts player, and may live outside its card.
(function (root) {
  "use strict";
  var PREVIEWS = "#inline-preview-player, #video-preview, #video-preview-container, ytd-video-preview, ytd-moving-thumbnail-renderer";
  var CARDS = "ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer";
  function create() {
    var enabled = false;
    function isPreview(media) {
      return !!media.closest(PREVIEWS + ", " + CARDS);
    }
    function pause(media) {
      if (!enabled || !isPreview(media)) return;
      if (!media.paused) media.pause();
      // Pause media without hiding YouTube's thumbnail/overlay container.
      if (media.dataset.focusfeedPreviewSuppressed !== "true") media.dataset.focusfeedPreviewSuppressed = "true";
    }
    function sweep() {
      if (enabled) document.querySelectorAll("video").forEach(pause);
    }
    function onPlay(event) { if (event.target && event.target.tagName === "VIDEO") pause(event.target); }
    document.addEventListener("play", onPlay, true);
    document.addEventListener("playing", onPlay, true);
    function configure(value) {
      enabled = value === true;
      if (enabled) sweep();
      else document.querySelectorAll("[data-focusfeed-preview-suppressed]").forEach(function (node) { node.removeAttribute("data-focusfeed-preview-suppressed"); });
    }
    return { configure: configure, sweep: sweep, stop: function () {
      configure(false); document.removeEventListener("play", onPlay, true); document.removeEventListener("playing", onPlay, true);
    } };
  }
  root.FocusFeedPreviewController = { create: create };
})(globalThis);
