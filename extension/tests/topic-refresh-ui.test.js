"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, homePage, videoCard } = require("./dom-harness");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topic = text => ({ id: text, text, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" });
async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (!predicate() && performance.now() < deadline) await sleep(10);
  assert.ok(predicate(), "topic refresh did not settle");
}
test("adding a blocked topic dims existing General cards before hiding a new match", async t => {
  const h = dom(homePage(videoCard("abcdefghijk")));
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  const prefs = { schemaVersion: 2, revision: 1, enabled: true, hideShorts: false,
    general: { id: "general", mode: "general", version: 1, objectives: [topic("gaming")] },
    focus: { id: "focus", mode: "focus", version: 0, objectives: [] }, focusSession: { active: false } };
  const listeners = []; let finish, requests = 0;
  h.context.chrome = { storage: { onChanged: { addListener: fn => listeners.push(fn) }, local: { get: async () => ({ focusfeedSettingsV2: prefs }) } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
      requests++;
      const matches = message.request.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: o.id === "reviews" ? .95 : .05 }));
      const response = { ok: true, data: { ok: true, data: { assessments: [{ videoId: "abcdefghijk",
        objectiveMatches: matches, outcome: h.context.FocusFeedVideo.outcome(matches), reason: "fixture" }] } } };
      return matches.length > 1 ? new Promise(resolve => { finish = () => resolve(response); }) : response;
    } } };
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  const card = h.document.querySelector("ytd-rich-item-renderer"), title = card.querySelector("#video-title-link"), original = card.innerHTML;
  await until(() => requests === 1 && !card.hasAttribute("data-focusfeed-auto-pending"));
  prefs.general.objectives.push(topic("reviews")); prefs.general.version++; prefs.revision++;
  listeners.forEach(fn => fn({ focusfeedSettingsV2: { newValue: prefs } }, "local"));
  await until(() => card.hasAttribute("data-focusfeed-refreshing"));
  assert.match(card.querySelector(".focusfeed-card-status").textContent, /Updating filters/);
  assert.equal(card.querySelector(".focusfeed-card-loading"), null);
  assert.equal(card.querySelector("#video-title-link"), title);
  assert.equal(title.inert, true); assert.equal(card.getAttribute("aria-busy"), "true");
  assert.equal(card.hasAttribute("data-focusfeed-auto-hidden"), false);
  await until(() => !!finish); finish();
  await until(() => card.hasAttribute("data-focusfeed-auto-hidden"));
  assert.equal(card.innerHTML, original); assert.equal(card.getAttribute("aria-busy"), null);
  assert.equal(card.hasAttribute("data-focusfeed-refreshing"), false); assert.equal(title.inert, false);
});
test("late card metadata revalidates quietly without dimming an already checked video", async t => {
  const h = dom(homePage(videoCard("abcdefghijk")));
  let finish, requests = 0;
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); if (finish) finish(); h.cleanup(); });
  const prefs = { schemaVersion: 2, revision: 1, enabled: true,
    general: { id: "general", mode: "general", version: 1, objectives: [topic("gaming")] },
    focus: { id: "focus", mode: "focus", version: 0, objectives: [] }, focusSession: { active: false } };
  h.context.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async () => ({ focusfeedSettingsV2: prefs }) } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
      requests++;
      const response = { ok: true, data: { ok: true, data: { assessments: [{ videoId: "abcdefghijk", outcome: "no_match",
        objectiveMatches: [{ objectiveId: "gaming", text: "gaming", contentType: "topic", matchProbability: .05 }], reason: "fixture" }] } } };
      return requests === 1 ? response : new Promise(resolve => { finish = () => resolve(response); });
    } } };
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  const card = h.document.querySelector("ytd-rich-item-renderer"), title = card.querySelector("#video-title-link");
  await until(() => requests === 1 && !card.hasAttribute("data-focusfeed-auto-pending"));
  const snippet = h.document.createElement("div"); snippet.id = "description-text"; snippet.textContent = "A description supplied after the first render.";
  card.appendChild(snippet);
  await until(() => !!finish);
  assert.equal(card.querySelector(".focusfeed-card-status"), null);
  assert.equal(card.hasAttribute("data-focusfeed-refreshing"), false);
  assert.equal(card.hasAttribute("data-focusfeed-auto-pending"), false);
  assert.equal(!!title.inert, false);
  assert.equal(card.getAttribute("aria-busy"), null);
  assert.equal(h.document.querySelector(".focusfeed-feed-progress"), null);
  finish(); await sleep(50);
  assert.equal(card.hasAttribute("data-focusfeed-auto-hidden"), false);
  assert.equal(card.querySelector(".focusfeed-card-status"), null);
  await sleep(350); assert.equal(requests, 2, "unchanged rescans reuse the revalidated result");
});
