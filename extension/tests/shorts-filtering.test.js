"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, homePage } = require("./dom-harness");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topic = { id: "songs", text: "songs", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" };
function short(id, title, tag = "ytm-shorts-lockup-view-model-v2") {
  return `<${tag} id="${id}"><a href="/shorts/${id}"><h3>${title}</h3></a></${tag}>`;
}
function setup(t, html, pathname = "/", mode = "general", hideShorts = false, options = {}) {
  const h = dom(html, pathname), requests = [], listeners = [];
  const state = { schemaVersion: 2, revision: 1, enabled: true, hideShorts,
    general: { id: "general", mode: "general", version: 1, objectives: [topic] },
    focus: { id: "focus", mode: "focus", version: 1, objectives: [topic] }, focusSession: { active: mode === "focus" } };
  h.context.chrome = { storage: { local: { get: async () => options.read ? options.read(state) : ({ focusfeedSettingsV2: state }) }, onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
      requests.push(message.request);
      if (options.classify) return options.classify(message.request);
      return { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => ({
        videoId: video.videoId, outcome: /song/i.test(video.title) ? "match" : "no_match", reason: "fixture",
        objectiveMatches: [{ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: /song/i.test(video.title) ? .95 : .05 }]
      })) } } };
    } } };
  h.document.querySelectorAll("video").forEach(h.media);
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  function change(values) { Object.assign(state, values); state.revision++; listeners.forEach(fn => fn({ focusfeedSettingsV2: { newValue: state } }, "local")); }
  return { ...h, state, requests, change };
}
test("Hide Shorts removes expanded and compact guide entries, including replacements, and restores them", async t => {
  const entry = (id, tag, href) => `<${tag} id="${id}"><a href="${href}">${id}</a></${tag}>`;
  const h = setup(t, `<ytd-guide-section-renderer>${entry("home", "ytd-guide-entry-renderer", "/")}${entry("shorts", "ytd-guide-entry-renderer", "/shorts/")}${entry("compact", "ytd-mini-guide-entry-renderer", "https://www.youtube.com/shorts?feature=guide")}${entry("channel", "ytd-guide-entry-renderer", "/@creator/shorts")}${entry("external", "ytd-guide-entry-renderer", "https://example.com/shorts")}</ytd-guide-section-renderer>`, "/", "general", true);
  await sleep(150);
  const hidden = id => h.document.getElementById(id).hasAttribute("data-focusfeed-display-hidden");
  assert.equal(hidden("shorts"), true); assert.equal(hidden("compact"), true);
  for (const id of ["home", "channel", "external"]) assert.equal(hidden(id), false);
  h.document.body.insertAdjacentHTML("beforeend", entry("late", "ytd-mini-guide-entry-renderer", "/shorts"));
  await sleep(150); assert.equal(hidden("late"), true);
  h.document.querySelector("#late a").setAttribute("href", "/feed/history"); await sleep(150);
  assert.equal(hidden("late"), false, "a recycled entry is restored");
  h.change({ enabled: false }); await sleep(150); assert.equal(hidden("shorts"), false);
  h.change({ enabled: true }); await sleep(150); assert.equal(hidden("shorts"), true);
  h.change({ hideShorts: false }); await sleep(150); assert.equal(hidden("shorts"), false); assert.equal(hidden("compact"), false);
  assert.equal(h.requests.length, 0);
});
for (const mode of ["general", "focus"]) for (const route of ["/", "/results?search_query=test"]) {
  test(`${mode} ${route}: Shorts shelf items are filtered independently with Hide Shorts off`, async t => {
    const song = short("song1234567", "A song"), math = short("math1234567", "Math tutorial", "ytm-shorts-lockup-view-model");
    // Put the filtered item first in each mode to catch whole-shelf decisions.
    const shelf = `<ytd-rich-item-renderer id="wrapper"><ytd-rich-shelf-renderer is-shorts>${mode === "general" ? song + math : math + song}</ytd-rich-shelf-renderer></ytd-rich-item-renderer>`;
    const h = setup(t, route === "/" ? homePage(shelf) : shelf, route, mode);
    await sleep(450);
    assert.ok(h.requests.length > 0);
    const inputs = h.requests.flatMap(request => request.videos);
    assert.ok(inputs.some(video => video.videoId === "song1234567" && video.isShort));
    assert.ok(inputs.some(video => video.videoId === "math1234567" && video.isShort));
    assert.equal(h.document.getElementById("song1234567").dataset.focusfeedAutoHidden, mode === "general" ? "true" : undefined);
    assert.equal(h.document.getElementById("math1234567").dataset.focusfeedAutoHidden, mode === "focus" ? "true" : undefined);
    const wrapper = h.document.getElementById("wrapper");
    assert.equal(wrapper.dataset.focusfeedAutoHidden, undefined, "one Short must not hide the entire shelf");
    assert.equal(wrapper.dataset.focusfeedFocusWithheld, undefined, "shelf wrapper is not a Focus candidate");
  });
}
test("Hide Shorts takes precedence over topics; disabling it starts topic checks and pausing OwnFeed restores playback", async t => {
  const h = setup(t, '<ytd-reel-video-renderer is-active><video></video><h2>A song</h2></ytd-reel-video-renderer>', "/shorts/song1234567", "general", true);
  const video = h.document.querySelector("video"); await sleep(150);
  assert.equal(video.paused, true); assert.match(h.document.querySelector(".focusfeed-playback").textContent, /Shorts are hidden/);
  assert.equal(h.requests.length, 0);
  h.change({ hideShorts: false }); await sleep(100);
  assert.equal(video.paused, true, "topic checks still cover this Short when Hide Shorts is disabled");
  await sleep(350);
  assert.equal(video.paused, true); assert.match(h.document.querySelector(".focusfeed-shorts-status").textContent, /next Short/);
  h.change({ enabled: false }); await sleep(100);
  assert.equal(video.paused, false); assert.equal(h.document.querySelector(".focusfeed-playback"), null);
});

function player(id, title) {
  return `<ytd-reel-video-renderer is-active video-id="${id}"><video></video><h2>${title}</h2></ytd-reel-video-renderer>`;
}
function activate(h, id, title, updateUrl = true) {
  const surface = h.document.querySelector("ytd-reel-video-renderer");
  surface.setAttribute("video-id", id); surface.querySelector("h2").textContent = title;
  if (updateUrl) h.location.pathname = "/shorts/" + id;
}
function result(request, probability) {
  return { ok: true, data: { ok: true, data: { assessments: request.videos.map(video => ({
    videoId: video.videoId, outcome: probability >= .5 ? "match" : probability <= .2 ? "no_match" : "uncertain", reason: "fixture",
    objectiveMatches: [{ objectiveId: topic.id, text: topic.text, contentType: "topic", matchProbability: probability }]
  })) } } };
}
for (const mode of ["general", "focus"]) {
  test(`${mode}: the scrolling Shorts player checks topics, pauses filtered Shorts and resumes allowed ones`, async t => {
    const filteredTitle = mode === "general" ? "A song" : "Math tutorial";
    const allowedTitle = mode === "general" ? "Math tutorial" : "A song";
    const h = setup(t, player("first123456", filteredTitle), "/shorts/first123456", mode);
    const media = h.document.querySelector("video"), surface = h.document.querySelector("ytd-reel-video-renderer");
    await sleep(100);
    assert.equal(media.paused, true, "hold unchecked Shorts before classification");
    assert.match(h.document.querySelector(".focusfeed-shorts-status").textContent, /Preparing next Shorts/);
    await sleep(350);
    assert.equal(media.paused, true); assert.match(h.document.querySelector(".focusfeed-shorts-status").textContent, /next Short/);
    assert.equal(surface.dataset.focusfeedAutoHidden, undefined, "retain the player so scrolling stays possible");
    media.play(); media.dispatchEvent(new h.window.Event("play", { bubbles: true }));
    assert.equal(media.paused, true, "autoplay cannot restart filtered media");
    // The active renderer can change before the URL catches up.
    activate(h, "next1234567", allowedTitle, false); await sleep(450);
    assert.equal(media.paused, false); assert.equal(surface.querySelector(".focusfeed-playback"), null);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].videos[0].videoId, "next1234567");
    assert.equal(h.requests[1].videos[0].isShort, true);
    activate(h, "first123456", filteredTitle); await sleep(150);
    assert.equal(media.paused, true); assert.match(h.document.querySelector(".focusfeed-shorts-status").textContent, /next Short/);
    assert.equal(h.requests.length, 2, "returning to a checked Short reuses its decision");
    h.change({ enabled: false }); await sleep(100);
    assert.equal(media.paused, false); assert.equal(surface.querySelector(".focusfeed-playback"), null);
  });
  test(`${mode}: an uncertain Shorts judgment follows the existing topic policy`, async t => {
    const h = setup(t, player("unknown1234", "Uncertain video"), "/shorts/unknown1234", mode, false,
      { classify: request => result(request, .35) });
    await sleep(450);
    assert.equal(h.document.querySelector("video").paused, mode === "focus");
    assert.equal(!!h.document.querySelector(".focusfeed-shorts-status"), mode === "focus");
  });
}
test("a late result for the previous Short cannot release the newly active Short", async t => {
  const pending = [];
  const h = setup(t, player("first123456", "A song"), "/shorts/first123456", "general", false,
    { classify: request => new Promise(resolve => pending.push({ request, resolve })) });
  const media = h.document.querySelector("video"); await sleep(350);
  assert.equal(pending.length, 1);
  activate(h, "next1234567", "Math tutorial"); await sleep(450);
  assert.equal(pending.length, 2); assert.equal(media.paused, true);
  pending[0].resolve(result(pending[0].request, .05)); await sleep(50);
  assert.equal(media.paused, true, "the old Short's allowed result does not release the pending one");
  pending[1].resolve(result(pending[1].request, .05)); await sleep(50);
  assert.equal(media.paused, false); assert.equal(h.document.querySelector(".focusfeed-playback"), null);
});
test("failed Shorts checks stay paused, offer retry and recover on success", async t => {
  let fail = true;
  const h = setup(t, player("retry123456", "Math tutorial"), "/shorts/retry123456", "general", false,
    { classify: request => { if (fail) throw new Error("offline"); return result(request, .05); } });
  const media = h.document.querySelector("video"); await sleep(450);
  assert.equal(media.paused, true);
  const overlay = h.document.querySelector(".focusfeed-shorts-status"); assert.match(overlay.textContent, /Could not check Shorts/);
  const retry = overlay.querySelector("button"); assert.equal(retry.textContent, "Try again");
  fail = false; retry.click(); await sleep(350);
  assert.equal(media.paused, false); assert.equal(h.document.querySelector(".focusfeed-playback"), null);
});
test("Shorts with no topics stay accessible and do not call the classifier", async t => {
  const h = setup(t, player("empty123456", "A song"), "/shorts/empty123456");
  h.change({ general: { ...h.state.general, objectives: [] } }); await sleep(350);
  assert.equal(h.document.querySelector("video").paused, false);
  assert.equal(h.document.querySelector(".focusfeed-playback"), null); assert.equal(h.requests.length, 0);
});
test("Shorts navigation can reuse paused media and resumes only after the next Short is allowed", async t => {
  const h = setup(t, player("first123456", "A song"), "/shorts/first123456");
  const media = h.document.querySelector("video"); await sleep(450); assert.equal(media.paused, true);
  h.window.dispatchEvent(new h.window.Event("yt-navigate-start"));
  activate(h, "next1234567", "Math tutorial");
  h.window.dispatchEvent(new h.window.Event("yt-navigate-finish"));
  await sleep(450);
  assert.equal(media.paused, false, "navigation preserves OwnFeed's pause ownership on reused media");
  assert.equal(h.document.querySelector(".focusfeed-playback"), null);
});
test("activating a replacement Shorts renderer applies its own decision and pauses autoplay", async t => {
  const h = setup(t, player("first123456", "Math tutorial"), "/shorts/first123456");
  await sleep(450); assert.equal(h.document.querySelector("video").paused, false);
  const previous = h.document.querySelector("ytd-reel-video-renderer"); previous.removeAttribute("is-active");
  h.document.body.insertAdjacentHTML("beforeend", player("next1234567", "A song"));
  const next = h.document.querySelector("ytd-reel-video-renderer[is-active]"), media = h.media(next.querySelector("video"));
  h.location.pathname = "/shorts/next1234567"; await sleep(150);
  assert.equal(media.paused, true); await sleep(350);
  assert.match(h.document.querySelector(".focusfeed-shorts-status").textContent, /next Short/);
  media.play(); media.dispatchEvent(new h.window.Event("playing", { bubbles: true }));
  assert.equal(media.paused, true);
  h.change({ general: { ...h.state.general, objectives: [] } }); await sleep(100);
  assert.equal(media.paused, true, "clearing topics does not restore IDs already removed in this visit");
  h.change({ enabled: false }); await sleep(100);
  assert.equal(media.paused, false); assert.equal(h.document.querySelector(".focusfeed-playback"), null);
});
// Replays the reported layout: one reel renderer, zero [is-active] renderers,
// a playing #shorts-player, and unrelated paused Watch/preview players.
for (const shared of [false, true]) test(`Hide Shorts blocks the reported player without is-active (shared=${shared})`, async t => {
  const media = '<div id="container"><div id="shorts-player"><div><video id="short-media"></video></div></div></div>';
  const reel = '<ytd-reel-video-renderer video-id="actual12345"><h2>A song</h2>' + (shared ? '' : media) + '</ytd-reel-video-renderer>';
  const h = setup(t, '<div id="movie_player"><div><video id="watch-media"></video></div></div>' + reel + (shared ? media : '') + '<div id="inline-preview-player"><div><video id="preview-media"></video></div></div>', '/shorts/actual12345', 'general', true);
  h.document.getElementById('watch-media').paused = true;
  h.document.getElementById('preview-media').paused = true;
  await sleep(150);
  assert.equal(h.document.querySelectorAll('ytd-reel-video-renderer[is-active]').length, 0);
  assert.equal(h.document.getElementById('short-media').paused, true);
  assert.match(h.document.querySelector('.focusfeed-playback').textContent, /Shorts are hidden/);
  assert.equal(h.requests.length, 0);
  h.change({ enabled: false }); await sleep(100);
  assert.equal(h.document.getElementById('short-media').paused, false);
  assert.equal(h.document.getElementById('watch-media').paused, true, 'leave the unrelated Watch player alone');
});
for (const mode of ['general', 'focus']) test(`${mode}: topic filtering also finds Shorts without is-active`, async t => {
  const title = mode === 'general' ? 'A song' : 'Math tutorial';
  const html = '<ytd-reel-video-renderer video-id="actual12345"><h2>' + title + '</h2></ytd-reel-video-renderer><div id="shorts-player"><div><video></video></div></div>';
  const h = setup(t, html, '/shorts/actual12345', mode);
  await sleep(450);
  assert.equal(h.document.querySelector('video').paused, true);
  assert.match(h.document.querySelector('.focusfeed-shorts-status').textContent, /next Short/);
  assert.equal(h.requests[0].videos[0].title, title);
});
test("Hide Shorts covers the bare Shorts route before YouTube supplies a video identity", async t => {
  const h = setup(t, '<div id="shorts-player"><div><video></video></div></div>', '/shorts', 'general', true);
  await sleep(150);
  assert.equal(h.document.querySelector('video').paused, true);
  assert.match(h.document.querySelector('.focusfeed-playback').textContent, /Shorts are hidden/);
  assert.equal(h.requests.length, 0);
});
test("the content script stops observing and polling after its extension context is invalidated", async t => {
  let invalid = false, reads = 0;
  const h = setup(t, '', '/', 'general', true, { read(state) {
    reads++;
    if (invalid) throw new Error('Extension context invalidated.');
    return { focusfeedSettingsV2: state };
  } });
  await sleep(100); invalid = true;
  h.window.dispatchEvent(new h.window.Event('yt-navigate-finish')); await sleep(100);
  assert.equal(h.document.documentElement.getAttribute('data-focusfeed-disconnected'), 'true');
  assert.match(h.document.querySelector('.focusfeed-toast').textContent, /Refresh this YouTube tab/);
  const before = reads;
  h.window.dispatchEvent(new h.window.Event('pageshow'));
  h.window.dispatchEvent(new h.window.Event('yt-navigate-finish'));
  h.document.body.appendChild(h.document.createElement('div'));
  await sleep(150); assert.equal(reads, before);
});
test("Hide Shorts recognizes the captured primary guide entry whose endpoint has no href", async t => {
  const entry = (id, title, primary = true, href = '') => `<ytd-guide-entry-renderer id="${id}" ${primary ? 'is-primary' : ''}><a id="endpoint" role="link" title="${title}" ${href ? 'href="' + href + '"' : ''}><tp-yt-paper-item role="link"><yt-formatted-string class="title">${title}</yt-formatted-string></tp-yt-paper-item></a></ytd-guide-entry-renderer>`;
  const h = setup(t, '<ytd-guide-renderer><ytd-guide-section-renderer>' + entry('shorts-no-href', 'Shorts') + entry('home', 'Home') + entry('named-channel', 'Shorts', false, '/@shorts') + entry('unidentified', 'Shorts', false) + '</ytd-guide-section-renderer></ytd-guide-renderer>', '/', 'general', true);
  const hidden = id => !!h.document.getElementById(id).closest('[data-focusfeed-display-hidden]');
  await sleep(150);
  assert.equal(hidden('shorts-no-href'), true);
  for (const id of ['home', 'named-channel', 'unidentified']) assert.equal(hidden(id), false);
  h.document.querySelector('#shorts-no-href a').setAttribute('title', 'Home'); await sleep(150);
  assert.equal(hidden('shorts-no-href'), false, 'recycled primary entries are restored');
  h.document.querySelector('#shorts-no-href a').setAttribute('title', 'Shorts'); await sleep(150);
  assert.equal(hidden('shorts-no-href'), true);
  h.change({ hideShorts: false }); await sleep(100); assert.equal(hidden('shorts-no-href'), false);
});
for (const mode of ['general', 'focus']) test(`${mode}: packaged Shorts skip rejected items without revealing them, then reveal the allowed successor`, async t => {
  const firstTitle = mode === 'general' ? 'A song' : 'Math tutorial';
  const allowedTitle = mode === 'general' ? 'Math tutorial' : 'A song';
  const navigation = mode === 'general' ? '<div><button class="ytSpecButtonShapeNextHost" aria-label="Next video"></button></div>' : '<div id="navigation-button-down"><button>Next</button></div>';
  const h = setup(t, '<ytd-shorts>' + player('first123456', firstTitle) + navigation + '</ytd-shorts>', '/shorts/first123456', mode);
  const card = h.document.querySelector('ytd-reel-video-renderer'), media = h.document.querySelector('video');
  const observations = [];
  h.document.querySelector('ytd-shorts button').addEventListener('click', () => {
    observations.push({ id: card.getAttribute('video-id'), allowed: card.hasAttribute('data-focusfeed-shorts-allowed'), paused: media.paused });
    activate(h, observations.length === 1 ? 'second12345' : 'allowed1234', observations.length === 1 ? firstTitle : allowedTitle);
  });
  const until = performance.now() + 2200;
  while ((!card.hasAttribute('data-focusfeed-shorts-allowed') || card.getAttribute('video-id') !== 'allowed1234') && performance.now() < until) await sleep(20);
  assert.equal(card.getAttribute('video-id'), 'allowed1234');
  assert.equal(card.hasAttribute('data-focusfeed-shorts-allowed'), true);
  assert.deepEqual(observations, [{ id: 'first123456', allowed: false, paused: true }, { id: 'second12345', allowed: false, paused: true }]);
  assert.equal(media.paused, false); assert.equal(h.document.querySelector('.focusfeed-playback'), null);
  assert.equal(h.document.querySelector('.focusfeed-shorts-status'), null);
});
test('a Shorts card recycled to a different video loses its reveal permission before the debounced scan', async t => {
  const h = setup(t, short('math1234567', 'Math tutorial'), '/results');
  const card = h.document.querySelector('ytm-shorts-lockup-view-model-v2'); await sleep(450);
  assert.equal(card.hasAttribute('data-focusfeed-shorts-allowed'), true);
  card.querySelector('a').setAttribute('href', '/shorts/song1234567'); card.querySelector('h3').textContent = 'A song';
  await Promise.resolve(); await Promise.resolve();
  assert.equal(card.hasAttribute('data-focusfeed-shorts-allowed'), false);
  await sleep(450); assert.equal(card.dataset.focusfeedAutoHidden, 'true');
  assert.equal(card.hasAttribute('data-focusfeed-shorts-allowed'), false);
});
function feed(h, data, endpoint = '/youtubei/v1/reel/reel_watch_sequence') {
  const event = new h.window.Event('message'); event.source = h.window;
  event.data = { type: 'FOCUSFEED_FEED_DATA', endpoint, data }; h.window.dispatchEvent(event);
}
function queueResponse(count, offset = 0) {
  return { entries: Array.from({ length: count }, (_, i) => ({ reelItemRenderer: {
    videoId: i + offset === 0 ? 'first123456' : 'queued' + String(i + offset).padStart(5, '0'), headline: { simpleText: 'Math tutorial ' + (i + offset) }
  } })) };
}
test('Shorts queue metadata is checked together before the upcoming players are mounted', async t => {
  const h = setup(t, player('first123456', 'Math tutorial 0'), '/shorts/first123456');
  feed(h, queueResponse(8)); await sleep(450);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].videos.length, 8, 'all titled queue entries must join one classifier batch');
  assert.ok(h.requests[0].videos.every(video => video.isShort));
  const stats = JSON.parse(h.document.documentElement.getAttribute('data-focusfeed-shorts-queue'));
  assert.deepEqual(stats.batchSizes, [8]); assert.equal(stats.ready, 8);
});
test('moving to an already prepared Short reveals it in the mutation microtask with no new request', async t => {
  const h = setup(t, player('first123456', 'Math tutorial 0'), '/shorts/first123456');
  feed(h, queueResponse(3)); await sleep(450);
  activate(h, 'queued00001', 'Math tutorial 1');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.document.querySelector('ytd-reel-video-renderer').hasAttribute('data-focusfeed-shorts-allowed'), true);
  assert.equal(h.document.querySelector('.focusfeed-shorts-status'), null);
  await sleep(350); assert.equal(h.requests.length, 1);
  activate(h, 'first123456', 'Math tutorial 0');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.document.querySelector('ytd-reel-video-renderer').hasAttribute('data-focusfeed-shorts-allowed'), true);
  assert.equal(h.document.querySelector('.focusfeed-shorts-status'), null);
});
test('loaded inactive Shorts join the batch even without a network response', async t => {
  const loaded = Array.from({ length: 5 }, (_, i) => player(i ? 'queued' + String(i).padStart(5, '0') : 'first123456', 'Math tutorial ' + i).replace(i ? ' is-active' : 'never-match', ''));
  const h = setup(t, loaded.join(''), '/shorts/first123456'); await sleep(450);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].videos.length, 5);
});
test('ID-only queue entries wait for real metadata; nested player metadata hydrates them in one batch', async t => {
  const h = setup(t, player('first123456', 'Math tutorial 0'), '/shorts/first123456');
  feed(h, { entries: ['first123456', 'queued00001', 'queued00002'].map(videoId => ({ command: { reelWatchEndpoint: { videoId } } })) });
  await sleep(450);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].videos.length, 1);
  let stats = JSON.parse(h.document.documentElement.getAttribute('data-focusfeed-shorts-queue'));
  assert.equal(stats.withMetadata, 1); assert.equal(stats.withoutMetadata, 2);
  feed(h, { responses: [
    { playerResponse: { videoDetails: { videoId: 'queued00001', title: 'Math tutorial 1', author: 'Teacher' } } },
    { playerResponse: JSON.stringify({ videoDetails: { videoId: 'queued00002', title: 'Math tutorial 2', author: 'Teacher' } }) }
  ] }, '/youtubei/v1/reel/reel_item_watch');
  await sleep(450);
  assert.deepEqual(h.requests.map(request => request.videos.length), [1, 2]);
  assert.deepEqual(Array.from(h.requests[1].videos, video => video.title).sort(), ['Math tutorial 1', 'Math tutorial 2']);
  stats = JSON.parse(h.document.documentElement.getAttribute('data-focusfeed-shorts-queue'));
  assert.equal(stats.withoutMetadata, 0); assert.equal(stats.ready, 3);
});
test('Shorts navigation preserves the queue request that is still in flight', async t => {
  const pending = [];
  const h = setup(t, player('first123456', 'Math tutorial 0'), '/shorts/first123456', 'general', false,
    { classify: request => new Promise(resolve => pending.push({ request, resolve })) });
  feed(h, queueResponse(4)); await sleep(350); assert.equal(pending.length, 1);
  h.window.dispatchEvent(new h.window.Event('yt-navigate-start')); activate(h, 'queued00001', 'Math tutorial 1');
  h.window.dispatchEvent(new h.window.Event('yt-navigate-finish')); await sleep(100);
  pending[0].resolve(result(pending[0].request, .05)); await sleep(100);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].videos.length, 4);
  assert.equal(h.document.querySelector('ytd-reel-video-renderer').hasAttribute('data-focusfeed-shorts-allowed'), true);
});
test('new queue responses refill the batch without rechecking unchanged prepared Shorts', async t => {
  const h = setup(t, player('first123456', 'Math tutorial 0'), '/shorts/first123456');
  feed(h, queueResponse(5)); await sleep(450);
  feed(h, { chunks: [queueResponse(5), queueResponse(3, 5)] }); await sleep(450);
  assert.deepEqual(h.requests.map(request => request.videos.length), [5, 3]);
  const ids = h.requests.flatMap(request => request.videos.map(video => video.videoId));
  assert.equal(new Set(ids).size, 8);
});
test('prepared metadata keeps its verified author while the native byline is being recycled', async t => {
  const h = setup(t, player('first123456', 'Math tutorial 0').replace('</ytd-reel-video-renderer>', '<div id="channel-name"><a href="/@old">Old teacher</a></div></ytd-reel-video-renderer>'), '/shorts/first123456');
  feed(h, { entries: [0, 1].map(i => ({ reelItemRenderer: { videoId: i ? 'queued00001' : 'first123456', headline: { simpleText: 'Math tutorial ' + i }, ownerText: { simpleText: 'Teacher ' + i } } })) });
  await sleep(450); activate(h, 'queued00001', 'Math tutorial 1');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.document.querySelector('ytd-reel-video-renderer').hasAttribute('data-focusfeed-shorts-allowed'), true);
  await sleep(350); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].videos.find(v => v.videoId === 'queued00001').channel, 'Teacher 1');
});
test('a larger loaded Shorts queue drains in bounded multi-video batches', async t => {
  const h = setup(t, player('first123456', 'Math tutorial 0'), '/shorts/first123456');
  feed(h, queueResponse(70));
  const deadline = performance.now() + 2500;
  while (h.requests.reduce((n, request) => n + request.videos.length, 0) < 70 && performance.now() < deadline) await sleep(20);
  assert.equal(h.requests.reduce((n, request) => n + request.videos.length, 0), 70);
  assert.ok(h.requests.every(request => request.videos.length > 1 && request.videos.length <= 40));
  assert.equal(new Set(h.requests.flatMap(request => Array.from(request.videos, video => video.videoId))).size, 70);
});
test('stale initial Home data does not fill the active Shorts prefetch queue', async t => {
  const h = setup(t, player('first123456', 'Math tutorial 0'), '/shorts/first123456');
  feed(h, queueResponse(8, 10), 'ytInitialData'); await sleep(450);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].videos.length, 1);
});
function assessmentForTopics(request) {
  return { ok: true, data: { ok: true, data: { assessments: request.videos.map(video => {
    const matches = request.profile.objectives.map(objective => ({ objectiveId: objective.id, text: objective.text, contentType: 'topic',
      matchProbability: objective.text.toLowerCase().includes('math') ? /math/i.test(video.title) ? .95 : .05 : /song/i.test(video.title) ? .95 : .05 }));
    return { videoId: video.videoId, outcome: matches.some(m => m.matchProbability >= .5) ? 'match' : 'no_match', reason: 'fixture', objectiveMatches: matches };
  }) } } };
}
for (const shared of [false, true]) test(`editing topics cannot revive or requeue a removed Short (shared=${shared})`, async t => {
  const initial = shared ? '<ytd-reel-video-renderer video-id="first123456"><h2>Math tutorial</h2></ytd-reel-video-renderer><div id="shorts-player"><video></video></div>' : player('first123456', 'Math tutorial');
  const h = setup(t, initial, '/shorts/first123456', 'general', false, { classify: assessmentForTopics });
  feed(h, { entries: [['first123456', 'Math tutorial'], ['removed1234', 'A song'], ['science1234', 'Science tutorial']].map(([videoId, title]) => ({ reelItemRenderer: { videoId, headline: { simpleText: title } } })) });
  await sleep(450);
  assert.equal(JSON.parse(h.document.documentElement.getAttribute('data-focusfeed-shorts-queue')).removed, 1);
  h.change({ general: { ...h.state.general, version: 2, objectives: [{ ...topic, id: 'math', text: 'Math tutorials' }] } });
  assert.equal(h.document.querySelector('ytd-reel-video-renderer').hasAttribute('data-focusfeed-shorts-allowed'), false, 'update revokes permission synchronously');
  await sleep(450);
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].videos.some(video => video.videoId === 'removed1234'), false);
  const media = h.document.querySelector('video'), parent = media.parentNode;
  activate(h, 'removed1234', 'A song'); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.document.querySelector('[data-focusfeed-shorts-allowed]'), null);
  assert.equal(media.paused, true);
  feed(h, { reelItemRenderer: { videoId: 'removed1234', headline: { simpleText: 'A song' } } }); await sleep(350);
  assert.equal(h.requests.length, 2, 'removed active IDs and repeated responses do not trigger classification');
  assert.equal(media.parentNode, parent, 'shared/native media nodes remain owned by YouTube');
  const stats = JSON.parse(h.document.documentElement.getAttribute('data-focusfeed-shorts-queue'));
  assert.equal(stats.removed, 2); assert.equal(stats.received, 1);
});
test('an old pending verdict cannot remove a Short while the new settings read is pending', async t => {
  let delayRead = false, finishRead; const pending = [];
  const h = setup(t, player('first123456', 'A song'), '/shorts/first123456', 'general', false, {
    read(state) { return delayRead ? new Promise(resolve => { finishRead = () => resolve({ focusfeedSettingsV2: state }); }) : { focusfeedSettingsV2: state }; },
    classify: request => new Promise(resolve => pending.push({ request, resolve }))
  });
  await sleep(350); assert.equal(pending.length, 1);
  delayRead = true; h.change({ focusSession: { active: true } });
  assert.equal(h.document.querySelector('[data-focusfeed-shorts-allowed]'), null);
  pending[0].resolve(result(pending[0].request, .95)); await sleep(50);
  assert.equal(h.document.querySelector('[data-focusfeed-shorts-allowed]'), null, 'old policy callbacks remain behind the update barrier');
  delayRead = false; finishRead(); await sleep(100);
  assert.equal(h.document.querySelector('ytd-reel-video-renderer').hasAttribute('data-focusfeed-shorts-allowed'), true);
  assert.equal(h.document.querySelector('video').paused, false);
  assert.equal(JSON.parse(h.document.documentElement.getAttribute('data-focusfeed-shorts-queue')).removed, 0);
  assert.equal(h.requests.length, 1, 'the raw score can be reused under the new mode without applying the old policy');
});
test('a failed settings update stays concealed, stops old-policy work and offers a settings retry', async t => {
  let fail = false;
  const h = setup(t, player('first123456', 'Math tutorial'), '/shorts/first123456', 'general', false, {
    read(state) { if (fail) throw new Error('Storage temporarily unavailable'); return { focusfeedSettingsV2: state }; }
  });
  await sleep(450); assert.equal(h.document.querySelector('video').paused, false);
  fail = true; h.change({ general: { ...h.state.general, version: 2 } }); await sleep(50);
  assert.equal(h.document.querySelector('[data-focusfeed-shorts-allowed]'), null);
  assert.match(h.document.querySelector('.focusfeed-shorts-status').textContent, /Could not update Shorts/);
  await sleep(300); assert.equal(h.requests.length, 1);
  fail = false; h.document.querySelector('.focusfeed-shorts-status button').click(); await sleep(100);
  assert.equal(h.document.querySelector('ytd-reel-video-renderer').hasAttribute('data-focusfeed-shorts-allowed'), true);
  assert.equal(h.document.querySelector('video').paused, false);
  assert.equal(h.requests.length, 1);
});
test('a stale failed settings read cannot undo a newer successful filter update', async t => {
  let delayed = false; const reads = [];
  const h = setup(t, player('first123456', 'Math tutorial'), '/shorts/first123456', 'general', false, {
    read(state) {
      if (!delayed) return { focusfeedSettingsV2: state };
      const saved = JSON.parse(JSON.stringify(state));
      return new Promise((resolve, reject) => reads.push({ resolve: () => resolve({ focusfeedSettingsV2: saved }), reject }));
    }
  });
  await sleep(450); delayed = true;
  h.change({ general: { ...h.state.general, version: 2, objectives: [{ ...topic, id: 'math', text: 'Math tutorials' }] } });
  h.change({ general: { ...h.state.general, version: 3, objectives: [topic] } });
  assert.equal(reads.length, 2);
  reads[1].resolve(); await sleep(30);
  reads[0].reject(new Error('Old settings read failed')); await sleep(50);
  assert.equal(h.document.querySelector('ytd-reel-video-renderer').hasAttribute('data-focusfeed-shorts-allowed'), true);
  assert.equal(h.document.querySelector('video').paused, false);
  assert.equal(h.document.querySelector('.focusfeed-shorts-status'), null);
});
test('a collapsed removed renderer is still recognized on a shared-player history route without is-active', async t => {
  const h = setup(t, '<ytd-shorts><ytd-reel-video-renderer id="old-slot" video-id="removed1234"><h2>A song</h2></ytd-reel-video-renderer><ytd-reel-video-renderer video-id="later123456"><h2>Math tutorial</h2></ytd-reel-video-renderer><div id="shorts-player"><video></video></div><button aria-label="Previous video">Previous</button><div id="navigation-button-down"><button>Next</button></div></ytd-shorts>', '/shorts/later123456');
  const old = h.document.getElementById('old-slot'), shared = h.document.getElementById('shorts-player');
  old.getClientRects = () => old.hasAttribute('data-focusfeed-shorts-removed') && !old.hasAttribute('data-focusfeed-shorts-current') ? [] : [{}];
  feed(h, { entries: [['removed1234', 'A song'], ['later123456', 'Math tutorial']].map(([videoId, title]) => ({ reelItemRenderer: { videoId, headline: { simpleText: title } } })) });
  await sleep(450); assert.equal(old.getClientRects().length, 0);
  let previous = 0, next = 0;
  h.document.querySelector('button[aria-label="Previous video"]').addEventListener('click', () => previous++);
  h.document.querySelector('#navigation-button-down button').addEventListener('click', () => next++);
  h.location.pathname = '/shorts/removed1234'; h.window.dispatchEvent(new h.window.Event('popstate')); await sleep(60);
  assert.equal(old.hasAttribute('data-focusfeed-shorts-current'), true, 'route identity wins over the visible-renderer fallback');
  assert.equal(shared.hasAttribute('data-focusfeed-shorts-removed'), false, 'shared media does not inherit an inactive slot collapse marker');
  assert.equal(h.document.querySelector('[data-focusfeed-shorts-allowed]'), null);
  assert.equal(shared.querySelector('video').paused, true); assert.equal(previous, 1); assert.equal(next, 0);
  assert.equal(h.requests.length, 1);
});
