// content.js — FocusFeed content script, runs in ISOLATED world (has chrome.* APIs)
// Receives intercepted feed data, collects card metadata, and hosts live decisions.

(function () {
  "use strict";
  if (globalThis.__focusFeedContentInstalled) return;

  // --- State ---
  var feedItemsReceived = 0;
  var enabled = true;
  var activeProfile = null;
  var focusSession = null;
  var liveFeed = null;
  var PREFERENCE_KEYS = {
    enabled: true,
    activeProfile: true,
    focusSession: true,
    classifierProvider: true,
    classifierEndpoint: true,
  };

  // --- Load preferences ---
  function loadPreferences() {
    return chrome.storage.local.get({
      enabled: true,
      activeProfile: null,
      focusSession: null,
    }).then(function (prefs) {
      enabled = prefs.enabled;
      activeProfile = prefs.activeProfile || null;
      focusSession = prefs.focusSession || null;
    });
  }

  // Reload preferences when they change
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== "local") return;
    var shouldReload = Object.keys(changes || {}).some(function (key) {
      return PREFERENCE_KEYS[key] === true;
    });
    if (!shouldReload) return;
    if (liveFeed) liveFeed.preferencesChanged();
    loadPreferences().then(function () {
      reprocessAllCards();
    });
  });

  // --- Extract video data from YouTube API response ---
  function extractVideoRenderers(obj, results) {
    if (!results) results = [];
    if (!obj || typeof obj !== "object") return results;

    if (obj.videoRenderer) {
      var vr = obj.videoRenderer;
      var isLive = false;
      var isPremiere = false;
      var badgeList = (vr.badges || []).concat(vr.ownerBadges || []);
      for (var b = 0; b < badgeList.length; b++) {
        var bStyle = badgeList[b].metadataBadgeRenderer &&
                     badgeList[b].metadataBadgeRenderer.style || "";
        if (badgeList[b].liveBadgeRenderer || bStyle.indexOf("LIVE") !== -1) {
          isLive = true;
        }
      }
      if (vr.upcomingEventData) isPremiere = true;
      results.push({
        videoId: vr.videoId || "",
        title: extractText(vr.title),
        channel: extractText(vr.ownerText || vr.longBylineText || vr.shortBylineText),
        channelId: extractChannelIdentity(vr.ownerText || vr.longBylineText || vr.shortBylineText),
        description: extractDescription(vr),
        duration: extractText(vr.lengthText),
        // A missing duration is unknown, not proof that this is a Short.
        isShort: false,
        isLive: isLive,
        isPremiere: isPremiere,
      });
    }

    if (obj.compactVideoRenderer) {
      var cvr = obj.compactVideoRenderer;
      var cIsLive = !!(cvr.badges && cvr.badges.some &&
        cvr.badges.some(function(b) { return b.liveBadgeRenderer; }));
      results.push({
        videoId: cvr.videoId || "",
        title: extractText(cvr.title),
        channel: extractText(cvr.longBylineText || cvr.shortBylineText || cvr.ownerText),
        channelId: extractChannelIdentity(cvr.longBylineText || cvr.shortBylineText || cvr.ownerText),
        description: extractDescription(cvr),
        duration: extractText(cvr.lengthText),
        // Compact cards without duration can be live/upcoming; do not infer Shorts.
        isShort: false,
        isLive: cIsLive,
        isPremiere: false,
      });
    }

    if (obj.playlistVideoRenderer) {
      var pvr = obj.playlistVideoRenderer;
      results.push({
        videoId: pvr.videoId || "",
        title: extractText(pvr.title),
        channel: extractText(pvr.longBylineText || pvr.shortBylineText),
        channelId: extractChannelIdentity(pvr.longBylineText || pvr.shortBylineText),
        description: extractDescription(pvr),
        duration: extractText(pvr.lengthText),
        isShort: false,
        isLive: false,
        isPremiere: false,
      });
    }

    if (obj.reelItemRenderer) {
      var rr = obj.reelItemRenderer;
      results.push({
        videoId: rr.videoId || "",
        title: extractText(rr.headline),
        channel: extractText(rr.ownerText),
        channelId: extractChannelIdentity(rr.ownerText),
        description: extractDescription(rr),
        duration: "",
        isShort: true,
        isLive: false,
        isPremiere: false,
      });
    }

    if (obj.reelShelfRenderer) {
      var shelf = obj.reelShelfRenderer;
      var items = shelf.items || [];
      for (var s = 0; s < items.length; s++) {
        if (items[s].reelItemRenderer) {
          var ri = items[s].reelItemRenderer;
          results.push({
            videoId: ri.videoId || "",
            title: extractText(ri.headline),
            channel: extractText(ri.ownerText),
            channelId: extractChannelIdentity(ri.ownerText),
            description: extractDescription(ri),
            duration: "",
            isShort: true,
            isLive: false,
            isPremiere: false,
          });
        }
      }
    }

    if (obj.shortsLockupViewModel) {
      var slvm = obj.shortsLockupViewModel;
      results.push({
        videoId: (slvm.onTap && slvm.onTap.innertubeCommand &&
                  slvm.onTap.innertubeCommand.reelWatchEndpoint &&
                  slvm.onTap.innertubeCommand.reelWatchEndpoint.videoId) || "",
        title: (slvm.overlayMetadata && slvm.overlayMetadata.primaryText &&
                slvm.overlayMetadata.primaryText.content) || "",
        channel: "",
        channelId: "",
        description: extractDescription(slvm),
        duration: "",
        isShort: true,
        isLive: false,
        isPremiere: false,
      });
    }

    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === "videoRenderer" || key === "compactVideoRenderer" ||
          key === "playlistVideoRenderer" || key === "reelItemRenderer" ||
          key === "reelShelfRenderer" || key === "shortsLockupViewModel") {
        continue;
      }
      var val = obj[key];
      if (Array.isArray(val)) {
        for (var j = 0; j < val.length; j++) {
          extractVideoRenderers(val[j], results);
        }
      } else if (typeof val === "object" && val !== null) {
        extractVideoRenderers(val, results);
      }
    }

    return results;
  }

  function extractText(textObj) {
    if (!textObj) return "";
    if (typeof textObj === "string") return textObj;
    if (textObj.simpleText) return textObj.simpleText;
    if (textObj.content) return textObj.content;
    if (textObj.runs) {
      return textObj.runs.map(function (r) { return r.text; }).join("");
    }
    return "";
  }

  function normalizeChannelIdentity(value) {
    var text = String(value || "").trim();
    var channelPath = text.match(/^\/?channel\/([^/?#]+)/i);
    if (channelPath) return channelPath[1];
    var handlePath = text.match(/^\/?(@[^/?#]+)/);
    if (handlePath) return handlePath[1].toLowerCase();
    if (/^UC[A-Za-z0-9_-]{10,}$/.test(text)) return text;
    if (/^@[A-Za-z0-9._-]+$/.test(text)) return text.toLowerCase();
    return "";
  }

  function extractChannelIdentity(textObj) {
    var runs = textObj && Array.isArray(textObj.runs) ? textObj.runs : [];
    for (var index = 0; index < runs.length; index++) {
      var endpoint = runs[index] && runs[index].navigationEndpoint || {};
      var browse = endpoint.browseEndpoint || {};
      var identity = normalizeChannelIdentity(browse.browseId || browse.canonicalBaseUrl || "");
      if (identity) return identity;
      var command = endpoint.commandMetadata && endpoint.commandMetadata.webCommandMetadata || {};
      identity = normalizeChannelIdentity(command.url || "");
      if (identity) return identity;
    }
    return "";
  }

  function extractDescription(renderer) {
    if (!renderer) return "";
    var direct = extractText(renderer.descriptionSnippet || renderer.snippetText);
    if (direct) return direct;
    var snippets = Array.isArray(renderer.detailedMetadataSnippets)
      ? renderer.detailedMetadataSnippets : [];
    for (var index = 0; index < snippets.length; index++) {
      var text = extractText(snippets[index] && (
        snippets[index].snippetText || snippets[index].descriptionSnippet
      ));
      if (text) return text;
    }
    return "";
  }

  // --- Build a lookup map from intercepted data ---
  var videoDataMap = {};

  function processInterceptedData(data) {
    var videos = extractVideoRenderers(data);
    feedItemsReceived += videos.length;

    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (video.videoId) {
        var previous = videoDataMap[video.videoId] || {};
        videoDataMap[video.videoId] = Object.assign({}, previous, video, {
          title: video.title || previous.title || "",
          channel: video.channel || previous.channel || "",
          channelId: video.channelId || previous.channelId || "",
          description: video.description || previous.description || "",
          duration: video.duration || previous.duration || "",
          isShort: video.isShort === true || previous.isShort === true,
          isLive: video.isLive === true || previous.isLive === true,
          isPremiere: video.isPremiere === true || previous.isPremiere === true,
        });
      }
    }

    console.log(
      "[FocusFeed] Processed " + videos.length + " videos from API. " +
      "Total tracked: " + Object.keys(videoDataMap).length
    );

    scanCards();
    updateBadge();
  }

  // --- DOM manipulation ---
  var CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "yt-lockup-view-model",
    "ytd-compact-video-renderer",
    "ytd-video-renderer",
    "ytd-reel-item-renderer",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2",
    "ytd-radio-renderer",
    "ytd-playlist-renderer",
    "ytd-compact-radio-renderer",
    "ytd-compact-playlist-renderer",
  ].join(", ");

  function getVideoIdFromCard(card) {
    var contentDiv = card.querySelector("[class*='content-id-']") || card;
    var classList = contentDiv.className || "";
    var classMatch = classList.match(/content-id-([a-zA-Z0-9_-]+)/);
    if (classMatch) return classMatch[1];

    var link =
      card.querySelector("a#video-title-link") ||
      card.querySelector("a#video-title") ||
      card.querySelector('a[href*="/watch?v="]') ||
      card.querySelector('a[href*="/shorts/"]') ||
      card.querySelector("a[href*='/playlist']");
    if (!link) return null;

    var href = link.getAttribute("href") || "";
    var match = href.match(/[?&]v=([^&]+)/) || href.match(/\/shorts\/([^?&/]+)/);
    return match ? match[1] : null;
  }

  function extractTitleFromCard(card) {
    var el =
      card.querySelector("#video-title") ||
      card.querySelector("a#video-title-link") ||
      card.querySelector("h3 a") ||
      card.querySelector("h3") ||
      card.querySelector("span#video-title");

    if (el) {
      var title = (
        el.getAttribute("title") ||
        el.innerText ||
        el.textContent ||
        ""
      ).trim();
      if (title) return title;
    }

    var titled = card.querySelector("a[title]");
    if (titled) {
      var t = (titled.getAttribute("title") || "").trim();
      if (t) return t;
    }

    var labeled = card.querySelector("a[aria-label]");
    if (labeled) {
      return (labeled.getAttribute("aria-label") || "").trim();
    }

    return "";
  }

  function extractChannelFromCard(card) {
    var channelLink = card.querySelector('a[href*="/@"]');
    if (channelLink) {
      var text = (channelLink.innerText || channelLink.textContent || "").trim();
      if (text) return text;
    }

    var el =
      card.querySelector("ytd-channel-name a") ||
      card.querySelector("ytd-channel-name yt-formatted-string") ||
      card.querySelector("#channel-name a") ||
      card.querySelector("#channel-name") ||
      card.querySelector("#byline a") ||
      card.querySelector("#byline");

    if (!el) return "";
    return (el.innerText || el.textContent || "").trim();
  }

  function extractChannelIdentityFromCard(card) {
    var link = card.querySelector('a[href*="/channel/"]') || card.querySelector('a[href*="/@"]');
    if (!link) return "";
    return normalizeChannelIdentity(link.getAttribute("href") || "");
  }

  function extractDurationFromCard(card) {
    // Duration text is in the time-status overlay on the thumbnail
    var el = card.querySelector(
      "ytd-thumbnail-overlay-time-status-renderer span.ytd-thumbnail-overlay-time-status-renderer, " +
      "ytd-thumbnail-overlay-time-status-renderer #text, " +
      "span.ytp-time-duration, " +
      "badge-shape[type='video-length'] span"
    );
    return el ? (el.innerText || el.textContent || "").trim() : "";
  }

  function extractDescriptionFromCard(card) {
    var element = card.querySelector("#description-text") ||
      card.querySelector("yt-formatted-string.metadata-snippet-text") ||
      card.querySelector(".metadata-snippet-text") ||
      card.querySelector("[class*='description-snippet']");
    return element ? (element.innerText || element.textContent || "").trim() : "";
  }

  function removeLegacyFormatCss() {
    var legacy = document.getElementById("focusfeed-css");
    if (legacy) legacy.remove();
  }

  function scanCards() {
    removeLegacyFormatCss();
    if (!enabled) return;

    var cards = document.querySelectorAll(CARD_SELECTORS);
    for (var i = 0; i < cards.length; i++) {
      processCard(cards[i]);
    }
  }

  function clearRetiredDecision(card) {
    delete card.dataset.focusfeedRoute;
    delete card.dataset.focusfeedRule;
    delete card.dataset.focusfeedAction;
    showCard(card);
  }

  function processCard(card) {
    if (!enabled) {
      showCard(card);
      return;
    }

    // Skip yt-lockup-view-model inside ytd-rich-item-renderer — parent handles it
    if (card.tagName === "YT-LOCKUP-VIEW-MODEL" &&
        card.closest("ytd-rich-item-renderer")) {
      return;
    }

    var videoId = getVideoIdFromCard(card);

    // API data path — merge intercepted and rendered metadata for Jev.
    if (videoId && videoDataMap[videoId]) {
      var apiVideo = videoDataMap[videoId];
      // DOM format badges/URLs can supply explicit flags that are absent from
      // the intercepted renderer. Unknown duration alone never supplies one.
      var video = Object.assign({}, apiVideo, {
        title: extractTitleFromCard(card) || apiVideo.title,
        channel: extractChannelFromCard(card) || apiVideo.channel,
        channelId: extractChannelIdentityFromCard(card) || apiVideo.channelId || "",
        description: extractDescriptionFromCard(card) || apiVideo.description || "",
        duration: extractDurationFromCard(card) || apiVideo.duration,
        isShort: apiVideo.isShort === true || isCardAShort(card),
        isLive: apiVideo.isLive === true || !!card.querySelector("[overlay-style='LIVE']"),
        isPremiere: apiVideo.isPremiere === true || !!card.querySelector("[overlay-style='UPCOMING']"),
      });
      clearRetiredDecision(card);
      if (liveFeed) liveFeed.observe(card, video);
      return;
    }

    // DOM fallback path. Build the same video shape for Jev.
    var isPlaylist = card.tagName === "YTD-RADIO-RENDERER" ||
      card.tagName === "YTD-PLAYLIST-RENDERER" ||
      card.tagName === "YTD-COMPACT-RADIO-RENDERER" ||
      card.tagName === "YTD-COMPACT-PLAYLIST-RENDERER";
    var channel = isPlaylist ? extractPlaylistChannel(card) : extractChannelFromCard(card);
    var title = isPlaylist ? extractPlaylistTitle(card) : extractTitleFromCard(card);
    var fallbackVideo = {
      videoId: videoId || "",
      title: title,
      channel: channel,
      channelId: extractChannelIdentityFromCard(card),
      description: extractDescriptionFromCard(card),
      duration: extractDurationFromCard(card),
      isShort: isCardAShort(card),
      isLive: !!card.querySelector("[overlay-style='LIVE']"),
      isPremiere: !!card.querySelector("[overlay-style='UPCOMING']"),
    };
    clearRetiredDecision(card);
    if (liveFeed) liveFeed.observe(card, fallbackVideo);
  }

  function isCardAShort(card) {
    if (card.tagName === "YTD-REEL-SHELF-RENDERER" ||
        card.tagName === "YTD-REEL-ITEM-RENDERER" ||
        card.tagName === "YTM-SHORTS-LOCKUP-VIEW-MODEL" ||
        card.tagName === "YTM-SHORTS-LOCKUP-VIEW-MODEL-V2") {
      return true;
    }
    if (card.querySelector("ytm-shorts-lockup-view-model") ||
        card.querySelector("ytm-shorts-lockup-view-model-v2")) {
      return true;
    }
    if (card.tagName === "YTD-RICH-SHELF-RENDERER" &&
        (card.querySelector("ytm-shorts-lockup-view-model") ||
         card.querySelector('a[href*="/shorts/"]'))) {
      return true;
    }
    if (card.querySelector('a[href*="/shorts/"]')) return true;
    if (card.querySelector("[overlay-style='SHORTS']")) return true;

    var badges = card.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer, badge-shape, yt-thumbnail-badge-view-model"
    );
    for (var b = 0; b < badges.length; b++) {
      var badgeText = (badges[b].innerText || badges[b].textContent || "").trim().toUpperCase();
      if (badgeText === "SHORTS" || badgeText === "SHORT") return true;
      if (badges[b].getAttribute("overlay-style") === "SHORTS") return true;
    }

    return false;
  }

  function extractPlaylistTitle(card) {
    var el =
      card.querySelector("#video-title") ||
      card.querySelector("a.yt-simple-endpoint span#video-title") ||
      card.querySelector("h3 a") ||
      card.querySelector("a[title]");
    if (!el) return "";
    return (el.getAttribute("title") || el.innerText || el.textContent || "").trim();
  }

  function extractPlaylistChannel(card) {
    var el =
      card.querySelector("yt-formatted-string.ytd-video-meta-block a") ||
      card.querySelector(".ytd-video-meta-block a[href*='/@']") ||
      card.querySelector("a[href*='/@']") ||
      card.querySelector("#byline");
    if (!el) return "";
    return (el.innerText || el.textContent || "").trim();
  }

  function showCard(card) {
    if (card.dataset.focusfeedHidden !== "true") return;
    card.style.display = "";
    delete card.dataset.focusfeedHidden;
    delete card.dataset.focusfeedReason;
    updateBadge();
  }

  function reprocessAllCards() {
    var allHidden = document.querySelectorAll("[data-focusfeed-hidden='true']");
    for (var h = 0; h < allHidden.length; h++) {
      allHidden[h].style.display = "";
      delete allHidden[h].dataset.focusfeedHidden;
      delete allHidden[h].dataset.focusfeedReason;
    }
    scanCards();
    updateBadge();
    console.log("[FocusFeed] Reprocessed with updated preferences");
  }

  // --- Watch for new cards (infinite scroll / SPA navigation) ---
  function observeFeed() {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var nodes = mutations[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (node.nodeType !== 1) continue;

          if (node.matches && node.matches(CARD_SELECTORS)) {
            processCard(node);
          }

          var inner = node.querySelectorAll ? node.querySelectorAll(CARD_SELECTORS) : [];
          for (var k = 0; k < inner.length; k++) {
            processCard(inner[k]);
          }
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    console.log("[FocusFeed] DOM observer active — watching for new feed items");
  }

  // --- Badge counter ---
  function updateBadge() {
    chrome.runtime.sendMessage({
      type: "FOCUSFEED_STATS",
      hidden: 0,
      total: feedItemsReceived,
    }).catch(function () {});
  }

  // --- Listen for intercepted data from MAIN world ---
  window.addEventListener("message", function (event) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.type !== "FOCUSFEED_FEED_DATA"
    ) return;

    console.log("[FocusFeed] Intercepted API response from:", event.data.endpoint);
    processInterceptedData(event.data.data);
  });

  // --- Listen for messages from popup ---
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === "GET_STATS") {
      sendResponse({
        hidden: 0,
        total: feedItemsReceived,
        enabled: enabled,
        trackedVideos: Object.keys(videoDataMap).length,
        activeGoal: activeProfile && activeProfile.goal || "",
        profileVersion: activeProfile && activeProfile.version || null,
        mode: activeProfile && activeProfile.mode || "focus",
        sessionActive: !!(focusSession && focusSession.active),
      });
    }
  });

  // --- Init ---
  liveFeed = FocusFeedLiveContent.create({ scan: scanCards });
  var liveScanTimer = null;
  var metadataObserver = new MutationObserver(function (mutations) {
    if (!document.documentElement.dataset.focusfeedSession) return;
    if (!mutations.some(function (mutation) {
      var node = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      return Boolean(node);
    })) return;
    clearTimeout(liveScanTimer);
    liveScanTimer = setTimeout(scanCards, 150);
  });
  metadataObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "title"] });
  loadPreferences().then(function () {
    observeFeed();
    setTimeout(scanCards, 1500);
    setTimeout(scanCards, 4000);
  });

  // --- Diagnostic ---
  window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "FOCUSFEED_DIAG") {
      runDiagnostic();
    }
  });

  function runDiagnostic() {
    var ytTags = {};
    var allEls = document.querySelectorAll("*");
    for (var i = 0; i < allEls.length; i++) {
      var tag = allEls[i].tagName.toLowerCase();
      if (tag.startsWith("ytd-") || tag.startsWith("yt-")) {
        ytTags[tag] = (ytTags[tag] || 0) + 1;
      }
    }
    console.log("%c[FocusFeed DIAGNOSTIC]", "color: #3ea6ff; font-size: 14px; font-weight: bold;");
    console.log("Page:", window.location.pathname);
    console.log("YT elements:", ytTags);
    console.log("Tracked videos:", Object.keys(videoDataMap).length);
    console.log("Cards matching selectors:", document.querySelectorAll(CARD_SELECTORS).length);
    console.log("State:", { enabled: enabled, liveSession: Boolean(liveFeed) });
  }

  console.log("[FocusFeed] Content script loaded");
  globalThis.__focusFeedContentInstalled = true;
})();
