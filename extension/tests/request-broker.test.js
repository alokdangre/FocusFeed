"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
require("../request-broker.js");
const sleep = ms => new Promise(r => setTimeout(r, ms));
test("tabs share a serial queue; closing one tab cancels only its work", async () => {
  const calls = []; let finish;
  const broker = FocusFeedRequestBroker.create((request, signal) => {
    calls.push(request.requestId);
    return new Promise((resolve, reject) => { finish = resolve; signal.addEventListener("abort", () => reject(new Error("aborted"))); });
  }, { spacing: 0 });
  const first = broker.submit(1, { requestId: "1" });
  const second = broker.submit(2, { requestId: "2" });
  const cancelled = broker.submit(3, { requestId: "3" }).catch(e => e.message);
  broker.cancel(3); assert.equal(await cancelled, "Request cancelled.");
  await sleep(5); assert.deepEqual(calls, ["1"]);
  broker.cancel(2, "1"); finish("one"); assert.equal(await first, "one");
  await sleep(5); assert.deepEqual(calls, ["1", "2"]);
  broker.cancel(2); await assert.rejects(second, /aborted/);
});
test("duplicate queued work per tab is rejected instead of growing without bound", async () => {
  const broker = FocusFeedRequestBroker.create(async () => "done", { spacing: 10 });
  const a = broker.submit(1, { requestId: "a" });
  const b = broker.submit(2, { requestId: "b" });
  await assert.rejects(broker.submit(2, { requestId: "c" }), /busy/);
  assert.equal(await a, "done"); assert.equal(await b, "done");
});
