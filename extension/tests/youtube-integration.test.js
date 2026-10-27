"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, videoCard, homePage, extract } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function uiSetup(t, html, pathname = "/results") {
  const h = dom(html, pathname); t.after(h.cleanup);
  const calls = [], restored = [];
  h.context.chrome = { runtime: { sendMessage: async message => {
    calls.push(message); return { ok: true, data: { created: false, block: { id: "block" } } };
  } } };
  h.load("channel-policy.js", "preview-controller.js", "youtube-ui.js");
  const ui = h.context.FocusFeedYouTubeUI.create({ extract, lookup: () => null });
  ui.setRuntime({ reload: async () => {}, tick() {}, restore: id => restored.push(id) });
  h.document.querySelectorAll("video").forEach(h.media);
  ui.configure({ enabled: true, hideShorts: false }); t.after(ui.stop);
  return { ...h, ui, calls, restored };
}
test("hiding a native recommendation pauses media and retains the original native element", t => {
  const h = uiSetup(t, videoCard("one")); const card = h.document.querySelector("ytd-rich-item-renderer");
  const media = h.media(h.document.createElement("video")); card.appendChild(media);
  const parent = card.parentNode;
  h.ui.render(card, extract(card), "hide", "model");
  assert.equal(media.paused, true); assert.equal(card.parentNode, parent);
  assert.equal(card.dataset.focusfeedAutoHidden, "true");
  assert.match(card.querySelector(".focusfeed-native-placeholder").textContent, /filtered/);
  card.querySelector(".focusfeed-native-placeholder button").click(); assert.deepEqual(h.restored, ["one"]);
});
test("global hover previews are stopped on play/playing and allowed Watch media is untouched", t => {
  const h = uiSetup(t, '<div id="inline-preview-player"><video></video></div><ytd-watch-flexy><div id="player-container-outer"><video></video></div></ytd-watch-flexy>', "/watch?v=one");
  const preview = h.media(h.document.querySelector("#inline-preview-player video"));
  const watch = h.media(h.document.querySelector("ytd-watch-flexy video"));
  preview.dispatchEvent(new h.window.Event("play", { bubbles: true }));
  assert.equal(preview.paused, true); assert.equal(watch.paused, false);
  preview.paused = false; preview.dispatchEvent(new h.window.Event("playing", { bubbles: true })); assert.equal(preview.paused, true);
  assert.equal(h.document.querySelector("#inline-preview-player").dataset.focusfeedPreviewSuppressed, "true");
  h.ui.configure({ enabled: false });
  preview.paused = false; preview.dispatchEvent(new h.window.Event("play", { bubbles: true })); assert.equal(preview.paused, false);
  assert.equal(h.document.querySelector("#inline-preview-player").hasAttribute("data-focusfeed-preview-suppressed"), false);
});
test("native fallback menu binds to the current video after a renderer is recycled", async t => {
  const h = uiSetup(t, videoCard("one")), card = h.document.querySelector("ytd-rich-item-renderer");
  h.ui.render(card, extract(card), "show");
  card.querySelector("#video-title-link").setAttribute("href", "/watch?v=two");
  card.querySelector('a[href^="/@"]').setAttribute("href", "/@two");
  card.querySelector(".focusfeed-native-actions button").click(); await settle();
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
test("Shorts playback uses a reversible display setting rather than a Watch once bypass", async t => {
  const h = uiSetup(t, '<ytd-reel-video-renderer is-active><video></video></ytd-reel-video-renderer>', "/shorts/one");
  const surface = h.document.querySelector("ytd-reel-video-renderer"), media = h.media(surface.querySelector("video"));
  h.ui.render(surface, { videoId: "one", isShort: true }, "hide", "shorts_block");
  assert.equal(media.paused, true);
  const overlay = surface.querySelector(".focusfeed-playback"); assert.ok(overlay); assert.equal(overlay.parentNode, surface);
  assert.match(overlay.textContent, /Shorts are hidden/);
  overlay.querySelector("button").click(); await settle();
  assert.equal(h.calls[0].type, "FF_SETTINGS_UPDATE"); assert.equal(h.calls[0].action.type, "setHideShorts");
  assert.equal(h.calls[0].action.enabled, false); assert.equal(h.restored.length, 0);
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
    await runtime.reload(); await sleep(130);
    assert.equal(source.dataset.focusfeedAutoHidden, undefined);
    assert.equal(apiCalls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 1);
    runtime.navigate(true); watching = true; runtime.navigate(false); await sleep(20);
    assert.equal(media.paused, false, "already approved video should play without a second gate");
    assert.equal(surface.querySelector(".focusfeed-playback"), null);
    // Direct links, fresh player metadata, periodic scans, and provider errors must not gate manual playback either.
    video.videoId = "direct"; video.title = ""; h.location.search = "?v=direct"; runtime.tick();
    await sleep(130);
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
  await sleep(160);
  const card = h.document.querySelector(".focusfeed-card"); assert.ok(card); assert.equal(card.dataset.videoId, "one");
  assert.equal(h.document.querySelectorAll(".focusfeed-card").length, 1);
  assert.equal(calls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 1);
  // Exercise normal metadata observation without another classification or repaint loop.
  h.document.querySelector("#video-title-link").setAttribute("title", "Updated attribute"); await sleep(160);
  assert.equal(h.document.querySelector(".focusfeed-card"), card);
  assert.equal(calls.filter(m => m.type === "FF_AUTO_CLASSIFY").length, 1);
  const event = new h.window.Event("message"); event.source = h.window;
  event.data = { type: "FOCUSFEED_FEED_DATA", endpoint: "fixture", data: { videoRenderer: { videoId: "one", title: { simpleText: "Canonical title" },
    ownerText: { runs: [{ text: "Canonical channel", navigationEndpoint: { browseEndpoint: { browseId: "UCcanonical12345" } } }] } } } };
  h.window.dispatchEvent(event); await sleep(160);
  const current = h.document.querySelector(".focusfeed-card");
  assert.equal(current.dataset.videoId, "one"); assert.equal(current.querySelector(".focusfeed-card-title").textContent, "Canonical title");
  assert.equal(current.querySelector("a").getAttribute("href"), "/watch?v=one");
  assert.equal(current.querySelector(".focusfeed-card-channel").textContent, "Canonical channel");
  prefs.focusfeedSettingsV2.enabled = false; prefs.focusfeedSettingsV2.revision++;
  storageListeners.forEach(fn => fn({ focusfeedSettingsV2: { newValue: prefs.focusfeedSettingsV2 } }, "local"));
  await sleep(130);
  assert.equal(h.document.querySelector(".focusfeed-home"), null);
  assert.equal(h.document.querySelector("[data-focusfeed-home-source]"), null);
  h.window.dispatchEvent(new h.window.Event("pagehide"));
});

test("a custom Focus goal survives Home discovery and filters native search results", async t => {
  const h = dom(homePage(Array.from({ length: 24 }, (_, i) => videoCard("home" + i)).join(""))); t.after(h.cleanup);
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
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) await sleep(20);
    assert.ok(predicate(), "content pipeline did not settle before the deadline");
  }
  await waitFor(() => h.document.querySelector(".focusfeed-more") && !h.document.querySelector(".focusfeed-more").disabled);
  assert.equal(h.document.querySelector(".focusfeed-discovery").hidden, true);
  h.document.querySelector(".focusfeed-more").click();
  await waitFor(() => !h.document.querySelector(".focusfeed-discovery").hidden);
  const discovery = h.document.querySelector(".focusfeed-discovery"); assert.equal(discovery.hidden, false);
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
  assert.equal(searches.length, 3);
  assert.ok(searches.every(c => c.request.profile.mode === "focus" && c.request.profile.objectives[0].text === "DSA tutorials"));
  assert.equal(prefs.focusfeedSettingsV2.focusSession.active, true);
  h.window.dispatchEvent(new h.window.Event("pagehide"));
});
