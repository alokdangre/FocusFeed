"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "..");
test("every packaged script and stylesheet exists, in dependency order, with no retired runtime", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const isolated = manifest.content_scripts.find(group => group.world === "ISOLATED");
  assert.deepEqual(isolated.js, ["video-model.js", "channel-policy.js", "settings.js", "auto-runtime.js", "home-feed.js", "preview-controller.js", "loading-ui.js", "youtube-ui.js", "content.js"]);
  for (const group of manifest.content_scripts) for (const file of [...group.js, ...(group.css || [])]) assert.ok(fs.existsSync(path.join(root, file)), file);
  assert.ok(fs.existsSync(path.join(root, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(root, manifest.action.default_popup)));
  assert.equal(manifest.permissions.includes("scripting"), false, "retired manual repair injection no longer needs scripting permission");
  const html = fs.readFileSync(path.join(root, "popup/popup.html"), "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css))"/g)) assert.ok(fs.existsSync(path.resolve(root, "popup", match[1])), match[1]);
  assert.ok(html.indexOf('src="../settings.js"') < html.indexOf('src="topic-input.js"'));
  assert.ok(html.indexOf('src="topic-input.js"') < html.indexOf('src="popup.js"'));
});
