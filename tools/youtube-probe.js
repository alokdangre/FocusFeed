// Run as a Chrome DevTools Snippet on YouTube. Captures stay in memory until exported.
// This does not call fetch, read cookies/storage, patch YouTube, or change its styles.
(() => {
  "use strict";
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) throw new Error("Run this on a YouTube page.");
  if (window.FFProbe && window.FFProbe.stop) window.FFProbe.stop();
  const PLAYER_CARDS = "a.ytp-videowall-still, a.ytp-modern-videowall-still, a.ytp-suggestion-link, a.ytp-autonav-endscreen-link-container";
  const CARDS = "ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-radio-renderer, ytd-playlist-renderer, ytd-compact-radio-renderer, ytd-compact-playlist-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-video-renderer[is-active], .focusfeed-card, " + PLAYER_CARDS;
  // Broader than the extension's injection selectors, so unsupported menus are captured too.
  const MENUS = "ytd-menu-popup-renderer, yt-sheet-view-model [role='menu'], yt-sheet-view-model yt-list-view-model, tp-yt-paper-listbox, [role='menu'], yt-contextual-sheet-layout, yt-dropdown-menu";
  const VARS = ["--yt-spec-text-primary", "--yt-spec-text-secondary", "--yt-spec-base-background", "--yt-spec-menu-background", "--yt-spec-raised-background", "--yt-spec-badge-chip-background", "--yt-spec-10-percent-layer", "--yt-spec-call-to-action"];
  const LIMITS = { snapshots: 16, events: 250, network: 80, errors: 30, inspections: 12, transitions: 400, menuTriggers: 30 };
  let data, running = false, listeners = [], observer, resources, menuTimer, endTimer, sampleTimer, transitionTimer, lastHover, lastHoverAt = 0, lastMenu = "", lastLoading = "";
  let nodeIDs = new WeakMap(), nextNodeID = 0, samples = new WeakMap(), watched = new Set();
  function nodeID(node) {
    if (!nodeIDs.has(node)) nodeIDs.set(node, ++nextNodeID);
    return nodeIDs.get(node);
  }
  const clip = (value, max = 240) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
  function snapshotPriority(label) {
    return label === "after-hover" ? 0 : label === "after-click" ? 1 : ["menu-changed", "menu-closed"].includes(label) || label.startsWith("loading-") ? 2 : 3;
  }
  function push(key, value) {
    if (data[key].length >= LIMITS[key]) {
      data.dropped[key] = (data.dropped[key] || 0) + 1;
      let remove = 0;
      if (key === "snapshots") {
        const minimum = Math.min(...data.snapshots.map(snapshot => snapshotPriority(snapshot.label)));
        if (snapshotPriority(value.label) < minimum) return;
        remove = data.snapshots.findIndex(snapshot => snapshotPriority(snapshot.label) === minimum);
      }
      data[key].splice(remove, 1);
    }
    data[key].push(value);
  }
  function safeURL(value) {
    try {
      const url = new URL(value, location.href);
      if (!/(^|\.)youtube\.com$/.test(url.hostname)) return url.protocol === "https:" ? url.origin + url.pathname : "";
      for (const key of Array.from(url.searchParams.keys())) if (!["v", "list", "search_query"].includes(key)) url.searchParams.delete(key);
      url.hash = ""; return url.href;
    } catch (_) { return ""; }
  }
  function channelID(value) {
    const raw = clip(value);
    if (/^UC[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;
    if (/^@[^\s/?#]+$/.test(raw)) return raw.toLowerCase();
    try {
      const url = new URL(raw, location.href);
      if (!/(^|\.)youtube\.com$/.test(url.hostname)) return "";
      const path = url.pathname.match(/^\/(channel\/([^/?#]+)|(@[^/?#]+))/);
      return path ? path[2] || path[3].toLowerCase() : "";
    } catch (_) { return ""; }
  }
  function tag(node) {
    if (!node || node.nodeType !== 1) return null;
    return { tag: node.localName, id: node.id || "", class: clip(node.getAttribute("class"), 320),
      role: node.getAttribute("role"), label: clip(node.getAttribute("aria-label")),
      hidden: node.hasAttribute("hidden"), ariaHidden: node.getAttribute("aria-hidden"), disabled: !!node.disabled };
  }
  function appearance(node) {
    if (!node) return null;
    const css = getComputedStyle(node), rect = node.getBoundingClientRect();
    const variables = Object.fromEntries(VARS.map(key => [key, css.getPropertyValue(key).trim()]));
    return { ...tag(node), color: css.color, background: css.backgroundColor, display: css.display, visibility: css.visibility,
      opacity: css.opacity, font: css.font, pointerEvents: css.pointerEvents, cursor: css.cursor, variables,
      rect: { x: Math.round(rect.x || 0), y: Math.round(rect.y || rect.top || 0), width: Math.round(rect.width || 0), height: Math.round(rect.height || 0) } };
  }
  function visible(node) {
    if (!node || !node.isConnected || node.closest("[hidden], [aria-hidden='true']")) return false;
    const css = getComputedStyle(node);
    return css.display !== "none" && css.visibility !== "hidden" && node.getClientRects().length > 0;
  }
  function identityEvidence(value) {
    const found = [], seen = new WeakSet(); let visited = 0, truncated = false;
    function walk(obj, path, depth) {
      if (!obj || typeof obj !== "object" || seen.has(obj)) return;
      if (depth > 12 || visited++ >= 500 || found.length >= 35) { truncated = true; return; }
      seen.add(obj);
      for (const key of Object.keys(obj).slice(0, 70)) {
        let item; try { item = obj[key]; } catch (_) { continue; }
        const next = path + "." + key;
        if (["channelId", "browseId", "canonicalBaseUrl", "videoId", "contentId"].includes(key) && typeof item === "string") {
          found.push({ path: next, value: clip(item), channelId: channelID(item) || undefined });
        } else if (key === "url" && typeof item === "string" && channelID(item)) {
          found.push({ path: next, value: safeURL(item), channelId: channelID(item) });
        } else if (item && typeof item === "object") walk(item, next, depth + 1);
      }
    }
    walk(value, "data", 0); return { found: found.slice(0, 35), truncated };
  }
  function initialDataMatches(videoId) {
    const matches = [], seen = new WeakSet(); let visited = 0, truncated = false;
    function walk(obj, path, depth) {
      if (!obj || typeof obj !== "object" || seen.has(obj)) return;
      if (visited++ >= 5000 || depth > 30 || matches.length >= 6) { truncated = true; return; }
      seen.add(obj);
      if ((obj.videoId === videoId || obj.contentId === videoId) && (obj.title || obj.metadata || obj.ownerText || obj.longBylineText)) {
        matches.push({ path, keys: Object.keys(obj).slice(0, 25), evidence: identityEvidence(obj) }); return;
      }
      for (const key of Object.keys(obj).slice(0, 80)) {
        let value; try { value = obj[key]; } catch (_) { continue; }
        if (value && typeof value === "object") walk(value, path + "." + key, depth + 1);
      }
    }
    if (videoId) { try { walk(window.ytInitialData, "ytInitialData", 0); } catch (_) {} }
    return { matches, visited, truncated, note: "Initial page data can predate SPA navigation; an absent match is not proof that the channel ID does not exist." };
  }
  // Structural outline, not raw HTML: no scripts, inline handlers, form values or images.
  function structure(node, budget = 130) {
    let count = 0;
    function walk(current, depth) {
      if (!current || depth > 9 || count++ >= budget) return "…";
      if (current.nodeType === 3) return clip(current.textContent, 100) || null;
      if (current.nodeType !== 1 || ["script", "style", "template", "iframe", "noscript"].includes(current.localName)) return null;
      const value = tag(current), href = current.getAttribute("href");
      if (href) value.href = safeURL(href);
      if (current.localName === "svg") return { tag: "svg", icon: true };
      value.children = Array.from(current.childNodes).slice(0, 18).map(child => walk(child, depth + 1)).filter(Boolean);
      return value;
    }
    return { tree: walk(node, 0), truncated: count >= budget };
  }
  function rootCard(node) {
    if (!node || !node.closest) return null;
    const card = node.closest(".focusfeed-card") || node.closest("ytd-rich-item-renderer") || node.closest(CARDS);
    return card?.matches(PLAYER_CARDS) && card.parentElement?.closest(PLAYER_CARDS) || card;
  }
  function cardInfo(card, full = false) {
    if (!card) return null;
    const links = (card.matches("a[href]") ? [card] : []).concat(Array.from(card.querySelectorAll("a[href]"))).slice(0, 35).map(node => ({ href: safeURL(node.getAttribute("href")),
      text: clip(node.textContent), channelId: channelID(node.getAttribute("href")) || undefined }));
    const videoLink = links.find(link => /[?&]v=|\/shorts\//.test(link.href));
    let id = card.dataset.videoId || "";
    if (videoLink) { const url = new URL(videoLink.href); id = url.searchParams.get("v") || url.pathname.split("/shorts/")[1] || id; }
    const rendererData = [];
    const roots = [card, ...Array.from(card.querySelectorAll("yt-lockup-view-model, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer")).slice(0, 3)];
    for (const node of roots) {
      for (const key of ["data", "__data"]) {
        try { if (node[key]) {
          const value = key === "__data" ? node[key].data || node[key] : node[key];
          rendererData.push({ source: node.localName + "." + key, valueType: typeof value,
            rootKeys: Object.keys(value).slice(0, 25), ...identityEvidence(value) });
        } }
        catch (_) {}
      }
    }
    if (!id) {
      const evidence = rendererData.flatMap(source => source.found).find(item => /\.(videoId|contentId)$/.test(item.path) && /^[A-Za-z0-9_-]{11}$/.test(item.value));
      if (evidence) id = evidence.value;
    }
    const channelLinks = links.filter(link => link.channelId);
    const channelIds = [...new Set(channelLinks.map(link => link.channelId).concat(rendererData.flatMap(source => source.found.map(item => item.channelId).filter(Boolean))))];
    const title = card.querySelector("#video-title-link, #video-title, .focusfeed-card-title, h3, .ytp-videowall-still-info-title, .ytp-modern-videowall-still-info-title, .ytp-suggestion-title, .ytp-autonav-endscreen-upnext-title");
    const listLink = links.find(link => /[?&]list=/.test(link.href));
    const state = { ...tag(card), nodeID: nodeID(card), videoId: id, title: clip(title && (title.getAttribute("title") || title.textContent)),
      playerRecommendation: card.matches(PLAYER_CARDS),
      collection: { structuralEvidence: !!card.querySelector("yt-collection-thumbnail-view-model, yt-collections-stack, .ytp-videowall-still-listlabel, .ytp-modern-videowall-still-listlabel, .ytp-suggestion-playlist") ||
        card.matches("ytd-radio-renderer, ytd-playlist-renderer, ytd-compact-radio-renderer, ytd-compact-playlist-renderer"),
        playlistId: listLink ? new URL(listLink.href).searchParams.get("list") : null,
        metadata: Array.from(card.querySelectorAll(".ytContentMetadataViewModelMetadataRow, #metadata-line, #byline, #description-text")).slice(0, 6).map(node => clip(node.textContent)) },
      visible: visible(card), channelLinks, channelIds, rendererData, links,
      filtering: { hidden: card.dataset.focusfeedAutoHidden, pending: card.dataset.focusfeedAutoPending, focusWithheld: card.hasAttribute("data-focusfeed-focus-withheld") },
      style: appearance(card), titleStyle: appearance(title), titleTextStyle: appearance(title?.querySelector(".ytAttributedStringHost, span") || title),
      channelNameSamples: Array.from(card.querySelectorAll(".ytContentMetadataViewModelMetadataRow:first-child .ytContentMetadataViewModelMetadataText")).slice(0, 4)
        .map(node => ({ text: clip(node.textContent), style: appearance(node) })),
      controls: Array.from(card.querySelectorAll("button, [role='button'], summary, yt-icon-button")).slice(0, 10).map(node => ({ ...tag(node), text: clip(node.textContent, 100), style: appearance(node) })) };
    if (full) state.structure = structure(card);
    const loader = card.querySelector(".focusfeed-card-loading"), thumb = card.querySelector(".ytLockupViewModelContentImage, ytd-thumbnail, #thumbnail, .ytp-videowall-still-image, .ytp-modern-videowall-still-image, .ytp-suggestion-image, .ytp-autonav-endscreen-upnext-thumbnail");
    state.loading = { busy: card.getAttribute("aria-busy"), inert: !!card.inert, thumbnail: appearance(thumb),
      skeleton: appearance(loader), shapes: loader ? Array.from(loader.querySelectorAll(".focusfeed-loading-shape")).slice(0, 7).map(appearance) : [],
      images: Array.from(card.querySelectorAll("img")).slice(0, 3).map(img => ({ complete: img.complete, naturalWidth: img.naturalWidth,
        loading: img.getAttribute("loading"), style: appearance(img) })) };
    return state;
  }
  function menuInfo(menu) {
    const rows = Array.from(menu.querySelectorAll(".focusfeed-menu-action, tp-yt-paper-item, [role='menuitem'], yt-list-item-view-model"))
      .filter(node => node.classList.contains("focusfeed-menu-action") || !node.parentElement?.closest("yt-list-item-view-model, tp-yt-paper-item"))
      .sort((a, b) => Number(b.classList.contains("focusfeed-menu-action")) - Number(a.classList.contains("focusfeed-menu-action")));
    return { style: appearance(menu), parentStyle: appearance(menu.parentElement), rowCount: rows.length, rowsTruncated: rows.length > 16,
      rows: rows.slice(0, 16)
        .map(node => ({ text: clip(node.textContent), style: appearance(node), labelStyle: appearance(node.querySelector("span, yt-formatted-string")),
          textStyles: Array.from(node.querySelectorAll("span, small, yt-formatted-string")).slice(0, 4).map(appearance),
          focusfeed: node.classList.contains("focusfeed-menu-action") })), structure: structure(menu, 180) };
  }
  function mediaInfo(node) {
    const source = node.currentSrc || node.src || "";
    return { ...tag(node), paused: node.paused, muted: node.muted, autoplay: node.autoplay, readyState: node.readyState,
      currentTime: Math.round(Number(node.currentTime) || 0), sourceKind: source.startsWith("blob:") ? "blob" : source ? "url" : "none",
      preview: !!node.closest("#inline-preview-player, #video-preview, ytd-video-preview, ytd-moving-thumbnail-renderer"),
      suppressed: !!node.closest("[data-focusfeed-preview-suppressed]"), card: rootCard(node) && tag(rootCard(node)), style: appearance(node) };
  }
  function watchInfo() {
    const watch = document.querySelector("ytd-watch-flexy:not([hidden])");
    if (!watch) return null;
    const owner = watch.querySelector("#owner, #channel-name"), title = watch.querySelector("h1, h2");
    let details = null;
    try { const value = window.ytInitialPlayerResponse?.videoDetails;
      if (value) details = { videoId: value.videoId, channelId: value.channelId, author: clip(value.author), title: clip(value.title) };
    } catch (_) {}
    return { urlVideoId: new URL(location.href).searchParams.get("v"), rendererVideoId: watch.getAttribute("video-id"),
      title: clip(title?.textContent), ownerLinks: Array.from((owner || watch).querySelectorAll('a[href*="/@"], a[href*="/channel/"]')).slice(0, 8)
        .map(link => ({ text: clip(link.textContent), href: safeURL(link.getAttribute("href")), channelId: channelID(link.getAttribute("href")) })),
      initialPlayerDetails: details, note: "Initial player data can be stale after SPA navigation; compare video IDs.",
      actionMenus: Array.from(watch.querySelectorAll("#actions ytd-menu-renderer, ytd-watch-metadata ytd-menu-renderer, #menu ytd-menu-renderer")).slice(0, 4).map(node => structure(node, 70)) };
  }
  // Small state samples retain the same physical node ID through hover, recycling and removal.
  function sampleCard(card) {
    const link = card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"], a[href*="/playlist?"]');
    const title = card.querySelector("#video-title-link, #video-title, .ytLockupMetadataViewModelTitle, h3");
    const css = getComputedStyle(card);
    return { nodeID: nodeID(card), connected: card.isConnected, href: link ? safeURL(link.getAttribute("href")) : "",
      title: clip(title?.textContent), channel: clip(card.querySelector("ytd-channel-name, #channel-name, #byline, .ytContentMetadataViewModelMetadataRow")?.textContent),
      duration: clip(card.querySelector("ytd-thumbnail-overlay-time-status-renderer, yt-thumbnail-badge-view-model, badge-shape[type='video-length']")?.textContent),
      description: clip(card.querySelector("#description-text, .metadata-snippet-text")?.textContent),
      hidden: card.getAttribute("data-focusfeed-auto-hidden"), pending: card.getAttribute("data-focusfeed-auto-pending"),
      withheld: card.hasAttribute("data-focusfeed-focus-withheld"), previewSuppressed: !!card.closest("[data-focusfeed-preview-suppressed]"),
      display: css.display, visibility: css.visibility, pointerEvents: css.pointerEvents, cursor: css.cursor,
      previewSurfaces: Array.from(card.querySelectorAll("#inline-preview-player, #video-preview, ytd-video-preview, ytd-moving-thumbnail-renderer, video"))
        .slice(0, 3).map(node => ({ ...tag(node), suppressed: node.hasAttribute("data-focusfeed-preview-suppressed"),
          visibility: getComputedStyle(node).visibility, paused: node.localName === "video" ? node.paused : undefined })) };
  }
  function sampleTransitions(reason = "poll") {
    if (!running) return;
    const cards = new Set([...Array.from(document.querySelectorAll(CARDS)).slice(0, 160).map(rootCard).filter(Boolean), ...watched]);
    for (const card of cards) {
      const next = sampleCard(card), previous = samples.get(card);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) {
        push("transitions", { at: Date.now(), reason, before: previous || null, after: next }); samples.set(card, next);
      }
    }
  }
  function watchCard(node) {
    const card = rootCard(node);
    if (!card) throw new Error("Inspect a video card title, thumbnail or creator, then run FFProbe.watch($0).");
    watched.add(card); if (watched.size > 20) watched.delete(watched.values().next().value);
    sampleTransitions("watch"); return cardInfo(card, true);
  }
  function pageInfo() {
    const root = document.documentElement;
    return { url: safeURL(location.href), title: clip(document.title), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY: window.scrollY || 0 },
      loading: { overlays: document.querySelectorAll(".focusfeed-card-loading").length,
        progress: appearance(document.querySelector(".focusfeed-feed-progress")),
        message: clip(document.querySelector(".focusfeed-feed-progress")?.textContent),
        reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches },
      theme: { htmlDark: root.hasAttribute("dark"), systemDark: typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches,
        html: appearance(root), body: appearance(document.body), app: appearance(document.querySelector("ytd-app")) },
      extension: { focusHome: !!document.querySelector("[data-focusfeed-focus-source]"), hiddenCards: document.querySelectorAll("[data-focusfeed-auto-hidden]").length,
        pendingCards: document.querySelectorAll("[data-focusfeed-auto-pending]").length, menuRows: document.querySelectorAll(".focusfeed-menu-action").length,
        focusWithheld: document.querySelectorAll("[data-focusfeed-focus-withheld]").length,
        focusDialogOpen: !!document.querySelector("dialog.focusfeed-discovery[open]"),
        hideShorts: root.hasAttribute("data-focusfeed-hide-shorts"), feedStatus: clip(document.querySelector(".focusfeed-focus-status")?.textContent) } };
  }
  function capture(label = "manual") {
    if (!data) return null;
    const candidates = [...new Set(Array.from(document.querySelectorAll(CARDS)).slice(0, 160).map(rootCard).filter(Boolean))];
    const shown = candidates.filter(visible).slice(0, 6);
    const withheldCards = candidates.filter(node => node.hasAttribute("data-focusfeed-focus-withheld")).slice(0, 2);
    let playerDetails = null;
    try { const v = window.ytInitialPlayerResponse?.videoDetails;
      if (v) playerDetails = { videoId: v.videoId, channelId: v.channelId, author: clip(v.author), title: clip(v.title) };
    } catch (_) {}
    const snapshot = { at: Date.now(), label: clip(label), page: pageInfo(), cardCount: candidates.length,
      cards: shown.map((card, index) => cardInfo(card, index < 2)), withheldCards: withheldCards.map(card => cardInfo(card)),
      watchedCards: Array.from(watched).map(card => cardInfo(card)), watch: watchInfo(),
      menus: Array.from(document.querySelectorAll(MENUS)).filter(visible).slice(0, 4).map(menuInfo),
      media: Array.from(document.querySelectorAll("video")).slice(0, 8).map(mediaInfo), playerDetails };
    push("snapshots", snapshot); return snapshot;
  }
  function inspect(node) {
    if (!node || node.nodeType !== 1) throw new Error("Select the problematic element with Inspect, then run FFProbe.inspect($0).");
    const card = rootCard(node), result = { at: Date.now(), url: safeURL(location.href), selected: appearance(node),
      ancestors: [], structure: structure(node, 180), card: cardInfo(card, true), watch: watchInfo() };
    result.selectedOutsideRecommendationCard = !card;
    if (!card) console.info("Selected element is outside a recommendation card. Main Watch metadata is recorded separately in watch.");
    if (result.card) result.initialData = initialDataMatches(result.card.videoId);
    let parent = node.parentElement;
    for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) result.ancestors.push(appearance(parent));
    push("inspections", result); return result;
  }
  function recordEvent(event) {
    if (!running || !event.target?.closest) return;
    const card = rootCard(event.target);
    if (event.type === "pointerover") {
      if (!card || (lastHover === card && Date.now() - lastHoverAt < 1000)) return;
      lastHover = card; lastHoverAt = Date.now();
    }
    if (event.type === "keydown" && !["Enter", " ", "Escape", "Tab", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    const trigger = event.target.closest("ytd-menu-renderer, yt-button-shape, button, [role='button'], yt-icon-button");
    const activating = event.type === "click" || event.type === "keydown" && ["Enter", " "].includes(event.key);
    if (activating && trigger && !trigger.closest(MENUS)) {
      const ancestors = []; let parent = trigger;
      for (let i = 0; parent && i < 8; i++, parent = parent.parentElement) ancestors.push(tag(parent));
      push("menuTriggers", { at: Date.now(), type: event.type, trigger: appearance(trigger), ancestors,
        card: card ? cardInfo(card) : null, watch: !card ? watchInfo() : null, structure: structure(trigger, 70) });
    }
    if (["click", "keydown"].includes(event.type) && !card && !trigger && !event.target.closest(MENUS + ", .focusfeed-toast, .focusfeed-playback")) return;
    push("events", { at: Date.now(), type: event.type, key: event.type === "keydown" ? event.key : undefined,
      target: tag(event.target), card: card ? { ...tag(card), nodeID: nodeID(card), videoId: cardInfo(card).videoId } : null,
      media: event.target.localName === "video" ? mediaInfo(event.target) : undefined });
    if (event.type === "pointerover" || event.type === "click") {
      if (card) { watched.add(card); if (watched.size > 20) watched.delete(watched.values().next().value); }
      sampleTransitions(event.type);
      clearTimeout(menuTimer); menuTimer = setTimeout(() => { if (running) capture(event.type === "pointerover" ? "after-hover" : "after-click"); }, 450);
    }
  }
  function checkMenus() {
    if (!running) return;
    const menus = Array.from(document.querySelectorAll(MENUS)).filter(visible);
    const signature = JSON.stringify(menus.map(menu => [clip(menu.textContent), ...Array.from(menu.querySelectorAll("button")).map(button => button.disabled)]));
    if (signature !== lastMenu) { lastMenu = signature; capture(menus.length ? "menu-changed" : "menu-closed"); }
  }
  function checkLoading() {
    const signature = JSON.stringify([document.querySelectorAll("[data-focusfeed-auto-pending]").length,
      document.querySelectorAll(".focusfeed-card-loading").length, clip(document.querySelector(".focusfeed-feed-progress")?.textContent)]);
    if (signature !== lastLoading) { lastLoading = signature; capture("loading-state"); }
  }
  function changed(mutations) {
    if (!running) return;
    for (const mutation of mutations) {
      if (mutation.type !== "attributes") continue;
      const name = mutation.attributeName, node = mutation.target;
      if (!name.startsWith("data-focusfeed-")) continue;
      const card = rootCard(node);
      push("transitions", { at: Date.now(), reason: "filter-attribute", nodeID: card ? nodeID(card) : nodeID(node),
        target: tag(node), attribute: name, oldValue: mutation.oldValue, value: node.getAttribute(name) });
    }
    // YouTube mutates the page frequently while playing previews. Bound computed-style
    // sampling to five times a second, retaining raw filter changes immediately.
    if (!transitionTimer) transitionTimer = setTimeout(() => { transitionTimer = null; sampleTransitions("mutation"); checkLoading(); }, 200);
    if (mutations.some(mutation => mutation.target.closest?.("ytd-popup-container, " + MENUS) ||
      Array.from(mutation.addedNodes || []).some(node => node.matches?.(MENUS) || node.querySelector?.(MENUS)))) checkMenus();
  }
  function listen(target, type, callback, options = true) { target.addEventListener(type, callback, options); listeners.push(() => target.removeEventListener(type, callback, options)); }
  function stop() {
    running = false; clearTimeout(menuTimer); clearTimeout(endTimer); clearTimeout(sampleTimer); clearTimeout(transitionTimer); transitionTimer = null;
    for (const remove of listeners) remove(); listeners = [];
    if (observer) observer.disconnect(); if (resources) resources.disconnect();
    return data;
  }
  function start(label = "youtube-check") {
    stop(); running = true; lastMenu = ""; lastLoading = ""; lastHover = null; lastHoverAt = 0;
    nodeIDs = new WeakMap(); nextNodeID = 0; samples = new WeakMap(); watched = new Set();
    data = { version: 5, label: clip(label), startedAt: Date.now(), userAgent: navigator.userAgent,
      scope: "Page DOM, computed styles, renderer identity fields and page-level resource timings. No cookies, storage, account tokens, fetch interception or response bodies. Service-worker network requests are not visible to this page probe.",
      limits: LIMITS, dropped: {}, snapshots: [], events: [], network: [], errors: [], inspections: [], transitions: [], menuTriggers: [] };
    for (const type of ["pointerover", "click", "keydown", "play", "playing", "pause", "loadedmetadata", "ended"]) listen(document, type, recordEvent);
    for (const type of ["yt-navigate-start", "yt-navigate-finish", "popstate"]) listen(window, type, () => capture(type));
    listen(window, "error", event => push("errors", { at: Date.now(), type: "error", message: clip(event.message), file: safeURL(event.filename || ""), line: event.lineno }));
    listen(window, "unhandledrejection", event => push("errors", { at: Date.now(), type: "rejection", message: clip(event.reason?.message || typeof event.reason) }));
    listen(window, "pagehide", stop);
    observer = new MutationObserver(changed);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeOldValue: true, attributeFilter: ["hidden", "aria-hidden", "disabled", "href", "class", "style", "title",
        "data-focusfeed-auto-hidden", "data-focusfeed-auto-pending", "data-focusfeed-focus-withheld", "data-focusfeed-preview-suppressed",
        "data-focusfeed-thumbnail-loading", "aria-busy", "inert"] });
    function poll() { if (running) { sampleTransitions(); sampleTimer = setTimeout(poll, 1000); } }
    sampleTransitions("start"); sampleTimer = setTimeout(poll, 1000);
    if (typeof PerformanceObserver === "function") {
      resources = new PerformanceObserver(list => {
        if (!running) return;
        for (const entry of list.getEntries()) {
          let url; try { url = new URL(entry.name); } catch (_) { continue; }
          if (!/(^|\.)youtube\.com$/.test(url.hostname) || !/\/youtubei\/|\/oembed|\/watch|\/shorts\//.test(url.pathname)) continue;
          push("network", { at: Date.now(), origin: url.origin, path: url.pathname, initiator: entry.initiatorType,
            durationMs: Math.round(entry.duration), responseStatus: entry.responseStatus || undefined });
        }
      });
      try { resources.observe({ type: "resource" }); } catch (_) { resources.disconnect(); }
    }
    endTimer = setTimeout(stop, 5 * 60000);
    capture("start"); console.info("FFProbe started:", data.label, "— hover cards, open menus, then FFProbe.download(). Auto-stops after 5 minutes.");
    return { label: data.label, running };
  }
  function report() { return JSON.parse(JSON.stringify({ ...data, running, exportedAt: Date.now() })); }
  function finish() { sampleTransitions("finish"); capture("finish"); stop(); return report(); }
  function download() {
    const result = finish(), blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url;
    link.download = "focusfeed-page-" + (data.label.replace(/[^a-z0-9_-]+/gi, "-") || "capture") + "-" + Date.now() + ".json";
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return { file: link.download, snapshots: data.snapshots.length, events: data.events.length };
  }
  window.FFProbe = { start, capture, inspect, watch: watchCard, report, finish, download, stop };
  start();
})();
