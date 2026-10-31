"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom } = require("./dom-harness");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function box(left, top, width, height) { return { left, top, width, height, right: left + width, bottom: top + height }; }
function setup(t, horizontal = false) {
  const h = dom('<yt-lockup-view-model><a class="ytLockupViewModelContentImage"><img src="thumbnail.jpg"></a><h3><a href="/watch?v=abcdefghijk">Native video title</a></h3><yt-content-metadata-view-model>Creator · 230K views · 2 hours ago</yt-content-metadata-view-model></yt-lockup-view-model>');
  h.load("loading-ui.js"); const loading = h.context.FocusFeedLoadingUI.create();
  t.after(() => { loading.stop(); h.cleanup(); });
  const card = h.document.querySelector("yt-lockup-view-model"), thumb = card.querySelector("a"), title = card.querySelector("h3"), meta = card.querySelector("yt-content-metadata-view-model");
  card.getBoundingClientRect = () => box(20, 100, horizontal ? 500 : 360, horizontal ? 105 : 275);
  thumb.getBoundingClientRect = () => box(20, 100, horizontal ? 168 : 360, horizontal ? 94 : 202);
  title.getBoundingClientRect = () => horizontal ? box(200, 100, 290, 36) : box(20, 316, 350, 20);
  meta.getBoundingClientRect = () => horizontal ? box(200, 145, 285, 30) : box(20, 350, 280, 18);
  return { ...h, loading, card, thumb, title, meta };
}
for (const horizontal of [false, true]) test(`loading preserves native ${horizontal ? "horizontal" : "vertical"} card geometry and restores content`, async t => {
  const h = setup(t, horizontal), before = h.card.innerHTML, title = h.title;
  h.loading.render(h.card, "pending"); await sleep(10);
  const overlay = h.card.querySelector(".focusfeed-card-loading"); assert.ok(overlay);
  assert.equal(h.card.inert, true); assert.equal(h.card.getAttribute("aria-busy"), "true");
  assert.equal(overlay.querySelectorAll(".focusfeed-loading-shape").length, horizontal ? 4 : 3);
  assert.ok(parseFloat(overlay.querySelector(".focusfeed-loading-image").style.width) > 30);
  assert.equal(h.card.querySelector("h3"), title, "native title is not reconstructed");
  h.loading.render(h.card, "show");
  assert.equal(h.card.innerHTML, before); assert.equal(h.card.inert, false); assert.equal(h.card.getAttribute("aria-busy"), null);
});
test("progress is delayed, shared across cards, and removed immediately when the batch settles", async t => {
  const h = setup(t);
  h.loading.activity({ pending: 12, refreshing: false });
  assert.equal(h.document.querySelector(".focusfeed-feed-progress"), null);
  await sleep(200);
  assert.match(h.document.querySelector(".focusfeed-feed-progress").textContent, /Checking recommendations/);
  h.loading.activity({ pending: 5, refreshing: true });
  assert.equal(h.document.querySelectorAll(".focusfeed-feed-progress").length, 1);
  assert.match(h.document.querySelector(".focusfeed-feed-progress").textContent, /Updating your recommendations/);
  h.loading.activity({ pending: 0 }); assert.equal(h.document.querySelector(".focusfeed-feed-progress"), null);
});
test("image loading indicator ends on load/error without replacing the image or metadata", t => {
  const h = setup(t), image = h.thumb.querySelector("img"); image.complete = false;
  h.loading.render(h.card, "show"); assert.equal(h.thumb.dataset.focusfeedThumbnailLoading, "true");
  image.dispatchEvent(new h.window.Event("load", { bubbles: true }));
  assert.equal(h.thumb.hasAttribute("data-focusfeed-thumbnail-loading"), false); assert.equal(h.thumb.querySelector("img"), image);
  h.loading.render(h.card, "show"); image.dispatchEvent(new h.window.Event("error", { bubbles: true }));
  assert.equal(h.thumb.hasAttribute("data-focusfeed-thumbnail-loading"), false);
});
test("cleanup restores pre-existing accessibility state and removes all temporary elements", async t => {
  const h = setup(t); h.card.inert = true; h.card.setAttribute("aria-busy", "false");
  h.loading.render(h.card, "pending"); await sleep(10); h.loading.clear();
  assert.equal(h.card.inert, true); assert.equal(h.card.getAttribute("aria-busy"), "false");
  assert.equal(h.document.querySelector("[data-focusfeed-ui]"), null);
});
test("scrolling a pending card does not reconstruct an unchanged skeleton", async t => {
  const h = setup(t), nodes = [h.card, h.thumb, h.title, h.meta];
  h.loading.render(h.card, "pending"); await sleep(10);
  const overlay = h.card.querySelector(".focusfeed-card-loading");
  nodes.forEach(node => { const get = node.getBoundingClientRect; node.getBoundingClientRect = () => {
    const old = get(); return { ...old, top: old.top - 50, bottom: old.bottom - 50 };
  }; });
  h.loading.render(h.card, "pending"); await sleep(10);
  assert.equal(h.card.querySelector(".focusfeed-card-loading"), overlay);
});
test("image padding is excluded and stretched avatar wrappers render as circles", async t => {
  const h = setup(t);
  h.thumb.getBoundingClientRect = () => box(20, 100, 360, 216);
  h.thumb.querySelector("img").getBoundingClientRect = () => box(20, 100, 360, 202);
  h.card.insertAdjacentHTML("beforeend", '<div id="avatar-link"><img src="avatar.jpg"></div>');
  h.card.querySelector("#avatar-link").getBoundingClientRect = () => box(20, 316, 36, 66);
  h.card.querySelector("#avatar-link img").getBoundingClientRect = () => box(20, 316, 36, 36);
  h.title.getBoundingClientRect = () => box(68, 316, 300, 20);
  h.meta.getBoundingClientRect = () => box(68, 350, 280, 18);
  h.loading.render(h.card, "pending"); await sleep(10);
  const overlay = h.card.querySelector(".focusfeed-card-loading"), image = overlay.querySelector(".focusfeed-loading-image"), avatar = overlay.querySelector(".focusfeed-loading-avatar");
  const height = node => parseFloat(node.style.height) * 275 / 100, width = node => parseFloat(node.style.width) * 360 / 100;
  assert.ok(Math.abs(height(image) - 202) < .01, "the placeholder must exclude the image link's bottom padding");
  assert.ok(Math.abs(height(avatar) - width(avatar)) < .01, "avatar stays circular despite its tall wrapper");
  const firstLine = overlay.querySelector(".focusfeed-loading-line");
  assert.ok(parseFloat(firstLine.style.top) * 275 / 100 >= height(image) + 12, "leave separation below the thumbnail");
  assert.ok(height(firstLine) <= 12.01, "title placeholders remain slim");
});
test("portrait thumbnails retain their measured aspect ratio", async t => {
  const h = setup(t);
  h.card.getBoundingClientRect = () => box(20, 100, 180, 400);
  h.thumb.getBoundingClientRect = () => box(20, 100, 180, 320);
  h.thumb.querySelector("img").getBoundingClientRect = () => box(20, 100, 180, 320);
  h.loading.render(h.card, "pending"); await sleep(10);
  const image = h.card.querySelector(".focusfeed-loading-image");
  assert.equal(parseFloat(image.style.width), 100); assert.equal(parseFloat(image.style.height), 80);
});

test("thumbnail loading fills the image only and leaves the link's title spacing uncovered", t => {
  const h = setup(t), image = h.thumb.querySelector("img"), originalStyle = h.thumb.getAttribute("style");
  h.thumb.getBoundingClientRect = () => box(20, 100, 360, 216);
  image.getBoundingClientRect = () => box(20, 100, 360, 202);
  image.complete = false; h.loading.render(h.card, "show");
  const placeholder = h.thumb.querySelector(".focusfeed-thumbnail-loading");
  assert.ok(placeholder, "network loading must have a bounded image placeholder");
  assert.equal(parseFloat(placeholder.style.top), 0);
  assert.ok(Math.abs(parseFloat(placeholder.style.height) * 216 / 100 - 202) < .01, "the 14px native gap must remain clear");
  assert.equal(h.thumb.getAttribute("style"), originalStyle, "do not override native wrapper sizing or positioning");
  image.dispatchEvent(new h.window.Event("load", { bubbles: true }));
  assert.equal(h.thumb.querySelector(".focusfeed-thumbnail-loading"), null);
  assert.equal(h.thumb.hasAttribute("data-focusfeed-thumbnail-loading"), false);
});
for (const horizontal of [false, true]) test("filter updates preserve native " + (horizontal ? "horizontal" : "vertical") + " cards with a thumbnail-sized status", async t => {
  const h = setup(t, horizontal), original = h.card.innerHTML, native = Array.from(h.card.children);
  h.loading.render(h.card, "show", "refreshing");
  const status = h.card.querySelector(".focusfeed-card-status");
  assert.ok(status); assert.match(status.textContent, /Updating filters/);
  assert.equal(h.card.dataset.focusfeedRefreshing, "true");
  assert.equal(h.card.getAttribute("aria-busy"), "true");
  assert.equal(h.card.querySelector(".focusfeed-card-loading"), null, "existing cards keep their content instead of a skeleton");
  assert.equal(h.card.inert, false, "status stays accessible");
  assert.ok(native.every(child => child.inert));
  assert.equal(h.card.querySelector("h3"), h.title);
  const height = parseFloat(status.style.height) / 100 * (horizontal ? 105 : 275);
  assert.ok(Math.abs(height - (horizontal ? 94 : 202)) < .01);
  const event = new h.window.Event("click", { bubbles: true, cancelable: true }); h.title.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, "an updating card cannot navigate");
  h.loading.render(h.card, "show", "model");
  assert.equal(h.card.innerHTML, original);
  assert.equal(h.card.hasAttribute("data-focusfeed-refreshing"), false);
  assert.ok(native.every(child => !child.inert));
  assert.equal(h.card.getAttribute("aria-busy"), null);
});
test("exhausted checks keep new content covered and expose only a compact Retry control", async t => {
  const h = setup(t); let retries = 0, nativeClicks = 0;
  h.thumb.addEventListener("click", () => nativeClicks++);
  h.loading.render(h.card, "pending", "check_failed", () => { retries++; return false; }); await sleep(10);
  assert.ok(h.card.querySelector(".focusfeed-card-loading"));
  const status = h.card.querySelector(".focusfeed-card-status"), button = status.querySelector("button");
  assert.match(status.textContent, /Couldn’t check/);
  assert.equal(h.card.dataset.focusfeedCheckStatus, "failed");
  assert.equal(h.card.getAttribute("aria-busy"), "false");
  assert.equal(h.card.inert, false);
  assert.equal(h.thumb.inert, true);
  button.click(); assert.equal(retries, 1); assert.equal(nativeClicks, 0); assert.equal(button.disabled, false);
  h.loading.render(h.card, "pending", "check_retrying"); await sleep(10);
  assert.match(h.card.querySelector(".focusfeed-card-status").textContent, /Retrying check/);
  assert.equal(h.card.querySelector(".focusfeed-status-retry"), null);
  h.loading.render(h.card, "hide", "model");
  assert.equal(h.card.querySelector(".focusfeed-card-status, .focusfeed-card-loading"), null);
  assert.equal(h.card.inert, false); assert.equal(h.thumb.inert, false);
  assert.equal(h.card.getAttribute("aria-busy"), null);
});
test("refresh retries restore native accessibility state on cleanup", t => {
  const h = setup(t); h.card.setAttribute("aria-busy", "false"); h.title.inert = true;
  h.loading.render(h.card, "show", "refreshing");
  h.loading.render(h.card, "show", "refresh_retrying");
  h.loading.render(h.card, "show", "refresh_failed", () => true);
  h.loading.clear();
  assert.equal(h.card.querySelector("[data-focusfeed-ui]"), null);
  assert.equal(h.card.getAttribute("aria-busy"), "false");
  assert.equal(h.card.inert, false); assert.equal(h.title.inert, true); assert.equal(h.thumb.inert, false);
  assert.equal(h.card.hasAttribute("data-focusfeed-check-status"), false);
});
