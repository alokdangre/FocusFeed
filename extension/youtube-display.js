// Reversible DOM-only display policy. No provider requests or player internals.
(function (root) {
  "use strict";
  var HIDDEN = "data-focusfeed-display-hidden";
  var SURFACES = {
    hideHomeFeed: 'ytd-browse[page-subtype="home"]',
    hideVideoSidebar: 'ytd-watch-flexy #secondary, ytd-watch-flexy #secondary-inner',
    hideRecommended: 'ytd-watch-flexy #related, ytd-watch-flexy ytd-watch-next-secondary-results-renderer',
    hideLiveChat: 'ytd-live-chat-frame, ytd-live-chat-renderer, ytd-live-chat-replay-renderer',
    hidePlaylist: 'ytd-playlist-panel-renderer',
    hideFundraiser: 'ytd-donation-shelf-renderer, ytd-fundraiser-renderer, ytd-donation-unavailable-renderer',
    hideEndScreenFeed: '.html5-endscreen, .ytp-endscreen-content',
    hideEndScreenCards: '.ytp-ce-element, .ytp-ce-covering-overlay',
    hideComments: 'ytd-comments, ytd-comments-entry-point-header-renderer, ytd-comment-teaser-renderer, #comments.ytd-watch-flexy',
    hideMerchTicketsOffers: 'ytd-merch-shelf-renderer, ytd-ticket-shelf-renderer, ytd-offer-module-renderer, ytd-shopping-carousel-renderer, ytd-product-details-renderer, ytd-shopping-overlay-renderer, ytd-commerce-player-renderer, ytd-video-description-infocards-section-renderer',
    hideVideoInfo: 'ytd-watch-metadata, ytd-watch-flexy #info-contents, ytd-watch-flexy #meta-contents',
    hideButtonsBar: 'ytd-watch-metadata #actions, ytd-watch-metadata #menu, ytd-watch-flexy #info #menu, ytd-watch-flexy #top-level-buttons-computed',
    hideChannel: 'ytd-watch-metadata #owner, ytd-watch-flexy #meta-contents #owner, ytd-watch-flexy ytd-video-owner-renderer',
    hideDescription: 'ytd-watch-metadata #description, ytd-watch-flexy #description-inline-expander, ytd-watch-flexy #meta-contents #description, ytd-watch-flexy ytd-structured-description-content-renderer',
    hideTopHeader: 'ytd-masthead, #masthead-container.ytd-app',
    hideNotifications: 'ytd-notification-topbar-button-renderer',
    hideInaptSearchResults: 'ytd-search ytd-shelf-renderer, ytd-search ytd-reel-shelf-renderer, ytd-search ytd-horizontal-card-list-renderer, ytd-search #secondary',
    disableAnnotations: '.annotation, .iv-branding, .iv-drawer, .ytp-cards-button, .ytp-cards-teaser, .ytp-cards-teaser-box'
  };
  var GUIDE_ITEM = 'ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer';
  var MIX_CARD = 'ytd-radio-renderer, ytd-compact-radio-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer, yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, a.ytp-videowall-still, a.ytp-modern-videowall-still, a.ytp-suggestion-link';
  var PARENTS = {};
  FocusFeedSettings.DISPLAY_OPTIONS.forEach(function (option) { if (option.parent) PARENTS[option.key] = option.parent; });
  function create() {
    var state = null, marked = new Set(), autoplayChanges = new Map();
    function mark(node, next) { if (node) next.add(node); }
    function guide(next) {
      if (!state.hideExploreTrending && !state.hideMoreFromYouTube && !state.hideSubscriptions) return;
      var exploreSections = new Set();
      document.querySelectorAll(GUIDE_ITEM).forEach(function (entry) {
        var link = entry.querySelector('a[href]');
        if (!link) return;
        var url; try { url = new URL(link.getAttribute("href"), location.origin); } catch (_) { return; }
        var path = url.pathname.replace(/\/$/, ""), local = url.hostname === location.hostname;
        var explore = state.hideExploreTrending && local && /^\/(feed\/(explore|trending)|gaming|podcasts|courses|playables|sports|news|learning|fashion|music)$/.test(path);
        var subscriptions = state.hideSubscriptions && local && /^\/feed\/(subscriptions|channels)$/.test(path);
        var services = state.hideMoreFromYouTube && (local && /^\/(premium|kids)$/.test(path) ||
          /^(music|studio|tv|kids)\.youtube\.com$/.test(url.hostname) || /^(www\.)?youtubekids\.com$/.test(url.hostname));
        if (explore || subscriptions || services) mark(entry, next);
        if (explore) mark(entry.closest('ytd-guide-section-renderer'), exploreSections);
        if (subscriptions) mark(entry.closest('ytd-guide-collapsible-section-entry-renderer'), next);
      });
      document.querySelectorAll('ytd-guide-section-renderer').forEach(function (section) {
        // Never remove the primary Home/Library section along with a guide link.
        if (section.querySelector('a[href="/"], a[href="/feed/history"], a[href="/feed/you"]')) return;
        var links = Array.from(section.querySelectorAll(GUIDE_ITEM));
        if (links.length && links.every(function (entry) { return next.has(entry); })) mark(section, next);
        else if (state.hideSubscriptions && section.querySelector('a[href="/feed/channels"], a[href="/feed/subscriptions"]')) mark(section, next);
        else if (exploreSections.has(section) && section.querySelector('#guide-section-title')) mark(section, next);
      });
    }
    function mixes(next) {
      if (!state.hideMixes) return;
      document.querySelectorAll(MIX_CARD).forEach(function (card) {
        var isMix = card.matches('ytd-radio-renderer, ytd-compact-radio-renderer');
        var collection = card.matches('ytd-playlist-renderer, ytd-compact-playlist-renderer') ||
          card.querySelector('yt-collection-thumbnail-view-model, yt-collections-stack, .ytp-videowall-still-listlabel, .ytp-modern-videowall-still-listlabel, .ytp-suggestion-playlist');
        var links = card.matches('a[href]') ? [card] : Array.from(card.querySelectorAll('a[href]'));
        isMix = isMix || links.some(function (link) {
          try {
            var url = new URL(link.getAttribute("href"), location.origin);
            return /^RD/.test(url.searchParams.get("list") || "") &&
              (collection || url.pathname === "/playlist" || url.searchParams.get("start_radio") === "1");
          }
          catch (_) { return false; }
        });
        if (isMix) mark(card.closest('ytd-rich-item-renderer') || card, next);
      });
    }
    function autoplaySwitch(button) {
      return button.hasAttribute("aria-checked") ? button : button.querySelector('[aria-checked]');
    }
    function autoplay() {
      var disable = state && state.enabled && state.disableAutoplay;
      autoplayChanges.forEach(function (toggle, button) {
        if (!button.isConnected) { autoplayChanges.delete(button); return; }
        if (!disable) {
          if (toggle.getAttribute("aria-checked") === "false") button.click();
          autoplayChanges.delete(button);
        }
      });
      if (!disable) return;
      document.querySelectorAll('.ytp-autonav-toggle-button, button.ytp-autonav-toggle, .ytp-autonav-toggle[role="switch"]').forEach(function (button) {
        if (button.parentElement && button.parentElement.closest('.ytp-autonav-toggle-button')) return;
        var toggle = autoplaySwitch(button);
        if (toggle && toggle.getAttribute("aria-checked") === "true") {
          button.click();
          if (toggle.getAttribute("aria-checked") === "false") autoplayChanges.set(button, toggle);
        }
      });
    }
    function scan() {
      var next = new Set();
      if (state && state.enabled) {
        Object.keys(SURFACES).forEach(function (key) {
          if (state[key] || PARENTS[key] && state[PARENTS[key]]) document.querySelectorAll(SURFACES[key]).forEach(function (node) { mark(node, next); });
        });
        guide(next); mixes(next);
      }
      marked.forEach(function (node) { if (!next.has(node)) node.removeAttribute(HIDDEN); });
      next.forEach(function (node) { if (!node.hasAttribute(HIDDEN)) node.setAttribute(HIDDEN, "true"); });
      marked = next;
      document.documentElement.toggleAttribute("data-focusfeed-hide-header", !!(state && state.enabled && state.hideTopHeader));
      autoplay();
    }
    function clear() { state = null; scan(); }
    return { configure: function (value) { state = value; scan(); }, scan: scan, clear: clear,
      hides: function (node) { return !!node.closest('[' + HIDDEN + ']'); } };
  }
  root.FocusFeedYouTubeDisplay = { create: create };
})(globalThis);
