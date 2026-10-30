// Bounded local evidence for explaining a channel check, including failures.
(function (root) {
  "use strict";
  var KEY = "focusfeedChannelInvestigationsV1";
  function create(options) {
    var generation = 0;
    function start(video, profile, triggerId) {
      return { id: "investigation-" + Date.now() + "-" + Math.random().toString(16).slice(2),
        generation: generation, createdAt: Date.now(), updatedAt: Date.now(), status: "queued", stage: "queued",
        video: FocusFeedVideo.videoInput(video), channelId: video.channelId || "", channelLabel: video.channel || "",
        triggerId: triggerId || null, trigger: triggerId ? "user_correction" : "automatic",
        topics: profile.objectives.map(function (o) { return { id: o.id, text: o.text, key: FocusFeedVideo.objectiveKey(o) }; }),
        steps: [], judgments: [] };
    }
    function error(value) {
      return { code: String(value && value.code || value && value.name || "channel_check_failed").slice(0, 100),
        message: String(value && value.message || "Channel check failed.").slice(0, 1000), status: value && value.status || null };
    }
    function update(trace, patch) {
      Object.assign(trace, patch, { updatedAt: Date.now() });
      var saved = JSON.parse(JSON.stringify(trace)); delete saved.generation;
      return options.write(async function () {
        if (trace.generation !== generation) return;
        var values = await options.storage.get({ [KEY]: [] });
        var list = (values[KEY] || []).filter(function (v) { return v.id !== trace.id; }).concat(saved).slice(-50);
        var bytes = JSON.stringify(list).length * 2;
        while (list.length > 1 && bytes > 1000000) { list.shift(); bytes = JSON.stringify(list).length * 2; }
        if (bytes > 1000000) {
          saved.detailsOmitted = "The investigation exceeded the local diagnostic size limit.";
          saved.steps = []; saved.evidence = null; list = [saved];
        }
        await options.storage.set({ [KEY]: list });
      }).catch(function () { console.warn("[FocusFeed] Could not save channel investigation diagnostics."); });
    }
    function invalidate() { generation++; }
    return { start: start, update: update, error: error, invalidate: invalidate, current: function (trace) { return trace.generation === generation; } };
  }
  root.FocusFeedChannelInvestigations = { KEY: KEY, create: create };
})(globalThis);
