"use strict";
// Parsed HTML + real DOM events/selectors, without a browser or layout engine.
const { parseHTML } = require("linkedom");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
function dom(html, pathname = "/") {
  const { window } = parseHTML("<!doctype html><html><body>" + html + "</body></html>");
  const timers = new Set(), intervals = new Set(), messages = [];
  const location = new URL(pathname, "https://www.youtube.com");
  window.location = location;
  window.postMessage = data => messages.push(data);
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { top: 10, bottom: 210, height: 200 }; };
  window.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  const context = vm.createContext({ document: window.document, window, location, URL, console, performance,
    MutationObserver: window.MutationObserver, KeyboardEvent: window.Event, Event: window.Event,
    setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    setInterval(fn, ms) { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval(id) { clearInterval(id); intervals.delete(id); },
  });
  function load(...files) { files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file })); }
  function cleanup() { for (const id of timers) clearTimeout(id); for (const id of intervals) clearInterval(id); }
  function media(node) {
    node.paused = false; node.pauseCount = 0;
    node.pause = () => { node.paused = true; node.pauseCount++; };
    node.play = () => { node.paused = false; return Promise.resolve(); };
    return node;
  }
  return { context, window, document: window.document, location, messages, load, cleanup, media };
}
function videoCard(id, channel = "@" + id) {
  return `<ytd-rich-item-renderer data-id="${id}"><a id="video-title-link" href="/watch?v=${id}" title="Video ${id}">Video ${id}</a><a href="/${channel}">${channel}</a><ytd-menu-renderer><button aria-haspopup="true">Menu</button></ytd-menu-renderer></ytd-rich-item-renderer>`;
}
function homePage(cards) { return `<ytd-browse page-subtype="home"><ytd-rich-grid-renderer><div id="contents">${cards}<ytd-continuation-item-renderer></ytd-continuation-item-renderer></div></ytd-rich-grid-renderer></ytd-browse>`; }
function extract(card) {
  if (card.tagName !== "YTD-RICH-ITEM-RENDERER") return null;
  const link = card.querySelector("#video-title-link");
  const channel = card.querySelector('a[href^="/@"]');
  return { videoId: new URL(link.getAttribute("href"), "https://www.youtube.com").searchParams.get("v"), title: link.textContent,
    channel: channel && channel.textContent || "", channelId: channel && channel.getAttribute("href").slice(1) || "" };
}
module.exports = { dom, videoCard, homePage, extract };
