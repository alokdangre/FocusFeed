"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.isConnected = true;
    this.listeners = {};
    this.parentElement = null;
    this.id = "";
    this.className = "";
  }
  appendChild(child) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter(item => item !== child);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, reference) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter(item => item !== child);
    }
    child.parentElement = this;
    const index = this.children.indexOf(reference);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  get nextSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] || null;
  }
  attachShadow() { return this.appendChild(new Element("shadow")); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  querySelector() {
    return this.children.find(item => item.className === "focusfeed-live-label") || null;
  }
  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(item => item !== this);
    }
  }
  removeAttribute(name) {
    delete this.dataset[name.replace(/^data-/, "").replace(/-([a-z])/g, (_match, char) => char.toUpperCase())];
  }
  getBoundingClientRect() { return { top: 50, bottom: 200 }; }
  scrollIntoView() {}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const documentElement = new Element("html");
  const grid = new Element("grid");
  const continuation = new Element("continuation");
  grid.appendChild(continuation);
  documentElement.appendChild(grid);
  function findById(node, id) {
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  }
  const document = {
    documentElement,
    createElement: tag => new Element(tag),
    getElementById: id => findById(documentElement, id),
    querySelector: selector => selector.includes("ytd-continuation-item-renderer")
      ? continuation
      : selector.includes("ytd-rich-grid-renderer")
        ? grid
        : null,
  };
  const listeners = {};
  const sent = [];
  const network = [];
  let onConnect;
  const window = {
    location: { pathname: "/" },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    postMessage: message => network.push(message),
  };
  function dispatch(type, event = {}) {
    (listeners[type] || []).forEach(listener => listener(event));
  }
  const chrome = {
    runtime: {
      getURL: item => "chrome-extension://test/" + item,
      onConnect: { addListener: fn => onConnect = fn },
    },
  };
  const context = vm.createContext({
    window,
    document,
    chrome,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
    console,
  });
  for (const file of ["workflow-core.js", "live/engine.js", "live/content.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }

  let receive;
  let disconnect;
  const port = {
    name: "focusfeed-live",
    sender: {},
    postMessage: message => sent.push(message),
    onMessage: { addListener: fn => receive = fn },
    onDisconnect: { addListener: fn => disconnect = fn },
  };
  const cards = Array.from({ length: 14 }, (_value, index) => ({
    card: new Element(),
    video: { videoId: "v" + index, title: "Video " + index, channel: "Lessons" },
  }));
  let adapter;
  const scan = () => cards.forEach(item => adapter.observe(item.card, item.video));
  adapter = context.FocusFeedLiveContent.create({ scan });

  onConnect(port);
  assert.equal(sent[0].type, "HELLO");
  receive({ type: "HELLO_REQUEST" });
  receive({ type: "START", runId: "r1" });
  await sleep(100);
  assert.equal(cards[0].card.dataset.focusfeedAiPending, "true",
    "a recommendation must stay hidden until its filter decision resolves");
  assert.equal(cards[0].card.children.some(child => child.className === "focusfeed-live-label"), false,
    "filter diagnostics must not be rendered under the recommendation");

  function findByText(node, text) {
    if (node.textContent === text) return node;
    for (const child of node.children || []) {
      const found = findByText(child, text);
      if (found) return found;
    }
    return null;
  }
  const loadMoreControl = findByText(documentElement, "Load 12 more");
  const endHost = findById(documentElement, "focusfeed-load-more-host");
  assert.equal(findById(documentElement, "focusfeed-live-panel"), null,
    "YouTube must not render a fixed FocusFeed action bar");
  assert.ok(loadMoreControl, "YouTube must render Load 12 more");
  assert.equal(endHost.parentElement, grid, "Load more host must live at the end of the Home grid");
  assert.equal(endHost.nextSibling, continuation, "Load more must sit directly before YouTube continuation");
  loadMoreControl.listeners.click({ isTrusted: true });
  assert.equal(sent.at(-1).type, "LOAD_MORE");
  assert.equal(sent.filter(message => message.type === "CANDIDATES")[0].candidates.length, 12);
  assert.equal(cards[12].card.dataset.focusfeedDeferred, "true");

  const fp = context.FocusFeedLiveEngine.fingerprint(cards[0].video);
  receive({
    type: "RESULT",
    runId: "r1",
    record: {
      video: cards[0].video,
      fingerprint: fp,
      action: "hide",
      route: "model",
      status: "resolved",
      reason: "Focus non-match",
    },
  });
  assert.equal(cards[0].card.dataset.focusfeedAiHidden, "true",
    "AI hide decisions must apply as soon as they resolve");
  assert.equal(cards[0].card.dataset.focusfeedAiPending, undefined,
    "a resolved hide must leave the pending state");
  assert.equal(cards[12].card.dataset.focusfeedDeferred, "true");

  receive({
    type: "RESULT",
    runId: "r1",
    record: {
      video: cards[1].video,
      fingerprint: context.FocusFeedLiveEngine.fingerprint(cards[1].video),
      action: "show",
      route: "model",
      status: "resolved",
      reason: "General non-match",
    },
  });
  assert.equal(cards[1].card.dataset.focusfeedAiPending, undefined,
    "a show decision may reveal the recommendation only after it resolves");
  assert.equal(cards[1].card.dataset.focusfeedAiHidden, undefined);

  adapter.observe(cards[0].card, { title: "Loading a new card" });
  assert.equal(cards[0].card.dataset.focusfeedAiHidden, undefined);
  receive({ type: "RESTORE", runId: "r1", videoId: "v0" });
  assert.equal(cards[0].card.dataset.focusfeedAiHidden, undefined);

  receive({ type: "MORE", runId: "r1", allowance: 24 });
  await sleep(230);
  assert.equal(cards[12].card.dataset.focusfeedDeferred, undefined);
  assert.equal(network.filter(message => message.type === "FOCUSFEED_PAGE_GATE_MORE").length, 1);

  receive({
    type: "RESULT",
    runId: "r1",
    record: {
      video: cards[2].video,
      fingerprint: context.FocusFeedLiveEngine.fingerprint(cards[2].video),
      action: "hide",
      route: "model",
      status: "resolved",
      reason: "Focus non-match",
    },
  });
  window.location.pathname = "/watch";
  dispatch("yt-navigate-start");
  assert.equal(documentElement.dataset.focusfeedSession, undefined,
    "filter display must pause outside YouTube Home");
  assert.equal(findById(documentElement, "focusfeed-load-more-host"), null,
    "Load more must leave the watch page");
  assert.equal(sent.some(message => message.type === "NAVIGATED"), false,
    "SPA navigation must not terminate the live session");

  window.location.pathname = "/";
  dispatch("yt-navigate-finish");
  assert.equal(documentElement.dataset.focusfeedSession, "true",
    "returning Home must resume the existing filter session");
  assert.ok(findByText(documentElement, "Load 12 more"),
    "returning Home must restore Load 12 more");
  assert.equal(cards[2].card.dataset.focusfeedAiHidden, "true",
    "returning Home must reapply an existing hide decision");
  assert.equal(cards[3].card.dataset.focusfeedAiPending, "true",
    "returning Home must keep unresolved recommendations hidden");

  disconnect();
  assert.equal(documentElement.dataset.focusfeedSession, undefined);
  assert.equal(cards.some(item => item.card.dataset.focusfeedAiHidden ||
    item.card.dataset.focusfeedAiPending || item.card.dataset.focusfeedDeferred), false);
  assert.equal(findById(documentElement, "focusfeed-load-more-host"), null);
  assert.equal(network.at(-1).enabled, false);
  console.log("live card adapter passed: decision-first reveal, clean cards, Home resume, Load more, restore");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
