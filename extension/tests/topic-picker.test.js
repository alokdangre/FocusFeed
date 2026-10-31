"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { dom } = require("./dom-harness");
const tick = () => new Promise(resolve => setImmediate(resolve));
const topic = text => ({ id: text, text });
function setup(t, topics, onSelect = () => {}) {
  const h = dom('<button id="anchor">Hide as topic…</button>');
  h.load("topic-picker.js"); const picker = h.context.FocusFeedTopicPicker.create(), anchor = h.document.querySelector("#anchor");
  t.after(() => { picker.close(false); h.cleanup(); });
  const options = { anchor, topics: topics.map(topic), title: "Hide as topic", description: "Choose which blocked topic this matches.", onSelect };
  return { ...h, picker, anchor, options, open() { picker.open(options); return h.document.querySelector("dialog"); } };
}
function key(h, node, value, shift = false) {
  const event = new h.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, { key: { value }, shiftKey: { value: shift } }); node.dispatchEvent(event); return event;
}
test("many topics stay searchable locally, preserving exact wording and empty results", async t => {
  const labels = Array.from({ length: 40 }, (_, i) => "Topic " + i).concat(["K-dramas and Korea", "<img src=x>"]);
  const selected = [], h = setup(t, labels, value => selected.push(value.text)), dialog = h.open();
  assert.equal(h.document.querySelectorAll("dialog").length, 1);
  assert.equal(h.document.querySelectorAll(".focusfeed-topic-choice").length, 42);
  assert.equal(dialog.querySelector("img"), null, "topic labels are text rather than HTML");
  assert.equal(selected.length, 0);
  const search = dialog.querySelector("input"); search.value = " KOREA dramas "; search.dispatchEvent(new h.window.Event("input"));
  assert.equal(h.document.querySelectorAll(".focusfeed-topic-choice").length, 1);
  assert.equal(dialog.querySelector(".focusfeed-topic-choice").textContent, "K-dramas and Korea");
  search.value = "nothing-matches"; search.dispatchEvent(new h.window.Event("input"));
  assert.match(dialog.textContent, /No matching topics/);
  assert.equal(selected.length, 0);
  search.value = "Korea"; search.dispatchEvent(new h.window.Event("input"));
  dialog.querySelector(".focusfeed-topic-choice").click(); await tick();
  assert.deepEqual(selected, ["K-dramas and Korea"]); assert.equal(h.picker.isOpen(), false);
  assert.equal(h.anchor.getAttribute("aria-expanded"), "false");
});
test("keyboard navigation, Tab wrapping and Escape restore focus to the menu entry", t => {
  const h = setup(t, ["Movie reviews", "Gaming", "Sports", "News", "Music", "Comedy"]), dialog = h.open();
  const search = dialog.querySelector("input"), close = dialog.querySelector(".focusfeed-topic-picker-close");
  const rows = Array.from(dialog.querySelectorAll(".focusfeed-topic-choice")); let focused;
  [search, close, h.anchor, ...rows].forEach(node => { node.focus = () => { focused = node; }; });
  key(h, search, "ArrowDown"); assert.equal(focused, rows[0]);
  key(h, rows[0], "ArrowDown"); assert.equal(focused, rows[1]);
  key(h, rows[0], "ArrowUp"); assert.equal(focused, search);
  key(h, rows[rows.length - 1], "Tab"); assert.equal(focused, close);
  key(h, close, "Tab", true); assert.equal(focused, rows[rows.length - 1]);
  assert.equal(key(h, search, "Escape").defaultPrevented, true);
  assert.equal(focused, h.anchor); assert.equal(h.picker.isOpen(), false);
});
test("small lists skip search and focus a topic; search appears above five topics", t => {
  const h = setup(t, ["Movie reviews", "Gaming"]); let focused;
  h.window.HTMLElement.prototype.focus = function () { focused = this; };
  const dialog = h.open(), rows = Array.from(dialog.querySelectorAll(".focusfeed-topic-choice"));
  const close = dialog.querySelector(".focusfeed-topic-picker-close");
  assert.equal(dialog.querySelector("input"), null);
  assert.equal(dialog.querySelector(".focusfeed-topic-picker-count").hidden, true);
  assert.equal(focused, rows[0]);
  key(h, rows[0], "ArrowUp"); assert.equal(focused, rows[1]);
  key(h, rows[1], "ArrowDown"); assert.equal(focused, rows[0]);
  assert.equal(key(h, close, "Tab").defaultPrevented, false, "native Tab can reach the first topic");
  key(h, rows[1], "Tab"); assert.equal(focused, close);
  key(h, close, "Tab", true); assert.equal(focused, rows[1]);
  for (const size of [1, 5, 6]) {
    h.options.topics = Array.from({ length: size }, (_, i) => topic("Topic " + i));
    const next = h.open();
    assert.equal(!!next.querySelector("input"), size > 5);
    assert.equal(next.querySelectorAll(".focusfeed-topic-choice").length, size);
    assert.equal(focused, size > 5 ? next.querySelector("input") : next.querySelector(".focusfeed-topic-choice"));
  }
});
test("busy selection prevents duplicate writes and a failed save can be retried", async t => {
  let fail, calls = 0;
  const h = setup(t, ["Reviews"], () => { calls++; return calls === 1 ? new Promise((_r, reject) => { fail = reject; }) : undefined; });
  const dialog = h.open(), row = dialog.querySelector(".focusfeed-topic-choice"); row.click(); row.click();
  assert.equal(calls, 1); assert.equal(row.disabled, true); assert.match(dialog.querySelector(".focusfeed-topic-picker-count").textContent, /Saving/);
  fail(new Error("Could not save. Try again.")); await tick();
  assert.equal(row.disabled, false); assert.equal(dialog.querySelector(".focusfeed-topic-picker-error").hidden, false);
  row.click(); await tick(); assert.equal(calls, 2); assert.equal(h.picker.isOpen(), false);
});
test("backdrop and native cancellation dismiss without selecting a topic", t => {
  let calls = 0; const h = setup(t, ["Reviews"], () => calls++);
  h.open().click(); assert.equal(h.picker.isOpen(), false); assert.equal(calls, 0);
  const node = h.open(), cancel = new h.window.Event("cancel", { cancelable: true }); node.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true); assert.equal(h.picker.isOpen(), false); assert.equal(calls, 0);
});
test("a late save cannot close a newly opened picker", async t => {
  let finish; const h = setup(t, ["Reviews"], () => new Promise(resolve => { finish = resolve; }));
  h.open().querySelector(".focusfeed-topic-choice").click(); h.picker.close(false);
  const next = h.open(); finish(); await tick();
  assert.equal(h.picker.isOpen(), true); assert.equal(h.document.querySelector("dialog"), next);
});
test("the native dialog path stays within the viewport", t => {
  const h = setup(t, ["Reviews"]); let modal = false;
  h.window.HTMLElement.prototype.showModal = function () { modal = true; this.setAttribute("open", ""); };
  h.anchor.getBoundingClientRect = () => ({ left: 1000, top: 740, bottom: 760 });
  const node = h.open(); assert.equal(modal, true);
  assert.ok(parseFloat(node.style.left) >= 16 && parseFloat(node.style.left) + 340 <= 1008);
  assert.ok(parseFloat(node.style.top) >= 16 && parseFloat(node.style.top) + 200 <= 752);
});
