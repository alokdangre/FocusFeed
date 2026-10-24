// Per-tab continuous filtering. The popup and diagnostics do not own its lifetime.
(function (root) {
  "use strict";
  function create(adapter, api) {
    api = api || chrome;
    var state = null, blocks = [], generation = 0, records = new Map(), cards = new Map();
    var current = null, timer = null, retryAt = 0, expiryTimer = null, stopped = false, suspended = false;
    var status = "Loading settings", serial = 0, reloadSerial = 0, mode = "general";
    var restored = new Set(), displayed = new Map(), completed = new WeakMap(), missing = new Map();
    function profile() { return state && FocusFeedSettings.effective(state); }
    function render(card, video, action, reason) {
      displayed.set(card, { video: video, action: action === "pending" ? null : action,
        route: reason || (action === "pending" ? "model_pending" : "unfiltered"), status: action === "pending" ? "pending" : "resolved" });
      if (displayed.size > 1000) displayed.delete(displayed.keys().next().value);
      adapter.render(card, video, action, reason);
    }
    function cancel() {
      generation++;
      if (current) api.runtime.sendMessage({ type: "FF_AUTO_CANCEL", requestId: current.id }).catch(function () {});
      current = null;
      clearTimeout(timer); timer = null;
      records.clear(); completed = new WeakMap(); missing.clear();
    }
    function setStatus(value) { status = value; }
    async function reload() {
      var serial = ++reloadSerial;
      cancel();
      state = null;
      var prefs = await api.storage.local.get(null);
      if (!prefs.focusfeedSettingsV2) {
        await api.runtime.sendMessage({ type: "FF_SETTINGS_GET" });
        prefs = await api.storage.local.get(null);
      }
      if (stopped || serial !== reloadSerial) return;
      state = FocusFeedSettings.migrate(prefs);
      blocks = prefs.focusFeedChannelBlocksV1 || [];
      mode = profile().mode;
      cancel(); retryAt = 0; restored.clear();
      clearTimeout(expiryTimer);
      if (FocusFeedSettings.focusActive(state) && state.focusSession.endsAt) {
        expiryTimer = setTimeout(function () { reload().catch(function () { setStatus("Could not reload settings"); }); }, Math.max(1, Date.parse(state.focusSession.endsAt) - Date.now() + 20));
      }
      setStatus(!state.enabled ? "Paused" : FocusFeedSettings.valid(profile()) ?
        (mode === "focus" ? "Focus active" : "General active") : "Channel blocks active · confirm topics for AI filtering");
      if (!suspended) adapter.scan();
    }
    function observe(card, rawVideo) {
      if (!state || stopped || suspended) return;
      var video = FocusFeedLiveEngine.videoInput(rawVideo);
      // Aliases are identity evidence only; do not send them as backend fields.
      video.aliases = rawVideo.aliases || [];
      cards.set(card, video);
      if (cards.size > 1000) cards.delete(cards.keys().next().value);
      if (!state.enabled) { render(card, video, "show"); return; }
      var block = FocusFeedChannelPolicy.matchingBlock(blocks, video, profile());
      if (block) { render(card, video, "hide", "channel_block"); return; }
      if (!video.videoId || !FocusFeedSettings.valid(profile())) { render(card, video, "show"); return; }
      if (restored.has(video.videoId)) { render(card, video, "show"); return; }
      var fp = FocusFeedLiveEngine.fingerprint(video);
      var previous = completed.get(card);
      if (previous && previous.fp === fp) { render(card, video, previous.action, "model"); return; }
      var record = records.get(video.videoId);
      if (record && record.fp !== fp) { records.delete(video.videoId); record = null; }
      if (record && record.status === "done") {
        completed.set(card, { fp: fp, action: record.action, assessment: record.assessment });
        render(card, video, record.action, "model"); return;
      }
      if (record && record.status === "error" && Date.now() < record.retryAt) {
        render(card, video, FocusFeedWorkflow.uncertaintyAction(mode), "unavailable"); return;
      }
      if (!FocusFeedWorkflow.hasMinimumModelMetadata(video)) {
        // Active playback waits briefly for metadata, then settles using the mode's error policy.
        if (rawVideo.playback) {
          if (!missing.has(video.videoId)) missing.set(video.videoId, Date.now());
          if (missing.size > 20) missing.delete(missing.keys().next().value);
          render(card, video, Date.now() - missing.get(video.videoId) < 8000 ? "pending" : FocusFeedWorkflow.uncertaintyAction(mode), "unavailable");
        } else render(card, video, "show");
        return;
      }
      var rect = card.getBoundingClientRect();
      var near = rect.bottom >= -300 && rect.top <= (root.innerHeight || 800) + 600;
      if (!near && !rawVideo.playback) { render(card, video, "pending"); return; }
      if (Date.now() < retryAt) { render(card, video, FocusFeedWorkflow.uncertaintyAction(mode), "unavailable"); return; }
      if (!record || record.status === "error") {
        var queued = Array.from(records.values()).filter(function (r) { return r.status === "queued"; });
        if (queued.length >= 24) { render(card, video, "pending"); return; }
        record = { video: video, fp: fp, status: "queued", at: Date.now(), priority: rect.top < (root.innerHeight || 800) && rect.bottom > 0 ? 100 : 10 };
        records.set(video.videoId, record);
      }
      render(card, video, "pending");
      schedule();
    }
    function schedule() {
      if (!timer && !current && !stopped && !suspended) timer = setTimeout(function () { timer = null; pump(); }, 100);
    }
    function rescan() {
      cards.forEach(function (_video, card) { if (!card.isConnected) { cards.delete(card); displayed.delete(card); } });
      // Bound page-local decisions; these never survive reloads or context changes.
      if (records.size > 500) {
        for (var entry of records) {
          if (entry[1].status !== "inflight" && entry[1].status !== "queued") records.delete(entry[0]);
          if (records.size <= 400) break;
        }
      }
      adapter.scan();
    }
    async function pump() {
      if (current || stopped || suspended || !state || !state.enabled) return;
      var batch = Array.from(records.values()).filter(function (r) { return r.status === "queued"; })
        .sort(function (a, b) { return b.priority - a.priority || a.at - b.at; }).slice(0, 4);
      if (!batch.length) return;
      var run = generation;
      var job = { id: "auto-" + Date.now() + "-" + (++serial) };
      current = job;
      batch.forEach(function (r) { r.status = "inflight"; });
      var timeout;
      try {
        var response = await Promise.race([
          api.runtime.sendMessage({ type: "FF_AUTO_CLASSIFY", revision: state.revision,
            request: FocusFeedLiveProvider.cloudRequest({ requestId: job.id, profile: profile(), videos: batch.map(function (r) { return r.video; }) }) }),
          new Promise(function (_resolve, reject) { timeout = setTimeout(function () { reject(new Error("Classifier timed out")); }, 35000); })
        ]);
        if (run !== generation || stopped) return;
        if (!response || !response.ok || !response.data || !response.data.ok) throw new Error(response && response.error && response.error.message || "Backend unavailable");
        var result = response.data.data;
        var assessments = result.assessments;
        if (!Array.isArray(assessments) || assessments.length !== batch.length) throw new Error("Incomplete classifier response");
        var ids = new Set();
        batch.forEach(function (r) {
          var a = assessments.find(function (a) { return a.videoId === r.video.videoId; });
          if (!FocusFeedWorkflow.isValidDecisionAssessment(a, r.video.videoId) || ids.has(a.videoId)) throw new Error("Invalid classifier response");
          var expected = profile().objectives.map(function (o) { return o.id; }).sort();
          if (JSON.stringify(a.objectiveMatches.map(function (m) { return m.objectiveId; }).sort()) !== JSON.stringify(expected)) throw new Error("Stale objective judgments");
          ids.add(a.videoId);
        });
        batch.forEach(function (r) {
          var a = assessments.find(function (a) { return a.videoId === r.video.videoId; });
          r.status = "done"; r.assessment = a; r.action = FocusFeedWorkflow.policyDecision(a, mode);
        });
        setStatus(mode === "focus" ? "Focus active" : "General active");
      } catch (error) {
        if (run !== generation || stopped) return;
        api.runtime.sendMessage({ type: "FF_AUTO_CANCEL", requestId: job.id }).catch(function () {});
        retryAt = Date.now() + 30000;
        records.forEach(function (r) { if (r.status === "queued" || r.status === "inflight") {
          r.status = "error"; r.retryAt = retryAt;
        } });
        setStatus("Backend unavailable · channel blocks remain active");
      } finally {
        clearTimeout(timeout);
        if (current === job) current = null;
        if (run === generation && !stopped && !suspended) { rescan(); schedule(); }
      }
    }
    function navigate(start) {
      suspended = start;
      cancel(); cards.clear(); displayed.clear(); restored.clear(); adapter.clear();
      if (!start) reload();
    }
    function restore(id) { restored.add(id); adapter.scan(); }
    function snapshot() {
      var decisions = new Map();
      displayed.forEach(function (d, card) {
        if (!card.isConnected) return;
        var r = records.get(d.video.videoId) || completed.get(card);
        decisions.set(d.video.videoId || d.video.channelId, Object.assign({}, d, r && d.route !== "channel_block" ? { assessment: r.assessment } : {}));
      });
      return { status: status, mode: mode, enabled: !!(state && state.enabled), records: Array.from(decisions.values()).slice(-100),
        hidden: Array.from(cards.keys()).filter(function (c) { return c.dataset.focusfeedAutoHidden === "true"; }).length };
    }
    function tick() {
      if (state && profile().mode !== mode) { reload(); return; }
      if (!suspended && !stopped) rescan();
    }
    return { observe: observe, reload: reload, navigate: navigate, tick: tick, snapshot: snapshot, restore: restore,
      preferencesChanged: reload, stop: function () { stopped = true; cancel(); clearTimeout(expiryTimer); cards.clear(); displayed.clear(); adapter.clear(); } };
  }
  root.FocusFeedAutoRuntime = { create: create };
})(globalThis);
