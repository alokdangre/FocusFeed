(function (root) {
  "use strict";

  var MAIN_FILES = ["page-gate.js", "interceptor.js"];
  var ISOLATED_FILES = ["workflow-core.js", "live/engine.js", "live/content.js", "content.js"];

  function isMissingReceiver(error) {
    var message = typeof error === "string" ? error : error && error.message || "";
    return /receiving end does not exist/i.test(message);
  }

  async function inject(chromeApi, tabId) {
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("Invalid YouTube tab identity.");
    if (!chromeApi || !chromeApi.scripting || !chromeApi.scripting.executeScript) {
      throw new Error("FocusFeed is missing the scripting permission. Reload the updated extension.");
    }
    await chromeApi.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      files: MAIN_FILES.slice(),
    });
    await chromeApi.scripting.executeScript({
      target: { tabId: tabId },
      world: "ISOLATED",
      files: ISOLATED_FILES.slice(),
    });
  }

  root.FocusFeedLiveBootstrap = {
    isMissingReceiver: isMissingReceiver,
    inject: inject,
    mainFiles: MAIN_FILES.slice(),
    isolatedFiles: ISOLATED_FILES.slice(),
  };
})(globalThis);
