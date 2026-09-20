"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
assert.ok(manifest.permissions.includes("scripting"), "live-session recovery requires bounded programmatic injection");
const isolatedScriptGroup = manifest.content_scripts.find((entry) => entry.world === "ISOLATED");
assert.deepEqual(isolatedScriptGroup.js, ["workflow-core.js", "live/engine.js", "live/content.js", "content.js"]);

const workflowHtml = fs.readFileSync(path.join(extensionRoot, "workflow", "workflow.html"), "utf8");
const scriptOrder = [
  "../workflow-core.js",
  "../workflow-cache.js",
  "fixtures.js",
  "workflow.js",
].map((script) => workflowHtml.indexOf(`src="${script}"`));
assert.ok(scriptOrder.every((index) => index >= 0), "workflow page must load every replay dependency");
assert.deepEqual(scriptOrder, scriptOrder.slice().sort((left, right) => left - right), "workflow dependencies must load in order");
assert.match(workflowHtml, /id="fixtureRows"/);
assert.match(workflowHtml, /id="resultRows"/);
assert.match(workflowHtml, /id="seedCache"/);
assert.match(workflowHtml, /id="readWarm"/);
assert.match(workflowHtml, /id="exportReport"/);
assert.doesNotMatch(workflowHtml, /id="runWarm"/);
assert.match(workflowHtml, /No LLM is invoked on this page/);

const popupHtml = fs.readFileSync(path.join(extensionRoot, "popup", "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(extensionRoot, "popup", "popup.js"), "utf8");
assert.match(popupHtml, /id="openWorkflowReplay"/);
assert.match(popupJs, /workflow\/workflow\.html/);
assert.match(popupHtml, /id="openLifecycleReplay"/);
assert.match(popupJs, /workflow\/lifecycle\.html/);
assert.match(popupHtml, /id="openProviderSmoke"/);
assert.match(popupJs, /workflow\/provider-smoke\.html/);
assert.match(popupHtml, /id="openYouTubeSession"/);
assert.match(popupJs, /live\/live\.html/);
assert.deepEqual(manifest.content_scripts.find(entry => entry.world === "MAIN").js, ["page-gate.js", "interceptor.js"]);
const liveHtml = fs.readFileSync(path.join(extensionRoot, "live/live.html"), "utf8");
const liveJs = fs.readFileSync(path.join(extensionRoot, "live/live.js"), "utf8");
const liveOrder = ["../workflow-core.js", "../workflow-cache.js", "../workflow-scheduler.js", "../local-classifier.js", "engine.js", "provider.js", "bootstrap.js", "live.js"]
  .map(script => liveHtml.indexOf(`src="${script}"`));
assert.ok(liveOrder.every(index => index >= 0));
assert.deepEqual(liveOrder, liveOrder.slice().sort((a,b) => a-b));
const liveStartTag = liveHtml.match(/<button[^>]*id="start"[^>]*>/);
assert.ok(liveStartTag, "live session must expose its Start control");
assert.doesNotMatch(liveStartTag[0], /\bdisabled\b/, "Start must stay clickable so it can retry readiness and connection checks");
assert.doesNotMatch(liveHtml, /id="more"/, "Load more belongs on the YouTube page, not the session tab");
assert.doesNotMatch(liveJs, /\$\("start"\)\.disabled\s*=.*!ready.*!connected/, "missing readiness must not make Start silently unclickable");

const lifecycleHtml = fs.readFileSync(path.join(extensionRoot, "workflow", "lifecycle.html"), "utf8");
const lifecycleScriptOrder = [
  "../workflow-scheduler.js",
  "lifecycle-fixtures.js",
  "lifecycle.js",
].map((script) => lifecycleHtml.indexOf(`src="${script}"`));
assert.ok(lifecycleScriptOrder.every((index) => index >= 0), "lifecycle page must load every simulation dependency");
assert.deepEqual(
  lifecycleScriptOrder,
  lifecycleScriptOrder.slice().sort((left, right) => left - right),
  "lifecycle dependencies must load in order"
);
assert.match(lifecycleHtml, /id="runLifecycle"/);
assert.match(lifecycleHtml, /id="lifecycleFixtureRows"/);
assert.match(lifecycleHtml, /id="lifecycleResultRows"/);
assert.match(lifecycleHtml, /id="exportLifecycleReport"/);
assert.match(lifecycleHtml, /fake provider/i);

const providerSmokeHtml = fs.readFileSync(path.join(extensionRoot, "workflow", "provider-smoke.html"), "utf8");
const providerSmokeScriptOrder = [
  "../workflow-core.js",
  "../workflow-scheduler.js",
  "../local-classifier.js",
  "../eval/dataset.js",
  "provider-smoke-fixtures.js",
  "provider-smoke-core.js",
  "provider-smoke.js",
].map((script) => providerSmokeHtml.indexOf(`src="${script}"`));
assert.ok(providerSmokeScriptOrder.every((index) => index >= 0), "provider smoke page must load every dependency");
assert.deepEqual(
  providerSmokeScriptOrder,
  providerSmokeScriptOrder.slice().sort((left, right) => left - right),
  "provider smoke dependencies must load in order"
);
assert.match(providerSmokeHtml, /id="runProviderSmoke"/);
assert.match(providerSmokeHtml, /id="stopProviderSmoke"/);
assert.match(providerSmokeHtml, /id="exportProviderSmoke"/);
assert.match(providerSmokeHtml, /id="providerSmokeFixtureRows"/);
assert.match(providerSmokeHtml, /id="providerSmokeResultRows"/);
assert.match(providerSmokeHtml, /id="providerGateMetric"/);
assert.match(providerSmokeHtml, /three four-video calls/i);

const evalHtml = fs.readFileSync(path.join(extensionRoot, "eval", "eval.html"), "utf8");
assert.ok(
  evalHtml.indexOf('src="../workflow-core.js"') < evalHtml.indexOf('src="metrics.js"'),
  "the shared policy must load before evaluation metrics"
);

const content = fs.readFileSync(path.join(extensionRoot, "content.js"), "utf8");
assert.doesNotMatch(content, /isShort:\s*!.*lengthText/);
assert.doesNotMatch(content, /channelLower\.includes/);
assert.doesNotMatch(content, /function buildCss\(/, "global format CSS must not bypass per-card allow precedence");
assert.match(content, /"ytm-shorts-lockup-view-model"/, "individual Short cards must be routed through the shared evaluator");
assert.match(content, /FocusFeedWorkflow\.evaluateExplicitRules/);
assert.match(content, /PREFERENCE_KEYS\[key\]/);

console.log("workflow extension surface test passed");
