"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, videoCard, homePage, extract } = require("./dom-harness");
const settle = () => new Promise(resolve => setImmediate(resolve));
function focusState(text = "DSA tutorials") {
  return { enabled: true, focusSession: { active: true }, general: { mode: "general", version: 0, objectives: [] },
    focus: { mode: "focus", version: 1, objectives: [{ id: "intent-test", text, sourceText: text,
      contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" }] } };
}
function candidates(n = 100) { return Array.from({ length: n }, (_, i) => videoCard("v" + i)).join(""); }
function setup(t, cards, state = focusState()) {
  const h = dom(homePage(cards)); h.load("video-model.js", "channel-policy.js", "settings.js", "home-feed.js");
  const decisions = {}, reasons = {}, observed = [];
  let active = true, home, bottom = 5000;
  const source = h.document.querySelector("#contents"); source.getBoundingClientRect = () => ({ top: 0, bottom });
  const runtime = { observe(card, video) {
    observed.push(video);
    const action = decisions[video.videoId] || "pending";
    home.render(card, video, action, reasons[video.videoId] || "model");
    if (action === "hide") card.dataset.focusfeedAutoHidden = "true"; else delete card.dataset.focusfeedAutoHidden;
  } };
  const scan = () => home.scan(extract, runtime);
  home = h.context.FocusFeedHomeFeed.create({ requestScan: () => Promise.resolve().then(() => { if (active) scan(); }) });
  home.configure(state);
  t.after(() => { active = false; home.clear(); h.cleanup(); });
  return { ...h, source, home, decisions, reasons, observed, scan, nearEnd: () => { bottom = 200; } };
}
function hideAll(h, n = 100) { for (let i = 0; i < n; i++) h.decisions["v" + i] = "hide"; }
test("General keeps native Home cards and continuation without custom UI or a pagination gate", async t => {
  const state = focusState(); state.focusSession.active = false;
  const h = setup(t, candidates(), state), first = h.document.querySelector("ytd-rich-item-renderer");
  assert.equal(h.scan(), false); await settle();
  assert.equal(h.document.querySelector(".focusfeed-home, .focusfeed-more, .focusfeed-discovery"), null);
  assert.equal(first.parentNode, h.source); assert.equal(h.home.owns(first), false);
  assert.equal(h.messages.some(message => message.type === "FOCUSFEED_PAGE_GATE_CONFIG" && message.enabled), false);
});
test("Focus pauses after four low-yield batches and offers an encoded search without navigating", async t => {
  const h = setup(t, candidates(), focusState("DSA & graph tutorials")); hideAll(h);
  h.decisions.v0 = "show"; h.decisions.v13 = "show";
  const first = h.document.querySelector("ytd-rich-item-renderer"); h.scan(); await settle();
  const dialog = h.document.querySelector("dialog.focusfeed-discovery"); assert.ok(dialog && dialog.hasAttribute("open"));
  assert.match(dialog.textContent, /Found 2 confident matches in 80 recommendations across 4 batches/);
  assert.equal(new Set(h.observed.map(v => v.videoId)).size, 80);
  const link = new URL(dialog.querySelector("a").getAttribute("href"), h.location);
  assert.equal(link.searchParams.get("search_query"), "DSA & graph tutorials");
  assert.equal(h.location.pathname, "/"); assert.equal(first.parentNode, h.source);
  assert.equal(h.document.querySelector(".focusfeed-card, .focusfeed-more"), null);
  for (let i = 0; i < 10; i++) h.scan(); await settle();
  assert.equal(new Set(h.observed.map(v => v.videoId)).size, 80);
  assert.ok(h.observed.some(v => v.noNewTopicChecks));
  dialog.querySelectorAll("button")[1].click(); h.scan(); await settle();
  assert.equal(dialog.hasAttribute("open"), false, "dismissal does not cause an immediate new popup");
});
test("pending and failed checks cannot produce a false scarcity popup or trigger more batches", async t => {
  const h = setup(t, candidates()); hideAll(h); h.decisions.v11 = "pending";
  h.scan(); await settle(); assert.equal(new Set(h.observed.map(v => v.videoId)).size, 20);
  assert.equal(h.document.querySelector("dialog"), null);
  h.decisions.v11 = "hide"; h.reasons.v11 = "unavailable"; h.scan(); await settle();
  assert.equal(h.document.querySelector("dialog"), null);
  assert.match(h.document.querySelector(".focusfeed-focus-status").textContent, /could not be checked/);
  assert.equal(new Set(h.observed.map(v => v.videoId)).size, 20);
  assert.ok(h.observed.every(v => v.noAutomaticRetry));
});
test("enough matches stop automatic discovery until the user scrolls toward the feed end", async t => {
  const h = setup(t, candidates()); hideAll(h); h.decisions.v0 = h.decisions.v1 = h.decisions.v2 = "show";
  h.scan(); await settle(); assert.equal(new Set(h.observed.map(v => v.videoId)).size, 20);
  assert.equal(h.document.querySelector("dialog"), null);
  h.decisions.v20 = "pending"; h.nearEnd(); h.scan(); await settle();
  assert.equal(new Set(h.observed.map(v => v.videoId)).size, 40);
});
test("Focus releases a real continuation only when it needs another batch", async t => {
  const h = setup(t, candidates(12)); hideAll(h); const continuation = h.source.querySelector("ytd-continuation-item-renderer");
  h.scan(); await settle();
  assert.equal(h.messages.filter(m => m.type === "FOCUSFEED_PAGE_GATE_MORE").length, 1);
  h.scan(); h.scan(); assert.equal(h.messages.filter(m => m.type === "FOCUSFEED_PAGE_GATE_MORE").length, 1);
  h.source.insertAdjacentHTML("afterbegin", candidates(24)); h.scan(); await settle();
  assert.equal(new Set(h.observed.map(v => v.videoId)).size, 24);
  assert.equal(continuation.parentNode, h.source);
});
test("leaving Focus restores withheld native cards and removes the dialog and gate", async t => {
  const state = focusState(), h = setup(t, candidates(), state); hideAll(h); h.scan(); await settle();
  assert.ok(h.document.querySelector("[data-focusfeed-focus-withheld]"));
  state.focusSession.active = false; h.home.configure(state); assert.equal(h.scan(), false);
  assert.equal(h.document.querySelector("[data-focusfeed-focus-withheld], dialog.focusfeed-discovery"), null);
  assert.equal(h.messages.at(-1).enabled, false);
});
test("changing the goal resets the old popup and batch budget", async t => {
  const h = setup(t, candidates()); hideAll(h); h.scan(); await settle();
  h.home.configure(focusState("Sumerian cuneiform tutorials")); assert.equal(h.document.querySelector("dialog"), null);
  h.scan(); await settle(); assert.match(h.document.querySelector("dialog a").textContent, /Sumerian/);
});
test("timer-only edits preserve the Home discovery budget and current gate", async t => {
  const state = focusState(), h = setup(t, candidates(), state); hideAll(h); h.scan(); await settle();
  const dialog = h.document.querySelector("dialog.focusfeed-discovery"), count = h.messages.length;
  state.focus.version++; state.focus.sessionDurationMinutes = 60; h.home.configure(state);
  assert.equal(h.document.querySelector("dialog.focusfeed-discovery"), dialog);
  assert.equal(h.messages.length, count);
});
test("a displayed previous decision does not count as a completed check for a new preference", async t => {
  const h = setup(t, candidates()); hideAll(h);
  Object.keys(h.decisions).forEach(id => { h.reasons[id] = "refreshing"; });
  h.scan(); await settle();
  assert.equal(h.document.querySelector("dialog.focusfeed-discovery"), null);
  assert.equal(new Set(h.observed.map(v => v.videoId)).size, 20);
});
