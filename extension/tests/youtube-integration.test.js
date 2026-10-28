"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, videoCard, homePage, extract } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fs = require("node:fs"), path = require("node:path");
const nativeFixture = fs.readFileSync(path.join(__dirname, "fixtures/watch-lockups.html"), "utf8");
test("startup holds native card geometry until settings arrive, then restores a paused feed", async t => {
  const h = dom(homePage(videoCard("one"))); let finish;
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  h.context.chrome = { storage: { onChanged: { addListener() {} }, local: { get: () => new Promise(resolve => { finish = resolve; }) } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } };
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  assert.equal(h.document.documentElement.getAttribute("data-focusfeed-initializing"), "true");
  const card = h.document.querySelector("ytd-rich-item-renderer"), title = card.querySelector("#video-title-link");
  finish({ focusfeedSettingsV2: { schemaVersion: 2, revision: 1, enabled: false,
    general: { id: "general", mode: "general", version: 0, objectives: [] }, focus: { id: "focus", mode: "focus", version: 0, objectives: [] }, focusSession: { active: false } } });
  await settle();
  assert.equal(h.document.documentElement.hasAttribute("data-focusfeed-initializing"), false);
  assert.equal(card.querySelector("#video-title-link"), title); assert.equal(card.dataset.focusfeedAutoPending, undefined);
});

for (const surface of ["Home", "Watch"]) for (const mode of ["general", "focus"]) {
  test(`${surface} ${mode}: native titles, avatars, badges and metadata survive filtering and settings changes`, async t => {
    const h = dom(surface === "Home" ? homePage(nativeFixture) : nativeFixture,
      surface === "Home" ? "/" : "/watch?v=playing1234");
    t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
    const card = h.document.querySelector('[data-test="video"]'), parent = card.parentNode;
    const markup = card.innerHTML, descendants = Array.from(card.querySelectorAll("*"));
    const originalAttributes = descendants.map(node => node.outerHTML);
    const topic = { id: "intent-test", text: "Science videos", sourceText: "Science videos", contentType: "topic",
      matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
    const settings = { schemaVersion: 2, revision: 1, enabled: true, hideShorts: false,
      general: { id: "general", mode: "general", version: 1, objectives: [topic] },
      focus: { id: "focus", mode: "focus", version: 1, objectives: [topic] }, focusSession: { active: mode === "focus" } };
    const stored = { focusfeedSettingsV2: settings, focusFeedChannelBlocksV1: [] }, listeners = [];
    h.context.chrome = { storage: { onChanged: { addListener: fn => listeners.push(fn) },
      local: { get: async defaults => ({ ...defaults, ...stored }) } }, runtime: {
      onMessage: { addListener() {} }, sendMessage: async message => {
        if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
        return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => ({
          videoId: video.videoId, outcome: mode === "focus" ? "match" : "no_match", reason: "fixture",
          objectiveMatches: [{ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: mode === "focus" ? .95 : .05 }]
        })) } } };
      }
    } };
    function preserved() {
      assert.equal(card.parentNode, parent);
      assert.equal(card.innerHTML, markup, "native content and styling attributes must not be rewritten");
      const current = Array.from(card.querySelectorAll("*"));
      assert.equal(current.length, descendants.length);
      descendants.forEach((node, index) => {
        assert.equal(current[index], node, "native nodes must not be reconstructed or moved");
        assert.equal(node.outerHTML, originalAttributes[index]);
      });
      assert.ok(card.querySelector('.ytSpecAvatarShapeHost img'));
      assert.ok(card.querySelector('[aria-label="Verified"]'));
      assert.match(card.textContent, /230K views.*2 hours ago/s);
      assert.equal(h.document.querySelector(".focusfeed-home, .focusfeed-card, .focusfeed-more"), null);
    }
    function change(key) { listeners.forEach(fn => fn({ [key]: { newValue: stored[key] } }, "local")); }
    h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
    await sleep(350);
    assert.equal(card.dataset.focusfeedAutoPending, undefined);
    assert.equal(card.dataset.focusfeedAutoHidden, undefined); preserved();
    // Supply a verified identity, block it, then undo without replacing the native card.
    const event = new h.window.Event("message"); event.source = h.window;
    event.data = { type: "FOCUSFEED_FEED_DATA", data: { videoRenderer: { videoId: "abcdefghijk",
      title: { simpleText: "Captured video" }, ownerText: { runs: [{ text: "Captured Creator",
        navigationEndpoint: { browseEndpoint: { browseId: "UCcaptured12345" } } }] } } } };
    h.window.dispatchEvent(event); await sleep(350);
    stored.focusFeedChannelBlocksV1 = [{ id: "block", scope: "global", channelId: "UCcaptured12345" }];
    change("focusFeedChannelBlocksV1"); await sleep(350);
    assert.equal(card.dataset.focusfeedAutoHidden, "true"); preserved();
    stored.focusFeedChannelBlocksV1 = []; change("focusFeedChannelBlocksV1"); await sleep(350);
    assert.equal(card.dataset.focusfeedAutoHidden, undefined); preserved();
    settings.enabled = false; settings.revision++; change("focusfeedSettingsV2"); await sleep(350);
    assert.equal(card.dataset.focusfeedAutoHidden, undefined);
    assert.equal(card.dataset.focusfeedFocusWithheld, undefined); preserved();
  });
}
function uiSetup(t, html, pathname = "/results") {
  const h = dom(html, pathname); t.after(h.cleanup);
  const calls = [];
  h.context.chrome = { runtime: { sendMessage: async message => {
    calls.push(message); return { ok: true, data: { created: false, block: { id: "block" } } };
  } } };
  h.load("channel-policy.js", "preview-controller.js", "youtube-ui.js");
  const ui = h.context.FocusFeedYouTubeUI.create({ extract, lookup: () => null });
  ui.setRuntime({ reload: async () => {}, tick() {} });
  h.document.querySelectorAll("video").forEach(h.media);
  ui.configure({ enabled: true, hideShorts: false }); t.after(ui.stop);
  return { ...h, ui, calls };
}
test("filtering a native recommendation pauses media without adding a placeholder and can be reversed", t => {
  const h = uiSetup(t, videoCard("one")); const card = h.document.querySelector("ytd-rich-item-renderer");
  const media = h.media(h.document.createElement("video")); card.appendChild(media);
  const parent = card.parentNode;
  h.ui.render(card, extract(card), "hide", "model");
  assert.equal(media.paused, true); assert.equal(card.parentNode, parent);
  assert.equal(card.dataset.focusfeedAutoHidden, "true");
  assert.equal(card.querySelector(".focusfeed-native-placeholder"), null);
  assert.doesNotMatch(card.textContent, /Video filtered|Show once/);
  h.ui.render(card, extract(card), "show");
  assert.equal(card.dataset.focusfeedAutoHidden, undefined);
  h.ui.render(card, extract(card), "hide", "channel_block");
  h.ui.clear(); assert.equal(card.dataset.focusfeedAutoHidden, undefined);
});
test("global hover previews are stopped on play/playing and allowed Watch media is untouched", t => {
  const h = uiSetup(t, '<div id="inline-preview-player"><video></video></div><ytd-watch-flexy><div id="player-container-outer"><video></video></div></ytd-watch-flexy>', "/watch?v=one");
  const preview = h.media(h.document.querySelector("#inline-preview-player video"));
  const watch = h.media(h.document.querySelector("ytd-watch-flexy video"));
  preview.dispatchEvent(new h.window.Event("play", { bubbles: true }));
  assert.equal(preview.paused, true); assert.equal(watch.paused, false);
  preview.paused = false; preview.dispatchEvent(new h.window.Event("playing", { bubbles: true })); assert.equal(preview.paused, true);
  assert.equal(h.document.querySelector("#inline-preview-player").dataset.focusfeedPreviewSuppressed, undefined, "the native thumbnail container stays visible");
  assert.equal(preview.dataset.focusfeedPreviewSuppressed, "true");
  h.ui.configure({ enabled: false });
  preview.paused = false; preview.dispatchEvent(new h.window.Event("play", { bubbles: true })); assert.equal(preview.paused, false);
  assert.equal(h.document.querySelector("#inline-preview-player").hasAttribute("data-focusfeed-preview-suppressed"), false);
});
test("native cards keep one YouTube overflow control, with Block channel inside its existing menu", async t => {
  const h = uiSetup(t, videoCard("one") + '<ytd-popup-container><ytd-menu-popup-renderer><div id="items"><button>Save to playlist</button></div></ytd-menu-popup-renderer></ytd-popup-container>');
  const card = h.document.querySelector("ytd-rich-item-renderer");
  h.ui.render(card, extract(card), "show");
  assert.equal(card.querySelectorAll("button").length, 1);
  assert.equal(card.querySelector(".focusfeed-native-actions"), null);
  card.querySelector("#video-title-link").setAttribute("href", "/watch?v=two");
  card.querySelector('a[href^="/@"]').setAttribute("href", "/@two");
  card.querySelector("ytd-menu-renderer button").click(); await settle();
  const menu = h.document.querySelector("ytd-menu-popup-renderer");
  assert.equal(menu.querySelectorAll("button").length, 2, "preserve YouTube actions and add one block row");
  menu.querySelector(".focusfeed-menu-action").click(); await settle();
  assert.equal(h.calls[0].channel.channelId, "@two");
});
test("late native menu insertion is observed, and a stale menu cannot block a recycled video's channel", async t => {
  const h = uiSetup(t, videoCard("one") + "<ytd-popup-container></ytd-popup-container>");
  const card = h.document.querySelector("ytd-rich-item-renderer"); h.ui.render(card, extract(card), "show");
  card.querySelector("ytd-menu-renderer button").click(); await settle();
  h.document.querySelector("ytd-popup-container").innerHTML = '<ytd-menu-popup-renderer><div id="items"></div></ytd-menu-popup-renderer>';
  await settle();
  const injected = h.document.querySelector(".focusfeed-menu-action"); assert.ok(injected);
  card.querySelector("#video-title-link").setAttribute("href", "/watch?v=two");
  injected.click(); await settle(); assert.equal(h.calls.length, 0);
  assert.match(h.document.querySelector(".focusfeed-toast").textContent, /changed/);
});
test("Home uses the original YouTube overflow component and injects Block channel into its native popup", async t => {
  const h = dom(homePage(videoCard("one")) + "<ytd-popup-container></ytd-popup-container>"); t.after(h.cleanup);
  const nativeCard = h.document.querySelector("ytd-rich-item-renderer"), nativeMenu = nativeCard.querySelector("ytd-menu-renderer");
  const calls = [];
  h.context.chrome = { runtime: { sendMessage: async message => {
    calls.push(message); return { ok: true, data: { created: false, block: { id: "block" } } };
  } } };
  h.load("video-model.js", "channel-policy.js", "settings.js", "home-feed.js", "youtube-ui.js");
  const ui = h.context.FocusFeedYouTubeUI.create({ extract, lookup: () => null }); t.after(ui.stop);
  ui.setRuntime({ observe: (target, video) => ui.render(target, video, "show", "model"), reload: async () => {}, tick() {} });
  ui.configure({ enabled: true, hideShorts: false }); ui.scanHome(extract); await settle();
  const card = nativeCard;
  assert.equal(h.document.querySelector(".focusfeed-card, .focusfeed-more"), null);
  assert.equal(card.querySelector("ytd-menu-renderer"), nativeMenu);
  assert.equal(card.querySelectorAll("button").length, 1);
  assert.equal(card.querySelector("details"), null);
  nativeMenu.querySelector("button").addEventListener("click", () => {
    h.document.querySelector("ytd-popup-container").innerHTML = '<ytd-menu-popup-renderer><div id="items"><button>Save to playlist</button></div></ytd-menu-popup-renderer>';
  });
  nativeMenu.querySelector("button").click(); await settle();
  const popup = h.document.querySelector("ytd-menu-popup-renderer");
  assert.equal(popup.querySelectorAll("button").length, 2);
  assert.match(popup.textContent, /Save to playlist.*Block channel/);
  // A recycled native card must invalidate its already-open menu.
  const action = popup.querySelector(".focusfeed-menu-action");
  nativeCard.querySelector("#video-title-link").setAttribute("href", "/watch?v=two");
  action.click(); await settle(); assert.equal(calls.length, 0);
  nativeCard.querySelector("#video-title-link").setAttribute("href", "/watch?v=one");
  nativeMenu.querySelector("button").click(); await settle();
  h.document.querySelector(".focusfeed-menu-action").click(); await settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].type, "FF_BLOCK_ADD");
  assert.equal(calls[0].channel.channelId, "@one");
  ui.configure({ enabled: false });
  assert.equal(nativeCard.querySelector("ytd-menu-renderer"), nativeMenu, "pause restores the same native component");
});
test("Shorts playback uses a reversible display setting rather than a Watch once bypass", async t => {
  const h = uiSetup(t, '<ytd-reel-video-renderer is-active><video></video></ytd-reel-video-renderer>', "/shorts/one");
  const surface = h.document.querySelector("ytd-reel-video-renderer"), media = h.media(surface.querySelector("video"));
  h.ui.render(surface, { videoId: "one", isShort: true }, "hide", "shorts_block");
  assert.equal(media.paused, true);
  const overlay = surface.querySelector(".focusfeed-playback"); assert.ok(overlay); assert.equal(overlay.parentNode, surface);
  assert.match(overlay.textContent, /Shorts are hidden/);
  overlay.querySelector("button").click(); await settle();
  assert.equal(h.calls[0].type, "FF_SETTINGS_UPDATE"); assert.equal(h.calls[0].action.type, "setHideShorts");
  assert.equal(h.calls[0].action.enabled, false);
});
for (const mode of ["general", "focus"]) {
  test(`${mode}: opening an approved recommendation does not recheck or interrupt playback`, async t => {
    const h = uiSetup(t, videoCard("approved") + '<ytd-watch-flexy><div id="player-container-outer"><video></video></div></ytd-watch-flexy>', "/watch?v=approved");
    h.load("video-model.js", "settings.js", "auto-runtime.js");
    const topic = { id: "topic.gaming", text: "Gaming", contentType: "topic", taxonomyId: "topic.gaming", taxonomyVersion: "focusfeed-topics-v1" };
    const profile = mode => ({ id: mode, mode, version: 1, objectives: [topic] });
    const prefs = { focusfeedSettingsV2: { schemaVersion: 2, revision: 1, enabled: true,
      general: profile("general"), focus: profile("focus"), focusSession: { active: mode === "focus" } } };
    const apiCalls = [];
    h.context.chrome.storage = { local: { get: async () => prefs } };
    h.context.chrome.runtime.sendMessage = async message => {
      apiCalls.push(message);
      return { ok: true, data: { ok: true, data: { assessments: (message.request && message.request.videos || []).map(v => ({ videoId: v.videoId,
        outcome: mode === "focus" ? "match" : "no_match", reason: "fixture",
        objectiveMatches: [{ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: mode === "focus" ? .9 : .1 }] })) } } };
    };
    const source = h.document.querySelector("ytd-rich-item-renderer"), surface = h.document.querySelector("#player-container-outer");
    const media = h.media(surface.querySelector("video"));
    let watching = false, runtime;
    const video = { videoId: "approved", title: "Approved video", channelId: "@approved" };
    runtime = h.context.FocusFeedAutoRuntime.create({
      scan() { runtime.observe(watching ? surface : source, Object.assign({}, video, { playback: watching })); },
      render: h.ui.render, clear: h.ui.clear,
    }, h.context.chrome);
    h.ui.setRuntime(runtime); t.after(runtime.stop);
    await runtime.reload(); await sleep(330);
    assert.equal(source.dataset.focusfeedAutoHidden, undefined);
    assert.equal(apiCalls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 1);
    runtime.navigate(true); watching = true; runtime.navigate(false); await sleep(20);
    assert.equal(media.paused, false, "already approved video should play without a second gate");
    assert.equal(surface.querySelector(".focusfeed-playback"), null);
    // Direct links, fresh player metadata, periodic scans, and provider errors must not gate manual playback either.
    video.videoId = "direct"; video.title = ""; h.location.search = "?v=direct"; runtime.tick();
    await sleep(330);
    assert.equal(apiCalls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 1);
    h.ui.render(surface, video, "pending", "model_pending");
    h.ui.render(surface, video, "hide", "unavailable");
    assert.equal(media.paused, false); assert.equal(surface.querySelector(".focusfeed-playback"), null);
  });
}
test("the manifest's complete content pipeline renders a stable filtered Home and restores native UI on pause", async t => {
  const h = dom(homePage(videoCard("one") + videoCard("two"))); t.after(h.cleanup);
  h.document.querySelector("ytd-rich-item-renderer").className = "content-id-stale";
  const topic = { id: "topic.gaming", taxonomyId: "topic.gaming", taxonomyVersion: "focusfeed-topics-v1", text: "Gaming", contentType: "topic" };
  const prefs = { focusfeedSettingsV2: { schemaVersion: 2, revision: 1, enabled: true, hideShorts: false,
    general: { id: "general", version: 1, mode: "general", objectives: [topic] },
    focus: { id: "focus", version: 0, mode: "focus", objectives: [] }, focusSession: { active: false } } };
  const storageListeners = [], contentListeners = [], calls = [];
  h.context.chrome = { storage: { onChanged: { addListener: fn => storageListeners.push(fn) },
    local: { get: async defaults => Object.assign({}, defaults, prefs) } }, runtime: {
    onMessage: { addListener: fn => contentListeners.push(fn) },
    sendMessage: async message => {
      calls.push(message);
      if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
      return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => ({ videoId: video.videoId,
        outcome: video.videoId === "one" ? "no_match" : "match", reason: "fixture",
        objectiveMatches: [{ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: video.videoId === "one" ? .1 : .9 }] })) } } };
    }
  } };
  const manifest = require("../manifest.json");
  h.load(...manifest.content_scripts.find(group => group.world === "ISOLATED").js);
  await sleep(350);
  const card = h.document.querySelector('[data-id="one"]'), other = h.document.querySelector('[data-id="two"]');
  const originalParent = card.parentNode;
  assert.equal(card.dataset.focusfeedAutoHidden, undefined); assert.equal(other.dataset.focusfeedAutoHidden, "true");
  assert.equal(h.document.querySelector(".focusfeed-card, .focusfeed-more, .focusfeed-home"), null);
  assert.equal(calls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 1);
  const event = new h.window.Event("message"); event.source = h.window;
  event.data = { type: "FOCUSFEED_FEED_DATA", data: { videoRenderer: { videoId: "one", title: { simpleText: "Video one" },
    ownerText: { runs: [{ text: "Canonical channel", navigationEndpoint: { browseEndpoint: { browseId: "UCcanonical12345" } } }] } } } };
  h.window.dispatchEvent(event); await sleep(350);
  assert.ok(h.document.querySelector('[data-id="one"]') === card);
  assert.ok(card.parentNode === originalParent);
  assert.equal(card.querySelector("#video-title-link").textContent, "Video one", "native presentation is untouched");
  prefs.focusfeedSettingsV2.enabled = false; prefs.focusfeedSettingsV2.revision++;
  storageListeners.forEach(fn => fn({ focusfeedSettingsV2: { newValue: prefs.focusfeedSettingsV2 } }, "local"));
  await sleep(330);
  assert.equal(h.document.querySelector(".focusfeed-home"), null);
  assert.equal(other.dataset.focusfeedAutoHidden, undefined);
  h.window.dispatchEvent(new h.window.Event("pagehide"));
});

test("a custom Focus goal survives Home discovery and filters native search results", async t => {
  const h = dom(homePage(Array.from({ length: 48 }, (_, i) => videoCard("home" + i)).join(""))); t.after(h.cleanup);
  const objective = { id: "intent-dsa", text: "DSA tutorials", sourceText: "DSA tutorials", contentType: "topic",
    matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
  const prefs = { focusfeedSettingsV2: { schemaVersion: 2, revision: 1, enabled: true,
    general: { id: "general", mode: "general", version: 0, objectives: [] },
    focus: { id: "focus", mode: "focus", version: 1, objectives: [objective] }, focusSession: { active: true } } };
  const calls = [];
  h.context.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async defaults => ({ ...defaults, ...prefs }) } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
      calls.push(message); if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
      return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => ({
        videoId: video.videoId, outcome: video.videoId === "matching" ? "match" : "no_match", reason: "authored fixture",
        objectiveMatches: [{ objectiveId: objective.id, text: objective.text, contentType: "topic", matchProbability: video.videoId === "matching" ? .95 : .05 }]
      })) } } };
    } } };
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  async function waitFor(predicate) {
    const deadline = performance.now() + 3000;
    while (!predicate() && performance.now() < deadline) await sleep(20);
    assert.ok(predicate(), "content pipeline did not settle before the deadline");
  }
  await waitFor(() => h.document.querySelector("dialog.focusfeed-discovery")?.hasAttribute("open"));
  const discovery = h.document.querySelector("dialog.focusfeed-discovery");
  assert.equal(h.document.querySelector(".focusfeed-more"), null);
  assert.equal(calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 4);
  await sleep(350); assert.equal(calls.filter(c => c.type === "FF_AUTO_CLASSIFY").length, 4);
  discovery.querySelector("button").click(); await settle(); assert.ok(calls.some(c => c.type === "FF_OPEN_PREFERENCES"));
  const destination = discovery.querySelector("a").getAttribute("href");
  h.window.dispatchEvent(new h.window.Event("yt-navigate-start"));
  h.location.href = new URL(destination, h.location).href;
  h.document.body.innerHTML = videoCard("matching") + videoCard("unrelated");
  h.window.dispatchEvent(new h.window.Event("yt-navigate-finish"));
  await waitFor(() => h.document.querySelector('[data-id="unrelated"]').dataset.focusfeedAutoHidden === "true");
  const matching = h.document.querySelector('[data-id="matching"]'), unrelated = h.document.querySelector('[data-id="unrelated"]');
  assert.equal(matching.dataset.focusfeedAutoHidden, undefined);
  assert.equal(unrelated.dataset.focusfeedAutoHidden, "true");
  const searches = calls.filter(c => c.type === "FF_AUTO_CLASSIFY");
  assert.equal(searches.length, 5);
  assert.ok(searches.every(c => c.request.profile.mode === "focus" && c.request.profile.objectives[0].text === "DSA tutorials"));
  assert.equal(prefs.focusfeedSettingsV2.focusSession.active, true);
  h.window.dispatchEvent(new h.window.Event("pagehide"));
});

for (const mode of ["general", "focus"]) test(`${mode}: a music Mix is classified as a collection independently of its seed video`, async t => {
  const markup = nativeFixture.replace("My Mix", "Mix - Songs");
  const h = dom(homePage(markup)); t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  const objective = { id: "intent-songs", text: "songs", sourceText: "songs", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
  const settings = { schemaVersion: 2, revision: 1, enabled: true,
    general: { id: "general", mode: "general", version: 1, objectives: [objective] },
    focus: { id: "focus", mode: "focus", version: 1, objectives: [objective] }, focusSession: { active: mode === "focus" } };
  const calls = [];
  h.context.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async () => ({ focusfeedSettingsV2: settings }) } }, runtime: {
    onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
      calls.push(message.request);
      return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => ({ videoId: video.videoId,
        outcome: video.itemType === "collection" ? "match" : "no_match", reason: "fixture",
        objectiveMatches: [{ objectiveId: objective.id, text: objective.text, contentType: "topic", matchProbability: video.itemType === "collection" ? .95 : .05 }]
      })) } } };
    }
  } };
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  if (mode === "general") {
    const event = new h.window.Event("message"); event.source = h.window;
    event.data = { type: "FOCUSFEED_FEED_DATA", data: { playlistRenderer: { playlistId: "RDMM", title: { simpleText: "Mix - Songs" },
      videos: [{ childVideoRenderer: { title: { simpleText: "Listed song" }, shortBylineText: { simpleText: "Listed singer" } } }] } } };
    h.window.dispatchEvent(event);
  }
  await sleep(350);
  const mix = h.document.querySelector('[data-test="mix"]'), video = h.document.querySelector('[data-test="video"]');
  assert.equal(mix.dataset.focusfeedAutoHidden, mode === "general" ? "true" : undefined);
  assert.equal(video.dataset.focusfeedAutoHidden, mode === "focus" ? "true" : undefined);
  const items = calls.flatMap(c => c.videos);
  assert.equal(items.length, 2); assert.ok(items.some(v => v.videoId === "abcdefghijk"));
  const collection = items.find(v => v.itemType === "collection");
  assert.equal(collection.videoId, "collection:RDMM"); assert.equal(collection.collectionId, "RDMM");
  assert.equal(collection.channelId, undefined);
  assert.equal(collection.entries.length, mode === "general" ? 1 : 0);
  if (mode === "general") assert.equal(collection.entries[0].title, "Listed song");
  assert.equal(mix.querySelector("a").getAttribute("href"), "/watch?v=abcdefghijk&list=RDMM");
});
