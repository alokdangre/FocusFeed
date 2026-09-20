"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedLiveBootstrap;
require("../live/bootstrap.js");

async function main() {
  const calls = [];
  const chromeApi = {
    scripting: {
      executeScript: async options => { calls.push(options); return []; },
    },
  };

  assert.equal(FocusFeedLiveBootstrap.isMissingReceiver("Could not establish connection. Receiving end does not exist."), true);
  assert.equal(FocusFeedLiveBootstrap.isMissingReceiver("YouTube disconnected."), false);

  await FocusFeedLiveBootstrap.inject(chromeApi, 42);
  assert.deepEqual(calls, [
    {
      target: { tabId: 42 },
      world: "MAIN",
      files: ["page-gate.js", "interceptor.js"],
    },
    {
      target: { tabId: 42 },
      world: "ISOLATED",
      files: ["workflow-core.js", "live/engine.js", "live/content.js", "content.js"],
    },
  ]);

  console.log("live bootstrap repair passed: missing receiver detection and bounded two-world injection");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
