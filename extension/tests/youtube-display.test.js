"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, videoCard, homePage } = require("./dom-harness");
const HIDDEN = "data-focusfeed-display-hidden";
function setup(t, html, pathname = "/watch?v=current") {
  const h = dom(html, pathname); h.load("settings.js", "youtube-display.js");
  const ui = h.context.FocusFeedYouTubeDisplay.create();
  let state = h.context.FocusFeedSettings.migrate({});
  function set(key, enabled = true) {
    state = h.context.FocusFeedSettings.update(state, { type: "setDisplayPreference", key, enabled }); ui.configure(state);
  }
  t.after(() => { ui.clear(); h.cleanup(); });
  return { ...h, ui, set, get state() { return state; }, hidden: selector => ui.hides(h.document.querySelector(selector)) };
}
const watch = `<ytd-masthead><ytd-notification-topbar-button-renderer id="bell"></ytd-notification-topbar-button-renderer><div id="search">Search</div></ytd-masthead>
<ytd-watch-flexy><div id="primary"><div id="player"><video></video><div class="html5-endscreen"><a class="ytp-videowall-still" href="/watch?v=next">Next</a></div><div class="ytp-ce-element">End card</div><div class="ytp-cards-teaser">Info card</div><div class="caption-window">Captions</div></div>
<ytd-watch-metadata><h1>Title</h1><div id="owner">Channel</div><div id="actions">Like, share</div><div id="description">Description</div></ytd-watch-metadata>
<ytd-comments id="comments">Comments</ytd-comments><ytd-merch-shelf-renderer id="merch"></ytd-merch-shelf-renderer><ytd-ticket-shelf-renderer id="tickets"></ytd-ticket-shelf-renderer><ytd-offer-module-renderer id="offers"></ytd-offer-module-renderer></div>
<div id="secondary"><div id="related"><ytd-watch-next-secondary-results-renderer id="recommendations">Videos</ytd-watch-next-secondary-results-renderer></div><ytd-live-chat-frame id="chat"></ytd-live-chat-frame><ytd-playlist-panel-renderer id="playlist"></ytd-playlist-panel-renderer><ytd-donation-shelf-renderer id="fundraiser"></ytd-donation-shelf-renderer></div></ytd-watch-flexy>`;
test("watch controls independently hide their intended surfaces, pause restores every node", t => {
  const h = setup(t, watch), player = h.document.querySelector("video");
  const cases = {
    hideRecommended: "#recommendations", hideLiveChat: "#chat", hidePlaylist: "#playlist", hideFundraiser: "#fundraiser",
    hideEndScreenFeed: ".html5-endscreen", hideEndScreenCards: ".ytp-ce-element", hideComments: "#comments",
    hideMerchTicketsOffers: "#merch", hideButtonsBar: "#actions", hideChannel: "#owner", hideDescription: "#description",
    hideNotifications: "#bell", disableAnnotations: ".ytp-cards-teaser"
  };
  for (const [key, selector] of Object.entries(cases)) {
    h.set(key); assert.equal(h.hidden(selector), true, key);
    assert.equal(h.hidden("video"), false, "current playback survives " + key);
    assert.equal(h.hidden(".caption-window"), false, "captions survive " + key);
    h.set(key, false); assert.equal(h.hidden(selector), false, "restore " + key);
  }
  h.set("hideVideoSidebar");
  for (const selector of ["#recommendations", "#chat", "#playlist", "#fundraiser"]) assert.equal(h.hidden(selector), true);
  h.document.querySelector('#primary').appendChild(h.document.querySelector('#chat')); h.ui.scan();
  assert.equal(h.hidden('#chat'), true, "theater chat outside the sidebar still inherits the parent switch");
  h.set("hideVideoSidebar", false); h.set("hideVideoInfo");
  for (const selector of ["h1", "#actions", "#owner", "#description"]) assert.equal(h.hidden(selector), true);
  h.set("hideTopHeader"); assert.equal(h.hidden("#search"), true);
  assert.equal(h.document.documentElement.hasAttribute("data-focusfeed-hide-header"), true);
  for (const key of Object.keys(cases)) h.set(key);
  h.ui.configure({ ...h.state, enabled: false });
  assert.equal(h.document.querySelectorAll("[" + HIDDEN + "]").length, 0);
  assert.equal(h.document.documentElement.hasAttribute("data-focusfeed-hide-header"), false);
  assert.equal(h.document.querySelector("video"), player, "native nodes are retained");
});
test("new nodes are hidden on scan, recycled Mix cards restore and ordinary playlists survive", t => {
  const h = setup(t, homePage(videoCard("ordinary")) + `<ytd-radio-renderer id="radio"></ytd-radio-renderer>
    <ytd-rich-item-renderer id="mix"><yt-lockup-view-model><yt-collection-thumbnail-view-model></yt-collection-thumbnail-view-model><a href="/watch?v=seed&list=RDseed">Mix</a></yt-lockup-view-model></ytd-rich-item-renderer>
    <ytd-compact-video-renderer id="in-context"><a href="/watch?v=solo&list=RDseed">An individual video in a Mix</a></ytd-compact-video-renderer>
    <ytd-playlist-renderer id="regular"><a href="/playlist?list=PLnormal">Playlist</a></ytd-playlist-renderer>`);
  h.set("hideMixes"); assert.equal(h.hidden("#radio"), true); assert.equal(h.hidden("#mix"), true);
  assert.equal(h.hidden("#regular"), false);
  assert.equal(h.hidden("#in-context"), false, "playlist context alone must not turn an individual video into a Mix");
  h.document.querySelector("#mix a").setAttribute("href", "/watch?v=solo"); h.ui.scan(); assert.equal(h.hidden("#mix"), false);
  h.set("hideComments");
  const comments = h.document.createElement("ytd-comments"); h.document.body.appendChild(comments); h.ui.scan();
  assert.equal(h.ui.hides(comments), true);
  h.set("hideHomeFeed"); assert.equal(h.hidden('ytd-browse'), true); assert.equal(h.hidden("#regular"), false);
  h.ui.clear(); assert.equal(h.document.querySelectorAll("[" + HIDDEN + "]").length, 0);
});
test("search clutter is hidden without removing normal video, channel or playlist results", t => {
  const h = setup(t, `<ytd-search><ytd-item-section-renderer><ytd-video-renderer id="result">Video</ytd-video-renderer><ytd-channel-renderer id="channel">Channel</ytd-channel-renderer><ytd-playlist-renderer id="list">Playlist</ytd-playlist-renderer><ytd-shelf-renderer id="clutter">People also watched</ytd-shelf-renderer><ytd-horizontal-card-list-renderer id="queries">Related searches</ytd-horizontal-card-list-renderer></ytd-item-section-renderer></ytd-search><ytd-shelf-renderer id="elsewhere">Other page</ytd-shelf-renderer>`, "/results?search_query=math");
  h.set("hideInaptSearchResults"); assert.equal(h.hidden("#clutter"), true); assert.equal(h.hidden("#queries"), true);
  for (const selector of ["#result", "#channel", "#list", "#elsewhere"]) assert.equal(h.hidden(selector), false);
});
test("guide settings remove the selected links and sections while keeping Home and History", t => {
  const entry = (id, href) => `<ytd-guide-entry-renderer id="${id}"><a href="${href}">${id}</a></ytd-guide-entry-renderer>`;
  const h = setup(t, `<ytd-guide-renderer><ytd-guide-section-renderer id="primary-guide">${entry("home", "/")}${entry("subscriptions", "/feed/subscriptions")}${entry("explore", "/feed/explore")}${entry("history", "/feed/history")}</ytd-guide-section-renderer><ytd-guide-section-renderer id="services"><div id="guide-section-title">More from YouTube</div>${entry("premium", "/premium")}${entry("music", "https://music.youtube.com/")}</ytd-guide-section-renderer><ytd-guide-section-renderer id="channels">${entry("all-channels", "/feed/channels")}${entry("subscribed", "/@subscribed")}</ytd-guide-section-renderer>${entry("gaming", "/gaming")}</ytd-guide-renderer><ytd-browse page-subtype="subscriptions" id="subscription-feed">Feed</ytd-browse>`);
  h.set("hideMoreFromYouTube"); assert.equal(h.hidden("#gaming"), false, "services must not hide Explore categories");
  h.set("hideExploreTrending"); h.set("hideSubscriptions");
  for (const selector of ["#explore", "#subscriptions", "#services", "#channels"]) assert.equal(h.hidden(selector), true);
  assert.equal(h.hidden("#gaming"), true);
  for (const selector of ["#home", "#history", "#subscription-feed"]) assert.equal(h.hidden(selector), false);
});
test("autoplay clicks the real switch, handles replacement controls and restores only its own changes", t => {
  const h = setup(t, '<button class="ytp-autonav-toggle-button"><span class="ytp-autonav-toggle" aria-checked="true"></span></button><video></video>');
  let clicks = 0;
  function wire(button) { button.addEventListener("click", () => {
    clicks++; const toggle = button.querySelector("[aria-checked]"); toggle.setAttribute("aria-checked", toggle.getAttribute("aria-checked") === "true" ? "false" : "true");
  }); }
  let button = h.document.querySelector("button"); wire(button);
  h.set("disableAutoplay"); assert.equal(button.querySelector("span").getAttribute("aria-checked"), "false");
  h.ui.scan(); h.ui.scan(); assert.equal(clicks, 1, "scans never toggle an already disabled switch");
  h.set("disableAutoplay", false); assert.equal(button.querySelector("span").getAttribute("aria-checked"), "true");
  button.click(); const before = clicks; h.set("disableAutoplay"); h.ui.clear();
  assert.equal(clicks, before, "an originally off switch stays off");
  button.remove(); button = h.document.createElement("button"); button.className = "ytp-autonav-toggle-button";
  button.innerHTML = '<span aria-checked="true"></span>'; wire(button); h.document.body.appendChild(button);
  h.set("disableAutoplay"); assert.equal(button.querySelector("span").getAttribute("aria-checked"), "false");
  assert.equal(h.hidden("video"), false);
});

test("packaged Focus runtime skips a hidden Home and applies local layout updates with no provider calls", async t => {
  const h = dom(homePage(videoCard("one")));
  h.load("settings.js");
  const S = h.context.FocusFeedSettings;
  let state = S.migrate({});
  state.focus = { id: "focus", mode: "focus", version: 1, sessionDurationMinutes: 0,
    objectives: [{ id: "math", text: "Math", sourceText: "Math", contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" }] };
  state.focusSession.active = true; state.hideHomeFeed = true; state.hideComments = true;
  const listeners = [], requests = [];
  h.context.chrome = { storage: {
    local: { get: async defaults => ({ ...defaults, focusfeedSettingsV2: state }) },
    onChanged: { addListener: fn => listeners.push(fn), removeListener() {} }
  }, runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
    requests.push(message);
    if (message.type === "FF_AUTO_CLASSIFY") return { ok: true, data: { ok: true, data: {
      assessments: message.request.videos.map(video => ({ videoId: video.videoId, outcome: "match", reason: "fixture",
        objectiveMatches: [{ objectiveId: "math", text: "Math", contentType: "topic", matchProbability: .99 }] }))
    } } };
    return { ok: true };
  } } };
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await sleep(350);
  assert.equal(h.document.querySelector('ytd-browse').hasAttribute(HIDDEN), true);
  assert.equal(requests.some(message => message.type === "FF_AUTO_CLASSIFY"), false);
  assert.equal(h.document.querySelector('.focusfeed-discovery'), null);
  const comments = h.document.createElement('ytd-comments'); h.document.body.appendChild(comments);
  await sleep(130); assert.equal(comments.hasAttribute(HIDDEN), true, "the normal mutation observer applies display settings to late content");
  function change(action) {
    state = S.update(state, action); listeners.forEach(fn => fn({ focusfeedSettingsV2: { newValue: state } }, "local"));
  }
  change({ type: "setDisplayPreference", key: "hideHomeFeed", enabled: false }); await sleep(350);
  assert.equal(h.document.querySelector('ytd-browse').hasAttribute(HIDDEN), false);
  assert.equal(requests.filter(message => message.type === "FF_AUTO_CLASSIFY").length, 1, "showing Home resumes normal Focus filtering");
  change({ type: "setEnabled", enabled: false }); await sleep(20);
  assert.equal(comments.hasAttribute(HIDDEN), false);
});
