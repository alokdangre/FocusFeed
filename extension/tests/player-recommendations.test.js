"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom } = require("./dom-harness");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topic = { id: "songs", text: "songs", sourceText: "songs", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
function tile(id, title, channel, variant = "suggestion") {
  const prefix = variant === "wall" ? "ytp-videowall-still" : variant === "modern" ? "ytp-modern-videowall-still" : "ytp-suggestion";
  return `<a class="${prefix === "ytp-suggestion" ? prefix + "-link" : prefix}" href="/watch?v=${id}" style="position:absolute;left:30px">
    <span class="${prefix}-image"></span>
    <span class="${prefix === "ytp-suggestion" ? prefix : prefix + "-info"}-title">${title}</span>
    <span class="${prefix === "ytp-suggestion" ? prefix : prefix + "-info"}-author">${channel}</span>
  </a>`;
}
function setup(t, mode = "general", objectives = [topic]) {
  const h = dom('<ytd-watch-flexy video-id="playing1234"><div id="player-container-outer"><div id="movie_player"><video></video><div class="html5-endscreen"></div></div></div><h1>Playing video</h1><div id="owner"><a href="/@playing">Playing creator</a></div><div id="related"></div></ytd-watch-flexy>', "/watch?v=playing1234");
  const media = h.media(h.document.querySelector("video")), calls = [], listeners = [];
  const settings = { schemaVersion: 2, revision: 1, enabled: true, hideShorts: false,
    general: { id: "general", mode: "general", version: 1, objectives },
    focus: { id: "focus", mode: "focus", version: 1, objectives }, focusSession: { active: mode === "focus" } };
  const stored = { focusfeedSettingsV2: settings, focusFeedChannelBlocksV1: [] };
  h.context.chrome = { storage: { onChanged: { addListener: fn => listeners.push(fn) }, local: { get: async () => stored } }, runtime: {
    onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
      calls.push(message.request);
      return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => ({ videoId: video.videoId,
        outcome: /song/i.test(video.title) ? "match" : "no_match", reason: "synthetic judgment",
        objectiveMatches: [{ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: /song/i.test(video.title) ? .95 : .05 }] })) } } };
    }
  } };
  function data(value) {
    const event = new h.window.Event("message"); event.source = h.window;
    event.data = { type: "FOCUSFEED_FEED_DATA", data: value }; h.window.dispatchEvent(event);
  }
  function blocks(value) {
    stored.focusFeedChannelBlocksV1 = value;
    listeners.forEach(fn => fn({ focusFeedChannelBlocksV1: { newValue: value } }, "local"));
  }
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  return { ...h, calls, media, stored, data, blocks, screen: h.document.querySelector(".html5-endscreen") };
}
function renderer(id, title, channelId, channel = "Creator") {
  return { endScreenVideoRenderer: { videoId: id, title: { simpleText: title }, shortBylineText: { runs: [
    { text: channel, navigationEndpoint: { browseEndpoint: { browseId: channelId } } }
  ] } } };
}
async function waitFor(predicate) {
  const until = performance.now() + 1800;
  while (!predicate() && performance.now() < until) await sleep(20);
  assert.ok(predicate(), "player recommendation did not receive the expected decision");
}

for (const mode of ["general", "focus"]) test(`${mode}: late player recommendations reuse sidebar judgments and react to block/undo`, async t => {
  const h = setup(t, mode);
  h.document.querySelector("#related").innerHTML = '<ytd-compact-video-renderer><a id="video-title" href="/watch?v=recSong1234">A song</a><span id="channel-name">Singer</span></ytd-compact-video-renderer>';
  h.data({ items: [renderer("recSong1234", "A song", "UCsinger123456", "Singer"), renderer("recLearn123", "A tutorial", "UCteacher12345", "Teacher")] });
  await waitFor(() => h.calls.length === 1 && !h.document.querySelector("ytd-compact-video-renderer").hasAttribute("data-focusfeed-auto-pending"));
  h.screen.innerHTML = tile("recSong1234", "A song", "Singer") + tile("recLearn123", "A tutorial", "Teacher", "modern");
  await waitFor(() => h.calls.length === 2 && !h.screen.querySelector('[href*="recLearn123"]').hasAttribute("data-focusfeed-auto-pending"));
  const song = h.screen.querySelector('[href*="recSong1234"]'), tutorial = h.screen.querySelector('[href*="recLearn123"]');
  assert.equal(song.dataset.focusfeedAutoHidden, mode === "general" ? "true" : undefined);
  assert.equal(tutorial.dataset.focusfeedAutoHidden, mode === "focus" ? "true" : undefined);
  assert.equal(h.calls.flatMap(c => c.videos).filter(v => v.videoId === "recSong1234").length, 1, "same sidebar/player input must be judged only once");
  assert.ok(h.calls.flatMap(c => c.videos).every(v => v.videoId !== "playing1234"), "the playing video must not enter topic checks");
  h.blocks([{ id: "block", scope: "global", channelId: "UCsinger123456" }, { id: "block2", scope: "global", channelId: "UCteacher12345" }]);
  await waitFor(() => song.dataset.focusfeedAutoHidden === "true" && tutorial.dataset.focusfeedAutoHidden === "true");
  h.blocks([]);
  await waitFor(() => (mode === "general" ? tutorial : song).dataset.focusfeedAutoHidden === undefined);
  assert.equal(h.calls.length, 2, "local block/undo cannot incur another classifier request");
  assert.equal(song.style.position, "absolute"); assert.equal(song.style.left, "30px");
  assert.equal(h.media.paused, false); assert.equal(h.document.querySelector(".focusfeed-playback"), null);
});

test("player-only channel metadata hides an existing tile without topics, and recycled href uses the new identity", async t => {
  const h = setup(t, "general", []);
  h.screen.innerHTML = tile("recBlocked1", "Blocked video", "Blocked creator");
  h.data({ items: [renderer("recBlocked1", "Blocked video", "UCblocked12345"), renderer("recAllowed1", "Allowed video", "UCallowed12345")] });
  h.blocks([{ id: "block", scope: "global", channelId: "UCblocked12345" }]);
  const card = h.screen.querySelector("a");
  await waitFor(() => card.dataset.focusfeedAutoHidden === "true");
  card.href = "/watch?v=recAllowed1";
  card.querySelector(".ytp-suggestion-title").textContent = "Allowed video";
  await waitFor(() => card.dataset.focusfeedAutoHidden === undefined);
  assert.equal(h.calls.length, 0); assert.equal(h.media.paused, false);
});

test("player DOM-only title and author support topic filtering without guessing a channel ID", async t => {
  const h = setup(t);
  h.screen.innerHTML = tile("domSong1234", "A song", "Singer", "wall");
  const card = h.screen.querySelector("a");
  await waitFor(() => card.dataset.focusfeedAutoHidden === "true");
  assert.equal(h.calls[0].videos[0].title, "A song");
  assert.equal(h.calls[0].videos[0].channel, "Singer");
  assert.equal(h.calls[0].videos[0].channelId, undefined, "a plain author name cannot establish channel identity");
});

test("player tile reuses a channel verified on the same sidebar video without an API renderer", async t => {
  const h = setup(t, "general", []);
  h.document.querySelector("#related").innerHTML = '<ytd-compact-video-renderer><a id="video-title" href="/watch?v=shared12345">A tutorial</a><a href="/@teacher">Teacher</a></ytd-compact-video-renderer>';
  await sleep(150);
  h.screen.innerHTML = tile("shared12345", "A tutorial", "Teacher", "modern");
  h.blocks([{ id: "block", scope: "global", channelId: "@teacher" }]);
  const card = h.screen.querySelector("a");
  await waitFor(() => card.dataset.focusfeedAutoHidden === "true");
  assert.equal(h.calls.length, 0);
});

test("end-screen collection uses its playlist identity, never the blocked seed channel", async t => {
  const h = setup(t);
  h.screen.innerHTML = tile("recSeed1234", "Mix - Songs", "Singer").replace("recSeed1234\"", "recSeed1234&list=RDSongs123\"");
  const card = h.screen.querySelector("a");
  h.data({ items: [renderer("recSeed1234", "Seed song", "UCsinger123456", "Singer"),
    { endScreenPlaylistRenderer: { playlistId: "RDSongs123", title: { simpleText: "Mix - Songs" } } }] });
  h.blocks([{ id: "block", scope: "global", channelId: "UCsinger123456" }]);
  await waitFor(() => card.dataset.focusfeedAutoHidden === "true");
  const inputs = h.calls.flatMap(c => c.videos);
  assert.equal(inputs.length, 1); assert.equal(inputs[0].videoId, "collection:RDSongs123");
  assert.equal(inputs[0].itemType, "collection"); assert.equal(inputs[0].title, "Mix - Songs");
  assert.equal(inputs[0].channel, "");
});

test("autonav recommendation is checked separately from the current video", async t => {
  const h = setup(t);
  h.screen.innerHTML = '<a class="ytp-autonav-endscreen-link-container" href="/watch?v=autonav1234"><span class="ytp-autonav-endscreen-upnext-title">A song</span><span class="ytp-autonav-endscreen-upnext-author">Singer</span></a>';
  const card = h.screen.querySelector("a");
  h.data({ endscreenElementRenderer: { style: "VIDEO", title: { simpleText: "A song" },
    endpoint: { watchEndpoint: { videoId: "autonav1234" } } } });
  await waitFor(() => card.dataset.focusfeedAutoHidden === "true");
  assert.equal(h.calls[0].videos[0].videoId, "autonav1234"); assert.equal(h.media.paused, false);
});
