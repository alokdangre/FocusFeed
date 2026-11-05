// content.js — FocusFeed content script, runs in ISOLATED world (has chrome.* APIs)
// Receives intercepted feed data, collects card metadata, and hosts live decisions.

(function () {
  "use strict";
  if (globalThis.__focusFeedContentInstalled) return;
  document.documentElement.setAttribute("data-focusfeed-initializing", "true");

  // --- State ---
  var feedItemsReceived = 0;
  var liveFeed = null;
  var PREFERENCE_KEYS = ["classifierEndpoint", "focusfeedAccountV1", "focusfeedSettingsV2", "focusfeedCacheEpochV1", "focusFeedChannelBlocksV1", "focusfeedChannelProfilesV1", "focusfeedCorrectionsV1"];
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === "local" && PREFERENCE_KEYS.some(function (key) { return !!changes[key]; }) && liveFeed) {
      liveFeed.preferencesChanged(Boolean(changes.focusfeedCacheEpochV1)).catch(function (error) {
        console.warn("[FocusFeed] Could not reload preferences", error.message);
      });
    }
  });

  // --- Extract video data from YouTube API response ---
  function extractVideoRenderers(obj, results) {
    if (!results) results = [];
    if (!obj || typeof obj !== "object") return results;
    collectCollections(obj);

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
        channelId: extractChannelIdentity(vr.ownerText) || extractChannelIdentity(vr.longBylineText) || extractChannelIdentity(vr.shortBylineText),
        creators: extractCreators(vr.ownerText).concat(extractCreators(vr.longBylineText), extractCreators(vr.shortBylineText)),
        description: extractDescription(vr),
        duration: extractText(vr.lengthText),
        // A missing duration is unknown, not proof that this is a Short.
        isShort: false,
        isLive: isLive,
        isPremiere: isPremiere,
      });
    }

    var endElement = obj.endscreenElementRenderer;
    var endWatch = endElement && endElement.endpoint && endElement.endpoint.watchEndpoint;
    var endVideo = endElement && endElement.style === "VIDEO" && endWatch && endWatch.videoId
      ? Object.assign({}, endElement, { videoId: endWatch.videoId, shortBylineText: endElement.byline }) : null;
    if (obj.compactVideoRenderer || obj.endScreenVideoRenderer || endVideo) {
      var cvr = obj.compactVideoRenderer || obj.endScreenVideoRenderer || endVideo;
      var cIsLive = !!(cvr.badges && cvr.badges.some &&
        cvr.badges.some(function(b) { return b.liveBadgeRenderer; }));
      results.push({
        videoId: cvr.videoId || "",
        title: extractText(cvr.title),
        channel: extractText(cvr.longBylineText || cvr.shortBylineText || cvr.ownerText),
        channelId: extractChannelIdentity(cvr.longBylineText) || extractChannelIdentity(cvr.shortBylineText) || extractChannelIdentity(cvr.ownerText),
        creators: extractCreators(cvr.longBylineText).concat(extractCreators(cvr.shortBylineText), extractCreators(cvr.ownerText)),
        description: extractDescription(cvr),
        duration: extractText(cvr.lengthText),
        // Compact cards without duration can be live/upcoming; do not infer Shorts.
        isShort: false,
        isLive: cIsLive,
        isPremiere: false,
      });
    }

    if (obj.lockupViewModel) {
      var lockup = obj.lockupViewModel;
      var metadata = lockup.metadata && lockup.metadata.lockupMetadataViewModel || {};
      var onTap = lockup.rendererContext && lockup.rendererContext.commandContext && lockup.rendererContext.commandContext.onTap || {};
      var watch = (onTap.innertubeCommand || onTap).watchEndpoint || {};
      if (lockup.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" || watch.videoId && !watch.playlistId && !lockup.contentType) {
        var rows = metadata.metadata && metadata.metadata.contentMetadataViewModel && metadata.metadata.contentMetadataViewModel.metadataRows || [];
        var creators = [];
        if (rows[0]) (rows[0].metadataParts || []).forEach(function (part) { creators = creators.concat(extractCreators(part.text)); });
        creators = FocusFeedChannelPolicy.creators({ creators: creators });
        results.push({ videoId: watch.videoId || lockup.contentId || "", title: extractText(metadata.title),
          channel: creators.map(function (creator) { return creator.label; }).join(" and "), channelId: creators[0] && creators[0].channelId || "",
          creators: creators, description: "", duration: "", isShort: false, isLive: false, isPremiere: false });
      }
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
      if (key === "videoRenderer" || key === "compactVideoRenderer" || key === "endScreenVideoRenderer" ||
          key === "playlistVideoRenderer" || key === "reelItemRenderer" ||
          key === "reelShelfRenderer" || key === "shortsLockupViewModel" || key === "lockupViewModel") {
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
    return FocusFeedChannelPolicy.normalizeChannelId(value);
  }

  function extractChannelIdentity(textObj) {
    var creators = extractCreators(textObj); return creators[0] && creators[0].channelId || "";
  }
  function extractCreators(textObj) {
    var runs = textObj && Array.isArray(textObj.runs) ? textObj.runs : [];
    var commands = textObj && Array.isArray(textObj.commandRuns) ? textObj.commandRuns : [];
    runs = runs.concat(commands);
    var creators = [];
    for (var index = 0; index < runs.length; index++) {
      var endpoint = runs[index] && (runs[index].navigationEndpoint || runs[index].onTap) || {};
      endpoint = endpoint.innertubeCommand || endpoint;
      var browse = endpoint.browseEndpoint || {};
      var command = endpoint.commandMetadata && endpoint.commandMetadata.webCommandMetadata || {};
      var ids = [browse.browseId, browse.canonicalBaseUrl, command.url, endpoint.urlEndpoint && endpoint.urlEndpoint.url]
        .map(normalizeChannelIdentity).filter(Boolean);
      if (!ids.length) continue;
      var run = runs[index], label = run.text || extractText(textObj);
      if (Number.isInteger(run.startIndex) && Number.isInteger(run.length)) label = extractText(textObj).slice(run.startIndex, run.startIndex + run.length);
      creators.push({ channelId: ids[0], aliases: ids.slice(1), label: label });
    }
    return FocusFeedChannelPolicy.creators({ creators: creators });
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
  var collectionDataMap = new Map();
  function collectionId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{2,60}$/.test(value) ? value : ""; }
  function collectCollections(obj) {
    if (!obj || typeof obj !== "object") return;
    var renderer = obj.playlistRenderer || obj.radioRenderer || obj.compactPlaylistRenderer || obj.compactRadioRenderer || obj.playlistPanelRenderer || obj.endScreenPlaylistRenderer;
    var lockup = obj.lockupViewModel, meta = lockup && lockup.metadata && lockup.metadata.lockupMetadataViewModel;
    if (lockup && lockup.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO" && /PLAYLIST|PODCAST/.test(lockup.contentType || "")) renderer = lockup;
    if (renderer) {
      var id = collectionId(renderer.playlistId || renderer.contentId);
      if (id) {
        var entries = [];
        (renderer.videos || renderer.contents || []).slice(0, 5).forEach(function (item) {
          var v = item.childVideoRenderer || item.playlistVideoRenderer || item.playlistPanelVideoRenderer || item.compactVideoRenderer || item.videoRenderer;
          if (v) entries.push({ title: extractText(v.title), channel: extractText(v.shortBylineText || v.longBylineText) });
        });
        var previous = collectionDataMap.get(id) || {};
        collectionDataMap.set(id, { title: (typeof renderer.title === "string" ? renderer.title : extractText(renderer.title || meta && meta.title)) || previous.title || "",
          description: extractDescription(renderer) || previous.description || "", entries: entries.length ? entries : previous.entries || [] });
      }
    }
    while (collectionDataMap.size > 200) collectionDataMap.delete(collectionDataMap.keys().next().value);
  }

  function rememberChannel(identity) {
    var previous = videoDataMap[identity.videoId] || {};
    videoDataMap[identity.videoId] = Object.assign({}, previous, { videoId: identity.videoId,
      channelId: identity.channelId, channel: previous.channel || identity.channelLabel || "",
      creators: FocusFeedChannelPolicy.creators({ channelId: identity.channelId, channel: identity.channelLabel, creators: previous.creators || [] }) });
  }

  function processInterceptedData(data) {
    var videos = extractVideoRenderers(data);
    if (data && data.videoDetails) {
      var d = data.videoDetails;
      videos.push({ videoId: d.videoId, title: d.title, channel: d.author, channelId: d.channelId,
        description: d.shortDescription || "", duration: "", isLive: d.isLiveContent === true });
    }
    feedItemsReceived += videos.length;

    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (video.videoId) {
        var previous = videoDataMap[video.videoId] || {};
        videoDataMap[video.videoId] = Object.assign({}, previous, video, {
          title: video.title || previous.title || "",
          channel: video.channel || previous.channel || "",
          channelId: video.channelId || previous.channelId || "",
          creators: FocusFeedChannelPolicy.creators({ channelId: video.channelId || previous.channelId, channel: video.channel || previous.channel,
            creators: (video.creators || []).concat(previous.creators || []) }),
          description: video.description || previous.description || "",
          duration: video.duration || previous.duration || "",
          isShort: video.isShort === true || previous.isShort === true,
          isLive: video.isLive === true || previous.isLive === true,
          isPremiere: video.isPremiere === true || previous.isPremiere === true,
        });
      }
    }

    var trackedIds = Object.keys(videoDataMap);
    trackedIds.slice(0, Math.max(0, trackedIds.length - 1500)).forEach(function (id) { delete videoDataMap[id]; });
    scanCards();
  }

  // --- DOM manipulation ---
  var PLAYER_CARDS = FocusFeedYouTubeUI.playerCards;

  function getVideoIdFromCard(card) {
    var link =
      (card.matches('a[href*="/watch?"], a[href*="/shorts/"]') ? card : null) ||
      card.querySelector("a#video-title-link") ||
      card.querySelector("a#video-title") ||
      card.querySelector('a[href*="/watch?v="]') ||
      card.querySelector('a[href*="/shorts/"]') ||
      card.querySelector("a[href*='/playlist']");
    var href = link && link.getAttribute("href") || "";
    var match = href.match(/[?&]v=([^&]+)/) || href.match(/\/shorts\/([^?&/]+)/);
    if (match) return match[1];
    // Recycled renderer classes can lag behind the link that will actually navigate.
    var contentDiv = card.querySelector("[class*='content-id-']") || card;
    var classMatch = String(contentDiv.className || "").match(/content-id-([a-zA-Z0-9_-]+)/);
    return classMatch ? classMatch[1] : null;
  }

  function extractTitleFromCard(card) {
    var el =
      card.querySelector("#video-title") ||
      card.querySelector("a#video-title-link") ||
      card.querySelector("h3 a") ||
      card.querySelector("h3") ||
      card.querySelector("span#video-title") ||
      card.querySelector(".ytp-videowall-still-info-title, .ytp-modern-videowall-still-info-title, .ytp-suggestion-title, .ytp-autonav-endscreen-upnext-title");

    if (el) {
      var title = (
        el.getAttribute("title") ||
        el.innerText ||
        el.textContent ||
        ""
      ).trim();
      if (title) return title;
    }

    var titled = card.matches("a[title]") ? card : card.querySelector("a[title]");
    if (titled) {
      var t = (titled.getAttribute("title") || "").trim();
      if (t) return t;
    }

    var labeled = card.matches("a[aria-label]") ? card : card.querySelector("a[aria-label]");
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
      card.querySelector("#byline") ||
      card.querySelector(".ytContentMetadataViewModelMetadataRow .ytContentMetadataViewModelMetadataText") ||
      card.querySelector(".ytp-videowall-still-info-author, .ytp-modern-videowall-still-info-author, .ytp-suggestion-author, .ytp-autonav-endscreen-upnext-author");

    if (!el) return "";
    return (el.innerText || el.textContent || "").trim();
  }

  function extractChannelIdentityFromCard(card) {
    var link = card.querySelector('a[href*="/channel/"]') || card.querySelector('a[href*="/@"]');
    if (!link) return "";
    return normalizeChannelIdentity(link.getAttribute("href") || "");
  }
  function creatorsFromCard(card) {
    var owners = Array.from(card.querySelectorAll("ytd-channel-name, #channel-name, #byline, .ytLockupMetadataViewModelAvatar, .ytContentMetadataViewModelMetadataRow:first-child"));
    var links = owners.length ? owners.flatMap(function (owner) { return Array.from(owner.querySelectorAll('a[href*="/channel/"], a[href*="/@"]')); })
      : Array.from(card.querySelectorAll('a[href*="/channel/"], a[href*="/@"]'));
    return FocusFeedChannelPolicy.creators({ creators: links.map(function (link) {
      return { channelId: normalizeChannelIdentity(link.getAttribute("href")), label: (link.textContent || "").trim() };
    }) });
  }

  function extractDurationFromCard(card) {
    // Duration text is in the time-status overlay on the thumbnail
    var el = card.querySelector(
      "ytd-thumbnail-overlay-time-status-renderer span.ytd-thumbnail-overlay-time-status-renderer, " +
      "ytd-thumbnail-overlay-time-status-renderer #text, " +
      "span.ytp-time-duration, " +
      "badge-shape[type='video-length'] span, .ytp-videowall-still-info-duration, .ytp-modern-videowall-still-info-duration, .ytp-suggestion-duration, .ytp-autonav-endscreen-upnext-duration"
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

  function scanCards() {
    youtubeUI.scanDisplay();
    youtubeUI.scanHome(extractCardMetadata);
    // One surface list owns scanning and native-menu context alike.
    var cards = document.querySelectorAll(youtubeUI.cards);
    for (var i = 0; i < cards.length; i++) {
      if (!youtubeUI.displayHidden(cards[i]) && !youtubeUI.manages(cards[i])) processCard(cards[i]);
    }
    var playing = youtubeUI.currentVideo();
    if (playing && liveFeed) liveFeed.observe(playing.card, playing.video);
    youtubeUI.decorate();
  }

  function extractCardMetadata(card) {
    // Some player layouts nest a suggestion link in a video-wall tile. Only
    // the outer native tile owns visibility, so its clickable child cannot escape.
    if (card.matches(PLAYER_CARDS) && card.parentElement && card.parentElement.closest(PLAYER_CARDS)) return;
    // Skip yt-lockup-view-model inside ytd-rich-item-renderer — parent handles it
    if (card.tagName === "YT-LOCKUP-VIEW-MODEL" &&
        card.closest("ytd-rich-item-renderer")) {
      return;
    }

    // Mixes/collections link to a seed video but do not belong to that video's
    // channel. The collection thumbnail is explicit structural evidence.
    if (card.matches("ytd-radio-renderer, ytd-playlist-renderer, ytd-compact-radio-renderer, ytd-compact-playlist-renderer") ||
        card.querySelector("yt-collection-thumbnail-view-model, yt-collections-stack") ||
        card.matches(PLAYER_CARDS) && playerCollectionId(card)) {
      var listLink = card.matches('a[href*="list="]') ? card : card.querySelector('a[href*="list="]'), id = "";
      try { id = collectionId(new URL(listLink.getAttribute("href"), location.origin).searchParams.get("list")); } catch (_) {}
      var known = collectionDataMap.get(id) || {};
      return { videoId: id ? "collection:" + id : "", collectionId: id, itemType: "collection", collection: true,
        title: extractTitleFromCard(card) || known.title || "", channel: "", channelId: "",
        description: known.description || extractDescriptionFromCard(card) ||
          Array.from(card.querySelectorAll(".ytContentMetadataViewModelMetadataRow, #metadata-line, #byline")).slice(0, 3).map(function (n) { return n.textContent.trim(); }).join(" · "),
        entries: known.entries || [] };
    }

    var videoId = getVideoIdFromCard(card);

    // API data path — merge intercepted and rendered metadata for Jev.
    if (videoId && videoDataMap[videoId]) {
      var apiVideo = videoDataMap[videoId];
      var renderedTitle = extractTitleFromCard(card);
      var domAgrees = !renderedTitle || !apiVideo.title || renderedTitle === apiVideo.title;
      // DOM format badges/URLs can supply explicit flags that are absent from
      // the intercepted renderer. Unknown duration alone never supplies one.
      var video = Object.assign({}, apiVideo, {
        title: apiVideo.title || extractTitleFromCard(card),
        channel: apiVideo.channel || (domAgrees ? extractChannelFromCard(card) : ""),
        channelId: apiVideo.channelId || (domAgrees ? extractChannelIdentityFromCard(card) : "") || "",
        description: apiVideo.description || (domAgrees ? extractDescriptionFromCard(card) : "") || "",
        duration: apiVideo.duration || (domAgrees ? extractDurationFromCard(card) : ""),
        isShort: apiVideo.isShort === true || isCardAShort(card),
        isLive: apiVideo.isLive === true || !!card.querySelector("[overlay-style='LIVE']"),
        isPremiere: apiVideo.isPremiere === true || !!card.querySelector("[overlay-style='UPCOMING']"),
      });
      var known = FocusFeedChannelPolicy.creators(apiVideo), rendered = domAgrees ? creatorsFromCard(card) : [];
      // Only a single-channel byline can establish this cross-source alias.
      // Collaborators are separate identities, never aliases of the publisher.
      video.aliases = known[0] && known[0].aliases || [];
      if (known.length <= 1 && rendered.length === 1 && !card.querySelector("yt-avatar-stack-view-model")) {
        video.aliases = video.aliases.concat(rendered[0].channelId);
      }
      video.creators = FocusFeedChannelPolicy.creators({ channelId: video.channelId, channel: video.channel, aliases: video.aliases, creators: known.concat(rendered) });
      return video;
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
    var channelPage = /^\/(?:@|channel\/)/.test(location.pathname);
    if (!fallbackVideo.channelId && channelPage) fallbackVideo.channelId = FocusFeedChannelPolicy.normalizeChannelId(location.pathname);
    if (!fallbackVideo.channelId && card.tagName === "YTD-CHANNEL-RENDERER") fallbackVideo.channelId = extractChannelIdentityFromCard(card);
    fallbackVideo.aliases = [fallbackVideo.channelId].filter(Boolean);
    fallbackVideo.creators = creatorsFromCard(card);
    return fallbackVideo;
  }

  function playerCollectionId(card) {
    var id = "";
    try { id = collectionId(new URL(card.getAttribute("href"), location.origin).searchParams.get("list")); } catch (_) {}
    // A watch URL can carry playlist context for an individual video. Treat it
    // as a collection only with playlist-renderer evidence or a native list badge.
    return id && (collectionDataMap.has(id) || card.querySelector(".ytp-videowall-still-listlabel, .ytp-modern-videowall-still-listlabel, .ytp-suggestion-playlist")) ? id : "";
  }

  function processCard(card) {
    var video = extractCardMetadata(card);
    if (!video) return;
    if (liveFeed) liveFeed.observe(card, video);
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

  // --- Listen for intercepted data from MAIN world ---
  window.addEventListener("message", function (event) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.type !== "FOCUSFEED_FEED_DATA"
    ) return;

    processInterceptedData(event.data.data);
  });

  // --- Listen for messages from popup ---
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === "FF_AUTO_PROGRESS" && liveFeed) liveFeed.progress(msg);
    if (msg.type === "FF_REVIEW_HIDDEN") { sendResponse(youtubeUI.reviewHidden()); }
    if (msg.type === "FF_RESET_RUNTIME") {
      if (liveFeed) liveFeed.reload(true);
      sendResponse({ ok: true });
    }
    if (msg.type === "GET_STATS") {
      sendResponse({
        total: feedItemsReceived,
        trackedVideos: Object.keys(videoDataMap).length,
        runtime: liveFeed && liveFeed.snapshot(),
      });
    }
  });

  // --- Init ---
  var youtubeUI = FocusFeedYouTubeUI.create({ lookup: function (id) { return videoDataMap[id]; }, extract: extractCardMetadata,
    rememberChannel: rememberChannel, requestScan: requestScan });
  liveFeed = FocusFeedAutoRuntime.create({ scan: scanCards, render: youtubeUI.render, clear: youtubeUI.clear, configure: youtubeUI.configure, activity: youtubeUI.activity });
  youtubeUI.setRuntime(liveFeed);
  var scanTimer = null;
  function requestScan() {
    if (!scanTimer) scanTimer = setTimeout(function () { scanTimer = null; scanCards(); }, 100);
  }
  var metadataObserver = new MutationObserver(function (mutations) {
    if (mutations.some(function (mutation) {
      var node = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      return !node || !node.closest("[data-focusfeed-ui]");
    })) requestScan();
  });
  var tickInterval = null;
  var accountCheckedAt = 0;
  function refreshAccount() {
    if (Date.now() - accountCheckedAt < 30000) return;
    accountCheckedAt = Date.now();
    chrome.runtime.sendMessage({ type: "FF_ACCOUNT_STATUS" }).catch(function () {});
  }
  function startObservation() {
    metadataObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["href", "title", "is-active", "video-id", "hidden", "aria-checked"] });
    if (!tickInterval) tickInterval = setInterval(function () { if (!document.hidden) { refreshAccount(); liveFeed.tick(); } }, 2000);
  }
  startObservation();
  refreshAccount();
  window.addEventListener("yt-navigate-start", function () { liveFeed.navigate(true); });
  window.addEventListener("yt-navigate-finish", function () { liveFeed.navigate(false); requestScan(); });
  window.addEventListener("popstate", function () { liveFeed.navigate(false); requestScan(); });
  window.addEventListener("scroll", requestScan, { passive: true });
  window.addEventListener("resize", requestScan, { passive: true });
  window.addEventListener("pagehide", function () {
    metadataObserver.disconnect(); clearInterval(tickInterval); tickInterval = null;
    clearTimeout(scanTimer); scanTimer = null; liveFeed.navigate(true);
  });
  window.addEventListener("pageshow", function () { startObservation(); liveFeed.navigate(false); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) requestScan(); });
  liveFeed.reload().catch(function (error) {
    document.documentElement.removeAttribute("data-focusfeed-initializing");
    console.warn("[FocusFeed] Could not load settings", error.message);
  });

  globalThis.__focusFeedContentInstalled = true;
})();
