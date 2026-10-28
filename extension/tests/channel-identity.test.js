"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { dom, videoCard, homePage } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
function withoutChannel(id) {
  return videoCard(id).replace(`<a href="/@${id}">@${id}</a>`, '<span id="channel-name">Visible creator name</span>');
}
async function setup(t, html, resolveChannel = async () => { throw new Error("Lookup unavailable"); }, pathname = "/results") {
  const h = dom(html + '<ytd-popup-container><ytd-menu-popup-renderer><div id="items"></div></ytd-menu-popup-renderer></ytd-popup-container>', pathname);
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  const calls = [], blocks = [];
  const state = { schemaVersion: 2, revision: 1, enabled: true, hideShorts: false,
    general: { id: "general", mode: "general", version: 0, objectives: [] },
    focus: { id: "focus", mode: "focus", version: 0, objectives: [] }, focusSession: { active: false } };
  h.context.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async defaults => ({ ...defaults,
    focusfeedSettingsV2: state, focusFeedChannelBlocksV1: blocks }) } }, runtime: {
    onMessage: { addListener() {} }, sendMessage: async message => {
      calls.push(message);
      if (message.type === "FF_CHANNEL_RESOLVE") {
        try { return { ok: true, data: await resolveChannel(message.videoId) }; }
        catch (_) { return { ok: false, error: { message: "Lookup unavailable" } }; }
      }
      if (message.type === "FF_BLOCK_ADD") {
        const block = { id: "saved-block", scope: "global", channelId: message.channel.channelId, aliases: message.channel.aliases };
        blocks.push(block); return { ok: true, data: { created: true, block } };
      }
      if (message.type === "FF_BLOCK_REMOVE") {
        blocks.splice(blocks.findIndex(block => block.id === message.id), 1); return { ok: true };
      }
      return { ok: true };
    }
  } };
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  await settle();
  function feed(data) {
    const event = new h.window.Event("message"); event.source = h.window;
    event.data = { type: "FOCUSFEED_FEED_DATA", data }; h.window.dispatchEvent(event);
  }
  async function open(card) { card.querySelector('ytd-menu-renderer button, button[aria-label="More actions"]').click(); await settle(); }
  return { ...h, calls, blocks, feed, open, row: () => h.document.querySelector(".focusfeed-menu-action") };
}
test("absolute YouTube channel URLs enable blocking without a network lookup", async t => {
  const h = await setup(t, videoCard("abcdefghijk").replace('/@abcdefghijk', 'https://www.youtube.com/@RealCreator'));
  const card = h.document.querySelector("ytd-rich-item-renderer"); await h.open(card);
  assert.equal(h.row().disabled, false); h.row().click(); await settle();
  assert.equal(h.blocks[0].channelId, "@realcreator");
  assert.equal(card.dataset.focusfeedAutoHidden, "true");
  assert.equal(h.calls.some(call => call.type === "FF_CHANNEL_RESOLVE"), false);
});
test("modern lockup byline command runs provide the correct channel identity", async t => {
  const id = "abcdefghijk", h = await setup(t, withoutChannel(id));
  h.feed({ lockupViewModel: { contentId: id, contentType: "LOCKUP_CONTENT_TYPE_VIDEO", metadata: {
    lockupMetadataViewModel: { title: { content: "Video " + id }, metadata: { contentMetadataViewModel: { metadataRows: [
      { metadataParts: [{ text: { content: "Modern Creator", commandRuns: [{ onTap: {
        innertubeCommand: { browseEndpoint: { browseId: "UCmodern1234567" } }
      } }] } }] }
    ] } } }
  } } });
  const card = h.document.querySelector("ytd-rich-item-renderer"); await h.open(card);
  assert.equal(h.row().disabled, false); assert.match(h.row().textContent, /Modern Creator/);
  h.row().click(); await settle();
  assert.equal(h.blocks[0].channelId, "UCmodern1234567");
  assert.equal(card.dataset.focusfeedAutoHidden, "true");
  assert.equal(h.calls.some(call => call.type === "FF_CHANNEL_RESOLVE"), false);
});
test("a missing identity resolves while the menu is open, enables blocking and survives Undo", async t => {
  let finish;
  const h = await setup(t, withoutChannel("abcdefghijk"), id => new Promise(resolve => {
    finish = () => resolve({ videoId: id, channelId: "UCresolved12345", channelLabel: "Resolved Creator" });
  }));
  const card = h.document.querySelector("ytd-rich-item-renderer");
  assert.equal(h.calls.some(call => call.type === "FF_CHANNEL_RESOLVE"), false, "lookup only when the user opens a menu");
  await h.open(card); assert.equal(h.row().disabled, true); assert.match(h.row().textContent, /Finding channel/);
  finish(); await settle();
  assert.equal(h.row().disabled, false); h.row().click(); await settle();
  assert.equal(h.blocks[0].channelId, "UCresolved12345");
  assert.equal(card.dataset.focusfeedAutoHidden, "true", "the resolved ID also reaches automatic filtering");
  h.document.querySelector(".focusfeed-toast button").click(); await settle();
  assert.equal(h.blocks.length, 0); assert.equal(card.dataset.focusfeedAutoHidden, undefined);
});
test("late feed metadata enables an already-open menu even when the fallback lookup fails", async t => {
  const h = await setup(t, withoutChannel("abcdefghijk"));
  const card = h.document.querySelector("ytd-rich-item-renderer"); await h.open(card);
  assert.equal(h.row().disabled, true);
  h.feed({ videoRenderer: { videoId: "abcdefghijk", title: { simpleText: "Video abcdefghijk" }, ownerText: {
    runs: [{ text: "Late Creator", navigationEndpoint: { browseEndpoint: { browseId: "UClate123456789" } } }]
  } } });
  await settle(); assert.equal(h.row().disabled, false); assert.match(h.row().textContent, /Late Creator/);
  h.row().click(); await settle(); assert.equal(h.blocks[0].channelId, "UClate123456789");
});
test("a resolved Home channel can be blocked through its native menu without leaving a visible card", async t => {
  const h = await setup(t, homePage(withoutChannel("abcdefghijk")), async videoId => ({
    videoId, channelId: "@resolvedcreator", channelLabel: "Resolved Creator"
  }), "/");
  await settle();
  const card = h.document.querySelector("ytd-rich-item-renderer"); assert.ok(card);
  await h.open(card); assert.equal(h.row().disabled, false);
  h.row().click(); await settle();
  assert.equal(h.blocks[0].channelId, "@resolvedcreator");
  assert.equal(card.dataset.focusfeedAutoHidden, "true");
  h.document.querySelector(".focusfeed-toast button").click(); await settle();
  assert.equal(card.dataset.focusfeedAutoHidden, undefined);
});
test("a late lookup cannot replace or block the channel selected by a newer menu", async t => {
  let finish;
  const h = await setup(t, withoutChannel("abcdefghijk") + videoCard("lmnopqrstuv", "@second"), id => new Promise(resolve => {
    finish = () => resolve({ videoId: id, channelId: "UCfirst12345678", channelLabel: "First" });
  }));
  const cards = h.document.querySelectorAll("ytd-rich-item-renderer");
  await h.open(cards[0]); await h.open(cards[1]); finish(); await settle();
  assert.equal(h.row().disabled, false); assert.match(h.row().textContent, /@second/);
  h.row().click(); await settle();
  assert.equal(h.blocks.length, 1); assert.equal(h.blocks[0].channelId, "@second");
  assert.equal(cards[0].dataset.focusfeedAutoHidden, undefined); assert.equal(cards[1].dataset.focusfeedAutoHidden, "true");
});
const watchFixture = fs.readFileSync(path.join(__dirname, "fixtures/watch-lockups.html"), "utf8");
test("nested modern Home cards resolve through the outer card and new contextual menus", async t => {
  const fixture = dom(watchFixture), markup = fixture.document.querySelector('[data-test="video"]').outerHTML; fixture.cleanup();
  const h = await setup(t, homePage('<ytd-rich-item-renderer>' + markup + '</ytd-rich-item-renderer>'), async videoId => ({ videoId, channelId: "@capturedcreator" }), "/");
  h.document.querySelector("ytd-popup-container").innerHTML = '<yt-contextual-sheet-layout><yt-list-view-model><button role="menuitem">Report</button></yt-list-view-model></yt-contextual-sheet-layout>';
  const card = h.document.querySelector("ytd-rich-item-renderer"); await h.open(card);
  assert.ok(h.row()); assert.equal(h.row().disabled, false);
  h.row().click(); await settle(); assert.equal(card.dataset.focusfeedAutoHidden, "true");
});
test("playing-video metadata menu blocks the current channel and guards against Watch navigation", async t => {
  const h = await setup(t, '<ytd-watch-flexy video-id="abcdefghijk"><div id="player-container-outer"><video></video></div><ytd-watch-metadata><h1>Playing</h1><div id="owner"><a href="/@playing">Playing creator</a></div><div id="actions"><ytd-menu-renderer><button aria-label="More actions">More</button></ytd-menu-renderer></div></ytd-watch-metadata></ytd-watch-flexy>', undefined, "/watch?v=abcdefghijk");
  h.media(h.document.querySelector("video"));
  h.document.querySelector("#actions button").click(); await settle(); assert.ok(h.row());
  h.location.search = "?v=lmnopqrstuv";
  h.row().click(); await settle(); assert.equal(h.blocks.length, 0, "an old main-video menu cannot write after the video changes");
  h.document.querySelector("ytd-watch-flexy").setAttribute("video-id", "lmnopqrstuv");
  h.document.querySelector("#owner a").setAttribute("href", "/@nextcreator");
  h.document.querySelector("#actions button").click(); await settle(); h.row().click(); await settle();
  assert.equal(h.blocks[0].channelId, "@nextcreator");
});
test("captured Watch layout resolves a linkless channel while preserving the Mix and native overflow control", async t => {
  const h = await setup(t, watchFixture, async videoId => ({ videoId, channelId: "@capturedcreator", channelLabel: "Captured Creator" }));
  const video = h.document.querySelector('[data-test="video"]'), mix = h.document.querySelector('[data-test="mix"]');
  await h.open(video); assert.equal(h.row().disabled, false);
  assert.match(h.row().getAttribute("aria-label"), /Captured Creator/);
  assert.equal(h.row().querySelector("svg").getAttribute("viewBox"), "0 0 24 24");
  h.row().click(); await settle(); assert.equal(video.dataset.focusfeedAutoHidden, "true");
  assert.equal(mix.dataset.focusfeedAutoHidden, undefined);
  await h.open(mix); assert.equal(h.row(), null, "a collection has no single-channel block action");
  assert.equal(h.calls.filter(call => call.type === "FF_CHANNEL_RESOLVE").length, 1);
  assert.equal(mix.querySelectorAll("button").length, 1);
});
test("Home leaves collections as native cards with their original destination and accessibility", async t => {
  const h = await setup(t, homePage(watchFixture), async videoId => ({ videoId, channelId: "@capturedcreator" }), "/");
  await settle();
  const mix = h.document.querySelector('[data-test="mix"]');
  assert.equal(mix.dataset.focusfeedFocusWithheld, undefined);
  assert.equal(mix.closest('[aria-hidden="true"]'), null);
  assert.match(mix.querySelector("a").getAttribute("href"), /list=RDMM/);
  assert.equal(h.document.querySelectorAll(".focusfeed-card").length, 0, "all cards retain their native presentation");
  await h.open(mix); assert.equal(h.row(), null);
  assert.equal(h.calls.filter(call => call.type === "FF_CHANNEL_RESOLVE").length, 0);
});
test("collaboration metadata offers separate channel choices and blocks videos of either creator", async t => {
  const h = await setup(t, withoutChannel("abcdefghijk") + videoCard("lmnopqrstuv", "@partner") + videoCard("zyxwvutsrqp", "@publisher"));
  h.feed({ lockupViewModel: { contentId: "abcdefghijk", contentType: "LOCKUP_CONTENT_TYPE_VIDEO", metadata: {
    lockupMetadataViewModel: { title: { content: "Video abcdefghijk" }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [
      { text: { content: "Publisher", commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: "UCpublisher12345", canonicalBaseUrl: "/@publisher" } } } }] } },
      { text: { content: "Partner", commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: "UCpartner1234567", canonicalBaseUrl: "/@partner" } } } }] } }
    ] }] } } }
  } } });
  const cards = h.document.querySelectorAll("ytd-rich-item-renderer"); await h.open(cards[0]);
  const choices = h.document.querySelectorAll(".focusfeed-menu-action"); assert.equal(choices.length, 2);
  assert.match(choices[0].textContent, /Block Publisher/); assert.match(choices[1].textContent, /Block Partner/);
  choices[1].click(); await settle();
  assert.equal(h.blocks[0].channelId, "UCpartner1234567");
  assert.equal(cards[0].dataset.focusfeedAutoHidden, "true");
  assert.equal(cards[1].dataset.focusfeedAutoHidden, "true");
  assert.equal(cards[2].dataset.focusfeedAutoHidden, undefined, "blocking a collaborator does not block the publisher alone");
});
test("a channel mentioned in a description is not treated as a collaborator", async t => {
  const html = videoCard("abcdefghijk", "@publisher").replace('<a href="/@publisher">@publisher</a>',
    '<div id="channel-name"><a href="/@publisher">Publisher</a></div><div id="description-text">Thanks to <a href="/@mentioned">a mentioned channel</a></div>');
  const h = await setup(t, html); h.blocks.push({ scope: "global", channelId: "@mentioned" });
  h.feed({ videoRenderer: { videoId: "abcdefghijk", title: { simpleText: "Video abcdefghijk" }, ownerText: {
    runs: [{ text: "Publisher", navigationEndpoint: { browseEndpoint: { browseId: "UCpublisher12345", canonicalBaseUrl: "/@publisher" } } }]
  } } });
  const card = h.document.querySelector("ytd-rich-item-renderer"); await h.open(card);
  assert.equal(card.dataset.focusfeedAutoHidden, undefined);
  assert.equal(h.document.querySelectorAll(".focusfeed-menu-action").length, 1);
  assert.doesNotMatch(h.row().getAttribute("aria-label"), /mentioned/);
});
