"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, videoCard, homePage, extract } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(t, cards) {
  const h = dom(homePage(cards)); t.after(h.cleanup);
  h.load("channel-policy.js", "settings.js", "home-feed.js");
  const decisions = {}, reasons = {}, observed = [], blocked = [];
  let home;
  const runtime = { observe(target, video) { observed.push(video); home.render(target, video, decisions[video.videoId] || "pending", reasons[video.videoId] || "model"); } };
  home = h.context.FocusFeedHomeFeed.create({ requestScan: () => home.scan(extract, runtime), settings: async () => {}, block: async v => blocked.push(v) });
  home.configure({ enabled: true, hideShorts: false });
  const scan = () => home.scan(extract, runtime);
  t.after(home.clear);
  return { ...h, home, decisions, reasons, observed, blocked, scan };
}
test("Home publishes only a settled batch, with consistent thumbnail/title/destination/menu identity", async t => {
  const h = setup(t, videoCard("one") + videoCard("two"));
  h.decisions.one = "show"; h.scan(); await settle();
  assert.equal(h.document.querySelectorAll(".focusfeed-card").length, 0, "do not publish a partial batch");
  assert.equal(h.document.querySelector(".focusfeed-loading").hidden, false);
  h.decisions.two = "hide"; h.scan(); await settle();
  const cards = h.document.querySelectorAll(".focusfeed-card"); assert.equal(cards.length, 1);
  const card = cards[0]; assert.equal(card.dataset.videoId, "one");
  assert.equal(card.querySelector(".focusfeed-card-title").textContent, "Video one");
  assert.equal(card.querySelector(".focusfeed-card-title").getAttribute("href"), "/watch?v=one");
  assert.equal(card.querySelector(".focusfeed-thumbnail").getAttribute("href"), "/watch?v=one");
  assert.match(card.querySelector("img").src, /\/vi\/one\//);
  assert.equal(card.querySelector("video"), null, "owned cards never create native hover media");
  card.querySelector("button").click(); await settle();
  assert.equal(h.blocked[0].videoId, "one"); assert.equal(h.blocked[0].channelId, "@one");
});

function focusState(text = "DSA tutorials") {
  return { enabled: true, focusSession: { active: true }, general: { mode: "general", version: 0, objectives: [] },
    focus: { mode: "focus", version: 1, objectives: [{ id: "intent-test", text, sourceText: text,
      contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" }] } };
}
function twentyFour(h) { for (let i = 0; i < 24; i++) h.decisions["v" + i] = "hide"; }
function candidates() { return Array.from({ length: 24 }, (_, i) => videoCard("v" + i)).join(""); }
test("Focus offers an encoded goal search after two unique completed batches, never after repeated scans", async t => {
  const h = setup(t, candidates()); h.home.configure(focusState("DSA & graph tutorials")); twentyFour(h);
  h.scan(); await settle(); h.scan(); h.scan(); await settle();
  assert.equal(h.document.querySelector(".focusfeed-discovery").hidden, true);
  h.document.querySelector(".focusfeed-more").click(); await settle();
  const discovery = h.document.querySelector(".focusfeed-discovery");
  assert.equal(discovery.hidden, false); assert.match(discovery.textContent, /24 recommendations checked/);
  const search = new URL(discovery.querySelector("a").getAttribute("href"), h.location);
  assert.equal(search.pathname, "/results"); assert.equal(search.searchParams.get("search_query"), "DSA & graph tutorials");
  assert.equal(h.location.pathname, "/", "search requires an explicit click");
  h.scan(); await settle(); assert.match(discovery.textContent, /24 recommendations checked/);
});
test("pending or failed checks do not trigger discovery; successful retries can settle the same batch", async t => {
  const h = setup(t, candidates()); h.home.configure(focusState()); twentyFour(h);
  h.scan(); h.document.querySelector(".focusfeed-more").click(); await settle();
  h.reasons.v23 = "unavailable"; h.scan(); await settle();
  assert.equal(h.document.querySelector(".focusfeed-discovery").hidden, true);
  assert.match(h.document.querySelector(".focusfeed-feed-status").textContent, /could not be checked/);
  h.reasons.v23 = "model"; h.decisions.v23 = "pending"; h.scan(); await settle();
  assert.equal(h.document.querySelector(".focusfeed-discovery").hidden, true);
  h.decisions.v23 = "hide"; h.scan(); await settle();
  assert.equal(h.document.querySelector(".focusfeed-discovery").hidden, false);
});
test("a visible match, General mode or expired Focus suppresses the search fallback", async t => {
  const h = setup(t, candidates()), state = focusState(); h.home.configure(state); twentyFour(h);
  h.scan(); h.document.querySelector(".focusfeed-more").click(); await settle();
  h.decisions.v0 = "show"; h.scan(); await settle();
  assert.equal(h.document.querySelector(".focusfeed-discovery").hidden, true);
  h.decisions.v0 = "hide"; state.focusSession.endsAt = "2000-01-01"; h.home.configure(state); h.scan(); await settle();
  assert.equal(h.document.querySelector(".focusfeed-discovery").hidden, true);
});
test("changed goals hide stale discovery until rechecked; duplicates and navigation do not invent batches", async t => {
  const h = setup(t, candidates()); h.home.configure(focusState()); twentyFour(h);
  h.scan(); h.document.querySelector(".focusfeed-more").click(); await settle();
  h.home.configure(focusState("Sumerian cuneiform tutorials"));
  assert.equal(h.document.querySelector(".focusfeed-discovery").hidden, true);
  h.scan(); await settle(); assert.match(h.document.querySelector(".focusfeed-discovery a").textContent, /Sumerian/);
  h.home.suspend(); h.location.pathname = "/results"; assert.equal(h.scan(), false);
  h.location.pathname = "/"; h.scan(); await settle();
  assert.match(h.document.querySelector(".focusfeed-discovery").textContent, /24 recommendations checked/);
});
test("new batches append without replacing existing cards; duplicates and recycled sources cannot change their video", async t => {
  const h = setup(t, videoCard("one") + videoCard("one"));
  h.decisions.one = "show"; h.scan(); await settle();
  const first = h.document.querySelector(".focusfeed-card");
  const source = h.document.querySelector("[data-focusfeed-home-source]");
  source.insertAdjacentHTML("afterbegin", videoCard("two")); h.decisions.two = "show";
  h.scan(); await settle(); assert.equal(h.document.querySelectorAll(".focusfeed-card").length, 1);
  h.document.querySelector(".focusfeed-more").click(); await settle();
  assert.equal(h.document.querySelectorAll(".focusfeed-card").length, 2);
  assert.equal(h.document.querySelector(".focusfeed-card"), first);
  assert.equal(first.querySelector("a").getAttribute("href"), "/watch?v=one");
  h.scan(); await settle(); assert.equal(h.document.querySelectorAll(".focusfeed-card").length, 2);
});
test("rejected published videos keep their slot and clear the old click target", async t => {
  const h = setup(t, videoCard("one") + videoCard("two"));
  h.decisions.one = h.decisions.two = "show"; h.scan(); await settle();
  const first = h.document.querySelector(".focusfeed-card"), second = first.nextElementSibling;
  h.decisions.one = "hide"; h.scan(); await settle();
  assert.equal(first.nextElementSibling, second);
  assert.equal(first.querySelector("a"), null); assert.match(first.textContent, /filtered/);
  assert.equal(first.style.height, "200px");
});
test("native pagination stays mounted; one explicit expansion releases one real continuation", async t => {
  const h = setup(t, videoCard("one"));
  const continuation = h.document.querySelector("ytd-continuation-item-renderer"), parent = continuation.parentNode;
  h.decisions.one = "show"; h.scan(); await settle(); h.scan();
  assert.equal(continuation.parentNode, parent);
  assert.equal(h.messages.filter(m => m.type === "FOCUSFEED_PAGE_GATE_CONFIG" && m.enabled).length, 1);
  h.document.querySelector(".focusfeed-more").click(); h.document.querySelector(".focusfeed-more").click();
  assert.equal(h.messages.filter(m => m.type === "FOCUSFEED_PAGE_GATE_MORE").length, 1);
  h.home.clear(); assert.equal(h.document.querySelector(".focusfeed-home"), null);
  assert.equal(parent.hasAttribute("data-focusfeed-home-source"), false);
  assert.equal(parent.hasAttribute("aria-hidden"), false);
  assert.equal(continuation.parentNode, parent);
});
test("a recycled native node supplies a new identity without retargeting an existing owned card", async t => {
  const h = setup(t, videoCard("one")); h.decisions.one = "show"; h.scan(); await settle();
  const first = h.document.querySelector(".focusfeed-card"), native = h.document.querySelector("#video-title-link");
  native.setAttribute("href", "/watch?v=two"); native.textContent = "Video two";
  h.decisions.two = "show"; h.scan(); h.document.querySelector(".focusfeed-more").click(); await settle();
  assert.equal(first.querySelector("a").getAttribute("href"), "/watch?v=one");
  assert.equal(h.document.querySelectorAll(".focusfeed-card").length, 2);
});
test("Home → Watch → Home preserves published slots and expansion instead of shrinking the feed", async t => {
  const h = setup(t, videoCard("one")); h.decisions.one = "show"; h.scan(); await settle();
  const first = h.document.querySelector(".focusfeed-card");
  h.home.suspend(); h.location.pathname = "/watch"; h.location.search = "?v=one";
  assert.equal(h.scan(), false); assert.equal(h.document.querySelector(".focusfeed-home"), null);
  h.location.pathname = "/"; h.location.search = ""; h.scan(); await settle();
  assert.equal(h.document.querySelector(".focusfeed-card"), first);
  assert.equal(first.querySelector("a").getAttribute("href"), "/watch?v=one");
});
