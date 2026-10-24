"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
assert.ok(manifest.permissions.includes("scripting"), "live-session recovery requires bounded programmatic injection");
const isolatedScriptGroup = manifest.content_scripts.find((entry) => entry.world === "ISOLATED");
assert.deepEqual(isolatedScriptGroup.js, ["workflow-core.js", "channel-policy.js", "live/engine.js", "live/content.js", "content.js"]);

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
const backgroundJs = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8");
assert.match(backgroundJs, /OBJECTIVE_PROMPT_PREFIX/);
assert.match(backgroundJs, /objectivePromptVersion/);
assert.match(backgroundJs, /running an older build/);
assert.match(backgroundJs, /await healthCheck\(\)/);
assert.match(popupJs, /MAX_OBJECTIVE_LENGTH = 160/);
assert.match(popupHtml, /value="general"/);
assert.match(popupHtml, /value="focus"/);
assert.match(popupHtml, /id="objectiveInput"/);
assert.match(popupHtml, /id="saveGoal"/);
assert.match(popupHtml, /id="taxonomyMapping"/);
assert.match(popupJs, /OBJECTIVES_CLASSIFY_CLOUD/);
assert.match(popupJs, /Save confirmed topics/);
assert.match(popupJs, /activeProfile: prefs\.activeProfile/);
assert.match(popupHtml, /id="channelBlocks"/);
assert.doesNotMatch(popupHtml, /value="balanced"/);
assert.match(popupHtml, /id="openYouTubeSession"/);
assert.match(popupJs, /live\/live\.html/);
assert.match(popupJs, /active:\s*false/, "the controller must open behind the active YouTube tab");
assert.match(popupJs, /window\.close\(\)/, "the popup must return focus to YouTube after launch");
assert.match(popupHtml, /id="openObservability"/);
assert.match(popupJs, /observability\/observability\.html/);
assert.match(popupHtml, /id="clearGeneratedData"/);
assert.match(popupJs, /focusFeedLiveAssessmentCacheV1/);
assert.match(popupJs, /focusFeedChannelEvidenceV1/);
assert.doesNotMatch(popupHtml, /id="hideShorts"/);
assert.doesNotMatch(popupHtml, /id="keywordInput"/);

const observabilityHtml = fs.readFileSync(path.join(extensionRoot, "observability", "observability.html"), "utf8");
const observabilityJs = fs.readFileSync(path.join(extensionRoot, "observability", "observability.js"), "utf8");
assert.match(observabilityHtml, /Intent validation/);
assert.match(observabilityHtml, /YouTube video decisions/);
assert.match(observabilityHtml, /Every topic Noul/);
assert.match(observabilityHtml, /Every direct taxonomy-match Noul/);
assert.match(observabilityJs, /focusfeedObjectiveValidationV1/);
assert.match(observabilityJs, /focusfeedLiveObservabilityV1/);
assert.match(observabilityJs, /matchProbability/);
assert.deepEqual(manifest.content_scripts.find(entry => entry.world === "MAIN").js, ["page-gate.js", "interceptor.js"]);
const liveHtml = fs.readFileSync(path.join(extensionRoot, "live/live.html"), "utf8");
const liveJs = fs.readFileSync(path.join(extensionRoot, "live/live.js"), "utf8");
const liveEngine = fs.readFileSync(path.join(extensionRoot, "live/engine.js"), "utf8");
const liveOrder = ["../workflow-core.js", "../channel-policy.js", "../workflow-scheduler.js", "engine.js", "provider.js", "bootstrap.js", "live.js"]
  .map(script => liveHtml.indexOf(`src="${script}"`));
assert.ok(liveOrder.every(index => index >= 0));
assert.deepEqual(liveOrder, liveOrder.slice().sort((a,b) => a-b));
assert.doesNotMatch(liveHtml, /workflow-cache\.js/);
assert.doesNotMatch(liveJs, /FocusFeedAssessmentCache|cacheEntries/);
assert.doesNotMatch(liveEngine, /evaluateExplicitRules|cacheEntryStatus|\.cache\.put/);
assert.match(liveEngine, /matchingBlock/);
assert.match(liveJs, /predates the current taxonomy/);
assert.match(liveHtml, /id="channelSuggestions"/);
assert.doesNotMatch(liveHtml, /id="start"/, "the session must not require a manual Start action");
assert.doesNotMatch(liveHtml, /id="apply"/, "AI hides must not require a separate apply control");
assert.match(liveHtml, /id="retry"/, "failed automatic startup must remain retryable");
assert.match(liveJs, /\n\s*start\(\);\n\}\)\(\);\s*$/, "the session must start automatically after loading");
assert.doesNotMatch(liveHtml, /id="more"/, "Load more belongs on the YouTube page, not the session tab");
assert.doesNotMatch(liveJs, /type:\s*"MODE"/, "the session must not expose preview/apply switching");
const liveContent = fs.readFileSync(path.join(extensionRoot, "live/content.js"), "utf8");
assert.doesNotMatch(liveContent, /focusfeed-live-panel|Apply AI hides|Preview only/,
  "YouTube must not render the fixed lower action bar");
assert.doesNotMatch(liveContent, /focusfeed-live-label|pending Jev judgment/,
  "YouTube cards must not render internal filter diagnostics");
assert.match(liveContent, /data-focusfeed-ai-pending/, "pending cards must remain hidden");
assert.match(liveContent, /yt-navigate-finish/, "the Home filter must resume after SPA navigation");
assert.doesNotMatch(liveContent, /type:\s*"NAVIGATED"/,
  "SPA navigation must not terminate the controller session");

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
assert.match(content, /"ytm-shorts-lockup-view-model"/, "individual Short cards must be available to the Jev session");
assert.doesNotMatch(content, /FocusFeedWorkflow\.evaluateExplicitRules/);
assert.doesNotMatch(content, /focusfeed-signals/);
assert.match(content, /PREFERENCE_KEYS\[key\]/);
assert.match(content, /detailedMetadataSnippets/);
assert.match(content, /channelId: extractChannelIdentity/);

console.log("workflow extension surface test passed");
