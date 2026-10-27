"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8"
);

function loadBackground(fetchImpl) {
  const listeners = [];
  const context = {
    AbortController,
    URL,
    clearTimeout,
    console,
    fetch: fetchImpl,
    setTimeout,
    chrome: {
      storage: {
        local: {
          get(defaults) {
            return Promise.resolve(defaults);
          },
        },
      },
      runtime: {
        getURL(value) {
          return "chrome-extension://focusfeed/" + value;
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
      },
    },
  };
  vm.runInNewContext(backgroundSource, context, { filename: "background.js" });
  return listeners[0];
}

function dispatch(listener, message) {
  return new Promise((resolve, reject) => {
    const keepChannelOpen = listener(message, {}, resolve);
    assert.equal(keepChannelOpen, true);
    setTimeout(() => reject(new Error("background response timed out")), 1000);
  });
}

(async function run() {
  const staleCalls = [];
  const staleListener = loadBackground(async function (url) {
    staleCalls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          configured: true,
          provider: "typesafe-jev",
          promptVersion: "typesafe-jev-2026-09-26.1-confidence-0.6",
        };
      },
    };
  });
  const stale = await dispatch(staleListener, {
    type: "OBJECTIVES_CLASSIFY_CLOUD",
    request: {
      requestId: "objective-contract-test",
      mode: "general",
      objectives: ["gaming streams"],
    },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "incompatible_backend_contract");
  assert.match(stale.error.message, /run bash backend\/run_local\.sh again/);
  assert.equal(staleCalls.length, 1, "stale backend must be rejected before objective POST");

  const currentCalls = [];
  const currentListener = loadBackground(async function (url) {
    currentCalls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        if (url.endsWith("/health")) return {
          configured: true,
          provider: "typesafe-jev",
          promptVersion: "typesafe-jev-intent-video-match-2026-10-27.1",
          objectivePromptVersion: "typesafe-jev-intent-validation-2026-10-27.1",
          taxonomyVersion: "focusfeed-topics-v1",
        };
        return { objectives: [{ status: "ready_for_confirmation" }] };
      },
    };
  });
  const current = await dispatch(currentListener, {
    type: "OBJECTIVES_CLASSIFY_CLOUD",
    request: { requestId: "objective-contract-test", mode: "general", objectives: ["gaming"] },
  });
  assert.equal(current.ok, true);
  assert.equal(current.data.objectives[0].status, "ready_for_confirmation");
  assert.deepEqual(
    currentCalls.map(url => new URL(url).pathname),
    ["/health", "/objectives/classify"]
  );
  console.log("background contract test passed: stale backend blocked before objective POST");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
