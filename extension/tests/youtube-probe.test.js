"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { dom, videoCard } = require("./dom-harness");
const code = fs.readFileSync(path.join(__dirname, "../../tools/youtube-probe.js"), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const h = dom('<ytd-app>' + videoCard("abcdefghijk", "@Creator") + '</ytd-app><ytd-popup-container></ytd-popup-container>', '/watch?v=abcdefghijk&si=tracking-secret');
  t.after(() => { h.window.FFProbe?.stop(); h.cleanup(); });
  Object.assign(h.context, { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    navigator: { userAgent: "test browser" }, matchMedia: () => ({ matches: false }), console: { info() {} },
    fetch: () => { throw new Error("Probe must not perform network requests"); },
    getComputedStyle(node) {
      const dark = h.document.documentElement.hasAttribute("dark");
      return { color: dark ? "rgb(241, 241, 241)" : "rgb(15, 15, 15)", backgroundColor: dark ? "rgb(15, 15, 15)" : "rgb(255, 255, 255)",
        display: node.hasAttribute("hidden") ? "none" : "block", visibility: "visible", opacity: "1", font: "14px Roboto", pointerEvents: "auto",
        getPropertyValue: () => dark ? "#f1f1f1" : "#0f0f0f" };
    }
  });
  Object.defineProperty(h.document, "cookie", { get() { throw new Error("Probe must not read cookies"); } });
  h.run = () => vm.runInContext(code, h.context, { filename: "youtube-probe.js" });
  h.run(); return h;
}
test("probe collects DOM and renderer channel evidence without recording unrelated private data or changing the page", t => {
  const h = setup(t), card = h.document.querySelector("ytd-rich-item-renderer");
  card.data = { videoId: "abcdefghijk", ownerText: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: "UCcreator123456" } } }] }, authToken: "do-not-export-this" };
  card.data.cycle = card.data;
  const before = h.document.body.innerHTML;
  const details = h.window.FFProbe.inspect(card);
  assert.deepEqual(Array.from(details.card.channelIds).sort(), ["@creator", "UCcreator123456"].sort());
  assert.equal(details.card.videoId, "abcdefghijk");
  const report = h.window.FFProbe.finish(), json = JSON.stringify(report);
  assert.doesNotMatch(json, /tracking-secret|do-not-export-this/);
  assert.equal(report.running, false); assert.equal(h.document.body.innerHTML, before);
});
test("probe records real theme samples, hover events and changing menu availability, then removes its listeners", async t => {
  const h = setup(t); h.window.FFProbe.start("watch-dark-enabled");
  h.document.documentElement.setAttribute("dark", "");
  h.window.FFProbe.capture("dark");
  const card = h.document.querySelector("ytd-rich-item-renderer");
  card.dispatchEvent(new h.window.Event("pointerover", { bubbles: true }));
  h.document.querySelector("ytd-popup-container").innerHTML = '<ytd-menu-popup-renderer><button class="focusfeed-menu-action" disabled>Block channel <small>Finding channel…</small></button></ytd-menu-popup-renderer>';
  await settle();
  const button = h.document.querySelector(".focusfeed-menu-action"); button.disabled = false;
  await settle();
  const report = h.window.FFProbe.report();
  assert.ok(report.events.some(event => event.type === "pointerover" && event.card.videoId === "abcdefghijk"));
  const dark = report.snapshots.find(snapshot => snapshot.label === "dark");
  assert.equal(dark.page.theme.html.color, "rgb(241, 241, 241)");
  assert.ok(report.snapshots.some(snapshot => snapshot.menus.some(menu => menu.rows.some(row => row.text.includes("Block channel") && row.style.disabled === false))));
  h.window.FFProbe.stop(); const count = h.window.FFProbe.report().events.length;
  card.dispatchEvent(new h.window.Event("click", { bubbles: true }));
  assert.equal(h.window.FFProbe.report().events.length, count);
});
test("repeated hovers cannot overwrite the baseline or the captured extension menu row", async t => {
  const h = setup(t);
  const nativeRows = Array.from({ length: 12 }, (_, i) => '<yt-list-item-view-model><button role="menuitem">Native action ' + i + '</button></yt-list-item-view-model>').join("");
  h.document.querySelector("ytd-popup-container").innerHTML = '<ytd-menu-popup-renderer>' + nativeRows + '<button class="focusfeed-menu-action">Block channel</button></ytd-menu-popup-renderer>';
  await settle();
  for (let i = 0; i < 40; i++) h.window.FFProbe.capture("after-hover");
  const report = h.window.FFProbe.finish();
  assert.ok(report.snapshots.some(snapshot => snapshot.label === "start"));
  const menu = report.snapshots.find(snapshot => snapshot.label === "menu-changed").menus[0];
  assert.ok(menu.rows.some(row => row.focusfeed && row.text === "Block channel"));
  assert.ok(report.dropped.snapshots > 0);
});
test("probe records hidden/pending transitions and recycling of the same watched card", async t => {
  const h = setup(t), card = h.document.querySelector("ytd-rich-item-renderer");
  h.window.FFProbe.watch(card.querySelector("#video-title-link"));
  const original = h.window.FFProbe.report().transitions.find(entry => entry.after?.title === "Video abcdefghijk");
  card.setAttribute("data-focusfeed-auto-pending", "true"); await settle();
  card.removeAttribute("data-focusfeed-auto-pending"); card.setAttribute("data-focusfeed-auto-hidden", "true"); await settle();
  card.removeAttribute("data-focusfeed-auto-hidden"); await settle();
  card.querySelector("#video-title-link").setAttribute("href", "/watch?v=lmnopqrstuv");
  card.querySelector("#video-title-link").textContent = "Recycled video";
  const report = h.window.FFProbe.finish();
  assert.equal(report.version, 5);
  assert.ok(report.transitions.some(entry => entry.attribute === "data-focusfeed-auto-pending" && entry.value === "true"));
  assert.ok(report.transitions.some(entry => entry.attribute === "data-focusfeed-auto-hidden" && entry.oldValue === "true"));
  assert.ok(report.transitions.some(entry => entry.before?.title === "Video abcdefghijk" &&
    entry.after?.title === "Recycled video" && entry.after.nodeID === original.after.nodeID));
  assert.ok(report.snapshots.at(-1).watchedCards.some(entry => entry.videoId === "lmnopqrstuv"));
});
test("probe captures the main Watch action trigger and unsupported popup structures", async t => {
  const h = setup(t);
  h.document.querySelector("ytd-app").insertAdjacentHTML("beforeend", '<ytd-watch-flexy video-id="playing1234"><div id="player-container-outer"><video></video></div><ytd-watch-metadata><h1>Playing title</h1><div id="owner"><a href="/@playingcreator">Playing creator</a></div><div id="actions"><ytd-menu-renderer><button aria-label="More actions">More</button></ytd-menu-renderer></div></ytd-watch-metadata></ytd-watch-flexy>');
  h.document.querySelector("#actions button").click();
  h.document.querySelector("ytd-popup-container").innerHTML = '<yt-contextual-sheet-layout><button role="menuitem">Report</button></yt-contextual-sheet-layout>';
  await settle();
  const report = h.window.FFProbe.finish(), trigger = report.menuTriggers.at(-1);
  assert.equal(trigger.card, null);
  assert.equal(trigger.watch.rendererVideoId, "playing1234");
  assert.equal(trigger.watch.ownerLinks[0].channelId, "@playingcreator");
  assert.ok(trigger.ancestors.some(node => node.tag === "ytd-watch-metadata"));
  assert.ok(report.snapshots.some(snapshot => snapshot.menus.some(menu => menu.style.tag === "yt-contextual-sheet-layout")));
});
test("probe records collection identity separately from its seed video", t => {
  const h = setup(t);
  h.document.querySelector("ytd-app").insertAdjacentHTML("beforeend", '<ytd-radio-renderer><a id="video-title" href="/watch?v=seed1234567&list=RDmusic123">Mix - Songs</a><div id="metadata-line">Music collection</div></ytd-radio-renderer>');
  const card = h.document.querySelector("ytd-radio-renderer"), details = h.window.FFProbe.watch(card);
  assert.equal(details.collection.structuralEvidence, true);
  assert.equal(details.collection.playlistId, "RDmusic123");
  assert.equal(details.videoId, "seed1234567");
  assert.equal(details.collection.metadata[0], "Music collection");
  assert.equal(h.window.FFProbe.finish().snapshots.at(-1).watchedCards[0].collection.playlistId, "RDmusic123");
});

test("probe recognizes a player recommendation whose video link is the card itself", t => {
  const h = setup(t);
  h.document.body.insertAdjacentHTML("beforeend", '<div id="movie_player"><a class="ytp-modern-videowall-still" href="/watch?v=player12345&list=RDmusic123"><div class="ytp-modern-videowall-still-info-title">Player title</div><div class="ytp-modern-videowall-still-listlabel">Mix</div></a></div>');
  const card = h.document.querySelector(".ytp-modern-videowall-still");
  card.dataset.focusfeedAutoHidden = "true";
  const details = h.window.FFProbe.watch(card.querySelector("div"));
  assert.equal(details.videoId, "player12345"); assert.equal(details.title, "Player title");
  assert.equal(details.playerRecommendation, true); assert.equal(details.filtering.hidden, "true");
  assert.equal(details.collection.playlistId, "RDmusic123"); assert.equal(details.collection.structuralEvidence, true);
});
test("probe exports loading geometry and feed progress without mutating native content", t => {
  const h = setup(t), card = h.document.querySelector("ytd-rich-item-renderer");
  card.setAttribute("aria-busy", "true"); card.inert = true;
  card.insertAdjacentHTML("beforeend", '<div class="focusfeed-card-loading"><span class="focusfeed-loading-shape"></span></div>');
  h.document.body.insertAdjacentHTML("beforeend", '<div class="focusfeed-feed-progress">Updating your recommendations…</div>');
  const before = h.document.body.innerHTML;
  const snapshot = h.window.FFProbe.capture("loading-check");
  assert.equal(snapshot.page.loading.overlays, 1);
  assert.match(snapshot.page.loading.message, /Updating/);
  assert.equal(snapshot.cards[0].loading.busy, "true"); assert.equal(snapshot.cards[0].loading.inert, true);
  assert.equal(snapshot.cards[0].loading.shapes.length, 1);
  assert.equal(h.document.body.innerHTML, before);
});
