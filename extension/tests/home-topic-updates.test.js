"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom, homePage, videoCard } = require("./dom-harness");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const topic = id => ({ id, text: id, sourceText: id, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" });
async function until(predicate) {
  const until = performance.now() + 3000;
  while (!predicate() && performance.now() < until) await sleep(10);
  assert.ok(predicate(), "Home did not settle");
}
test("Focus Home keeps every admitted card through topic removal and a delayed topic replacement", async t => {
  const h = dom(homePage(Array.from({ length: 36 }, (_, i) => videoCard("home" + i)).join("")));
  t.after(() => { h.window.dispatchEvent(new h.window.Event("pagehide")); h.cleanup(); });
  const science = topic("science"), songs = topic("songs"), gaming = topic("gaming");
  const settings = { schemaVersion: 2, revision: 1, enabled: true, hideShorts: false,
    general: { id: "general", mode: "general", version: 0, objectives: [] },
    focus: { id: "focus", mode: "focus", version: 1, objectives: [science, songs] }, focusSession: { active: true } };
  const source = h.document.querySelector("#contents"); let bottom = 200, requests = 0;
  source.getBoundingClientRect = () => ({ top: 0, bottom });
  const listeners = [], delayed = [];
  h.context.chrome = { storage: { onChanged: { addListener: fn => listeners.push(fn) }, local: { get: async () => ({ focusfeedSettingsV2: settings }) } }, runtime: {
    onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type !== "FF_AUTO_CLASSIFY") return { ok: true };
      requests++;
      const response = { ok: true, data: { ok: true, data: { assessments: message.request.videos.map(video => {
        const matches = message.request.profile.objectives.map(o => ({ objectiveId: o.id, text: o.text, contentType: "topic",
          matchProbability: o.text === "songs" || o.text === "science" && video.videoId !== "home35" ? .95 : .05 }));
        return { videoId: video.videoId, outcome: h.context.FocusFeedVideo.outcome(matches), objectiveMatches: matches, reason: "fixture" };
      }) } } };
      return message.request.profile.objectives.some(o => o.id === "gaming") ? new Promise(resolve => delayed.push(() => resolve(response))) : response;
    }
  } };
  h.load(...require("../manifest.json").content_scripts.find(group => group.world === "ISOLATED").js);
  const cards = Array.from(source.querySelectorAll("ytd-rich-item-renderer")), first = cards[0], last = cards[35];
  await until(() => requests === 2 && cards.every(card => !card.hasAttribute("data-focusfeed-auto-pending") && !card.hasAttribute("data-focusfeed-focus-withheld")));
  bottom = 5000;
  const withheldTransitions = [];
  const observer = new h.window.MutationObserver(records => records.forEach(r => { if (r.target.hasAttribute("data-focusfeed-focus-withheld")) withheldTransitions.push(r.target); }));
  observer.observe(source, { subtree: true, attributes: true, attributeFilter: ["data-focusfeed-focus-withheld"] });
  t.after(() => observer.disconnect());
  function save(objectives) {
    settings.focus.objectives = objectives; settings.focus.version++; settings.revision++;
    listeners.forEach(fn => fn({ focusfeedSettingsV2: { newValue: settings } }, "local"));
  }
  save([science]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.dataset.focusfeedAutoPending, undefined); assert.equal(first.dataset.focusfeedAutoHidden, undefined);
  assert.equal(last.dataset.focusfeedAutoHidden, "true", "a match for only the removed topic must disappear");
  assert.ok(cards.every(card => !card.hasAttribute("data-focusfeed-focus-withheld")), "topic edits must not withhold previously admitted Home cards");
  assert.equal(requests, 2, "removal derives from existing per-topic scores");
  save([gaming]); await new Promise(resolve => setImmediate(resolve));
  assert.ok(cards.every(card => !card.hasAttribute("data-focusfeed-focus-withheld") && !card.hasAttribute("data-focusfeed-auto-pending")), "replacement preserves previous presentation while missing scores load");
  assert.equal(first.dataset.focusfeedAutoHidden, undefined); assert.equal(last.dataset.focusfeedAutoHidden, "true");
  assert.equal(withheldTransitions.length, 0, "no transient Home withholding on either topic edit");
  await until(() => delayed.length > 0);
  while (delayed.length) delayed.shift()();
  await until(() => cards.every(card => card.dataset.focusfeedAutoHidden === "true"));
  assert.equal(first.parentNode, source); assert.equal(last.parentNode, source);
});
