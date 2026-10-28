"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Small DOM fixture for lifecycle behavior. It does not assert YouTube's live selectors.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.isConnected = true; this.className = ""; }
  appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = true; return child; }
  append(...children) { children.forEach(c => this.appendChild(c)); }
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] || null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
  toggleAttribute(k, force) { const active = force === undefined ? !this.hasAttribute(k) : force; if (active) this.setAttribute(k, ""); else this.removeAttribute(k); return active; }
  removeAttribute(k) { delete this.attributes[k]; if (k === "data-focusfeed-playback") delete this.dataset.focusfeedPlayback; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  dispatchEvent() {}
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { top: 10, bottom: 200 }; }
  matches(selector) { return selector.split(",").some(raw => {
    const s = raw.trim();
    if (s[0] === ".") return this.className.split(" ").includes(s.slice(1));
    if (s === "[data-focusfeed-playback]") return !!this.dataset.focusfeedPlayback;
    if (s === "#items") return this.attributes.id === "items";
    if (s.includes("[")) return false;
    return this.tagName === s;
  }); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement && this.parentElement.closest(selector); }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function setup(overrides = {}) {
  const body = new Element("body"), listeners = {}, messages = [];
  const menu = body.appendChild(new Element("ytd-menu-popup-renderer"));
  const items = menu.appendChild(new Element("div")); items.setAttribute("id", "items");
  let surface = null;
  const document = { body, documentElement: body, createElement: t => new Element(t), createElementNS: (_namespace, t) => new Element(t),
    querySelector: () => surface, querySelectorAll: s => body.querySelectorAll(s),
    addEventListener: (type, fn) => { listeners[type] = fn; } };
  const context = vm.createContext({ document, location: { pathname: "/", href: "https://www.youtube.com/" }, URL,
    setTimeout: (fn, ms) => ms > 1000 ? 0 : setTimeout(fn, ms), clearTimeout, KeyboardEvent: class {},
    chrome: { runtime: { sendMessage: async message => {
      messages.push(message);
      return { ok: true, data: { created: true, block: { id: "block1" } } };
    } } }, ...overrides });
  ["channel-policy.js", "youtube-ui.js"].forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context));
  const ui = context.FocusFeedYouTubeUI.create({ lookup: () => null, extract: () => null });
  ui.setRuntime({ reload: async () => {}, tick() {} });
  function trigger(channelId) {
    const card = body.appendChild(new Element("ytd-video-renderer"));
    const control = card.appendChild(new Element("ytd-menu-renderer"));
    const button = control.appendChild(new Element("yt-icon-button"));
    ui.render(card, { videoId: channelId, channelId, channel: "Channel " + channelId, aliases: [channelId] }, "show");
    listeners.click({ target: button }); ui.decorate();
    return items.querySelector(".focusfeed-menu-action");
  }
  return { ui, trigger, items, body, messages, listeners, context,
    setPlayer: () => { context.location.pathname = "/watch"; surface = body.appendChild(new Element("div")); return surface; } };
}
test("reused menus cannot block a previously selected channel; keyboard and Undo work", async () => {
  const h = setup();
  const first = h.trigger("@first"); assert.ok(first); assert.equal(first.disabled, false);
  const second = h.trigger("@second"); assert.equal(h.items.querySelectorAll(".focusfeed-menu-action").length, 1);
  const click = { preventDefault() {}, stopPropagation() {} };
  await first.listeners.click(click); assert.equal(h.messages.length, 0, "stale callback ignored");
  await second.listeners.click(click); assert.equal(h.messages[0].channel.channelId, "@second");
  assert.equal(h.messages[0].scope, "global");
  const toast = h.body.querySelector(".focusfeed-toast"); assert.ok(toast);
  await toast.querySelector("button").listeners.click(); assert.equal(h.messages[1].type, "FF_BLOCK_REMOVE");
  const unknown = h.trigger(""); assert.equal(unknown.disabled, true);
  h.listeners.keydown({ key: "Escape" }); await unknown.listeners.click(click); assert.equal(h.messages.length, 2);
  await sleep(160);
});
test("only explicit playback blocks pause media; semantic checking and errors never show a player popup", () => {
  const h = setup(), surface = h.setPlayer(), video = surface.appendChild(new Element("video"));
  video.paused = false; video.pause = () => { video.paused = true; };
  video.play = () => { video.paused = false; return Promise.resolve(); };
  const metadata = { videoId: "v1", channelId: "@creator" };
  h.ui.render(surface, metadata, "hide", "channel_block");
  assert.equal(video.paused, true); assert.equal(surface.dataset.focusfeedPlayback, "true");
  assert.equal(h.body.querySelector(".focusfeed-playback").querySelector("button"), null);
  video.paused = false; h.listeners.play({ target: video }); assert.equal(video.paused, true);
  h.ui.render(surface, metadata, "show");
  assert.equal(video.paused, false); assert.equal(h.body.querySelector(".focusfeed-playback"), null);
  for (const [action, reason] of [["pending", "model_pending"], ["hide", "model"], ["hide", "unavailable"]]) {
    h.ui.render(surface, metadata, action, reason);
    assert.equal(video.paused, false);
    assert.equal(h.body.querySelector(".focusfeed-playback"), null);
    assert.equal(surface.dataset.focusfeedPlayback, undefined);
  }
});
