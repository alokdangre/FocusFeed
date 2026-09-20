"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
const isolatedScriptGroup = manifest.content_scripts.find((entry) => entry.world === "ISOLATED");
assert.deepEqual(isolatedScriptGroup.js, ["workflow-core.js", "content.js"]);

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
assert.match(workflowHtml, /No LLM is invoked on this page/);

const popupHtml = fs.readFileSync(path.join(extensionRoot, "popup", "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(extensionRoot, "popup", "popup.js"), "utf8");
assert.match(popupHtml, /id="openWorkflowReplay"/);
assert.match(popupJs, /workflow\/workflow\.html/);

const content = fs.readFileSync(path.join(extensionRoot, "content.js"), "utf8");
assert.doesNotMatch(content, /isShort:\s*!.*lengthText/);
assert.doesNotMatch(content, /channelLower\.includes/);
assert.match(content, /FocusFeedWorkflow\.evaluateExplicitRules/);
assert.match(content, /PREFERENCE_KEYS\[key\]/);

console.log("workflow extension surface test passed");
