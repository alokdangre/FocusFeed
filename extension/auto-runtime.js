// Per-tab continuous filtering. The popup and diagnostics do not own its lifetime.
(function (root) {
  "use strict";
  function create(adapter, api) {
    api = api || chrome;
    function monotonic() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
    var state = null, blocks = [], generation = 0, records = new Map(), cards = new Map();
    var current = new Map(), timer = null, retryAt = 0, expiryTimer = null, stopped = false, suspended = false;
    var status = "Loading settings", serial = 0, reloadSerial = 0, mode = "general";
    var metrics = { requests: 0, cacheHits: 0, shared: 0, providerCalls: 0, providerQuestions: 0, inputTokens: 0, outputTokens: 0 };
    var displayed = new Map(), completed = new WeakMap(), facts = new Map();
    var judgmentKey = null, transportKey = null, activityScheduled = false;
    var learning = typeof FocusFeedLearningPolicy !== "undefined" ? FocusFeedLearningPolicy : null;
    var corrections = learning ? learning.empty() : null, channelProfiles = [], endpoint = "", investigations = new Map();
    function profile() { return state && FocusFeedSettings.effective(state); }
    function decision(assessment, video) {
      return FocusFeedVideo.policyDecision(learning ? learning.apply(corrections, video, profile(), assessment) : assessment, mode);
    }
    function resolved(assessment, video) {
      if (assessment.objectiveMatches.some(function (m) {
        if (m.labelSource !== "user") return false;
        var o = profile().objectives.find(function (o) { return o.id === m.objectiveId; });
        var c = learning && o && learning.correction(corrections, video, o);
        return !c || c.match !== (m.matchProbability >= .5);
      })) return false;
      var applied = learning ? learning.apply(corrections, video, profile(), assessment) : assessment;
      return applied.outcome === "match" || profile().objectives.every(function (o) {
        return assessment.objectiveMatches.some(function (m) { return m.objectiveId === o.id; });
      });
    }
    function investigate(video) {
      if (!learning || mode !== "general" || video.itemType === "collection" || !video.channelId) return;
      var profiles = learning.channelProfiles(channelProfiles, video);
      var missing = profile().objectives.some(function (o) { return !profiles.some(function (p) {
        return learning.allowed(corrections, p.channelId, FocusFeedVideo.objectiveKey(o)) || learning.judgment(p, o, endpoint, Date.now());
      }); });
      if (!missing) return;
      var key = JSON.stringify([video.channelId, endpoint, FocusFeedVideo.profileKey(profile())]);
      var existing = investigations.get(key);
      if (existing && existing.until > Date.now()) return existing.pending;
      var token = { until: Date.now() + 90000, pending: true };
      investigations.set(key, token);
      if (investigations.size > 200) investigations.delete(investigations.keys().next().value);
      api.runtime.sendMessage({ type: "FF_CHANNEL_LEARN", video: video, revision: state.revision }).catch(function () {}).finally(function () {
        token.pending = false;
        if (!stopped && !suspended) rescan();
      });
      return true;
    }
    function render(card, video, action, reason) {
      displayed.set(card, { video: video, action: action === "pending" ? null : action,
        route: reason || (action === "pending" ? "model_pending" : "unfiltered"), status: reason === "refreshing" ? "refreshing" : action === "pending" ? "pending" : "resolved" });
      if (displayed.size > 1000) displayed.delete(displayed.keys().next().value);
      adapter.render(card, video, action, reason);
    }
    function cancel(drop, preserveCompleted) {
      generation++;
      current.forEach(function (job) { api.runtime.sendMessage({ type: "FF_AUTO_CANCEL", requestId: job.id }).catch(function () {}); });
      current.clear();
      clearTimeout(timer); timer = null;
      if (drop) { records.clear(); if (!preserveCompleted) completed = new WeakMap(); }
      else records.forEach(function (r, id) { if (r.status !== "done") records.delete(id); });
    }
    function setStatus(value) { status = value; }
    async function reload(resetMetrics) {
      if (resetMetrics === true) metrics = { requests: 0, cacheHits: 0, shared: 0, providerCalls: 0, providerQuestions: 0, inputTokens: 0, outputTokens: 0 };
      var serial = ++reloadSerial;
      var prefs = await api.storage.local.get(null);
      if (!prefs.focusfeedSettingsV2) {
        await api.runtime.sendMessage({ type: "FF_SETTINGS_GET" });
        prefs = await api.storage.local.get(null);
      }
      if (stopped || serial !== reloadSerial) return;
      var next = FocusFeedSettings.migrate(prefs);
      var nextProfile = FocusFeedSettings.effective(next);
      var nextTransport = JSON.stringify([prefs.classifierEndpoint || "", prefs.focusfeedCacheEpochV1 || 0]);
      var preserveCompleted = !!(state && transportKey === nextTransport && resetMetrics !== true);
      // Explicit blocks and Shorts visibility are local policy. Keep topic scores
      // and active requests when those change; invalidate only their actual inputs.
      var nextKey = JSON.stringify([FocusFeedVideo.profileKey(FocusFeedSettings.effective(next)), prefs.classifierEndpoint || "",
        prefs.focusfeedCacheEpochV1 || 0]);
      if (nextKey !== judgmentKey || resetMetrics === true) { cancel(true, preserveCompleted); retryAt = 0; judgmentKey = nextKey; }
      else if (!next.enabled) cancel(false);
      transportKey = nextTransport;
      state = next;
      blocks = prefs.focusFeedChannelBlocksV1 || [];
      corrections = learning ? Object.assign(learning.empty(), prefs[learning.CORRECTIONS] || {}) : null;
      channelProfiles = learning ? prefs[learning.PROFILES] || [] : [];
      endpoint = learning ? learning.endpointKey(prefs.classifierEndpoint) : "";
      mode = profile().mode;
      clearTimeout(expiryTimer);
      if (FocusFeedSettings.focusActive(state) && state.focusSession.endsAt) {
        expiryTimer = setTimeout(function () { reload().catch(function () { setStatus("Could not reload settings"); }); }, Math.max(1, Date.parse(state.focusSession.endsAt) - Date.now() + 20));
      }
      setStatus(!state.enabled ? "Paused" : FocusFeedSettings.valid(profile()) ?
        (mode === "focus" ? "Focus active" : "General active") : "Channel blocks active · confirm topics for AI filtering");
      if (adapter.configure) adapter.configure(state);
      if (!suspended) adapter.scan();
      reportActivity();
    }
    function observe(card, rawVideo) {
      if (!state || stopped || suspended) return;
      var video = FocusFeedVideo.videoInput(rawVideo);
      // Keep verified identity alongside facts for this exact video ID. Player
      // tiles often expose only an author label, unlike their sidebar copy.
      video.aliases = rawVideo.aliases || [];
      video.creators = rawVideo.creators || [];
      if (video.videoId) {
        var known = facts.get(video.videoId);
        if (known) {
          ["title", "channel", "description", "duration"].forEach(function (key) { if (!video[key]) video[key] = known[key]; });
          if (video.itemType === "collection" && !video.entries.length) video.entries = known.entries || [];
          if (video.itemType !== "collection") {
            if (!video.channelId) video.channelId = known.channelId;
            if (video.channelId === known.channelId) video.aliases = Array.from(new Set(video.aliases.concat(known.aliases || [])));
            video.creators = FocusFeedChannelPolicy.creators({ creators: video.creators.concat(FocusFeedChannelPolicy.creators(known)) });
          }
        }
        facts.set(video.videoId, video);
        if (facts.size > 1000) facts.delete(facts.keys().next().value);
      }
      cards.set(card, video);
      if (cards.size > 1000) cards.delete(cards.keys().next().value);
      if (!state.enabled) { render(card, video, "show"); return; }
      if (rawVideo.collection && !video.collectionId) { render(card, video, FocusFeedVideo.uncertaintyAction(mode), "collection_unknown"); return; }
      if (state.hideShorts && video.isShort) { render(card, video, "hide", "shorts_block"); return; }
      var block = FocusFeedChannelPolicy.matchingBlock(blocks, video, profile());
      if (block) { render(card, video, "hide", "channel_block"); return; }
      if (learning && learning.collectionBlock(corrections, video)) { render(card, video, "hide", "collection_block"); return; }
      // Topic policy filters recommendations. Opening a video is an explicit choice,
      // including direct links and autoplay; never start a second semantic playback gate.
      if (rawVideo.playback) { render(card, video, "show", "user_playback"); return; }
      if (!video.videoId || !FocusFeedSettings.valid(profile())) { render(card, video, "show"); return; }
      var local = learning && learning.action(corrections, channelProfiles, video, profile(), endpoint);
      if (local) {
        var queuedRecord = records.get(video.videoId);
        if (queuedRecord && queuedRecord.status === "queued") records.delete(video.videoId);
        render(card, video, local.action, local.reason); return;
      }
      var fp = FocusFeedVideo.fingerprint(video) + (video.itemType === "collection" ? mode : "");
      var previous = completed.get(card);
      if (previous && previous.videoId !== video.videoId) previous = null;
      if (previous && previous.scope !== judgmentKey && previous.fp === fp && previous.expiresAt > Date.now()) {
        // Removal is local policy over the surviving per-topic probabilities.
        // Match by semantic identity: tags can get new UI IDs when saved.
        var reused = profile().objectives.flatMap(function (objective) {
          var saved = (previous.objectives || []).find(function (o) { return o.key === FocusFeedVideo.objectiveKey(objective); });
          var match = saved && previous.assessment.objectiveMatches.find(function (m) { return m.objectiveId === saved.id; });
          var c = learning && learning.correction(corrections, video, objective);
          return match && (match.labelSource !== "user" || c && c.match === (match.matchProbability >= .5)) ?
            [Object.assign({}, match, { objectiveId: objective.id, text: objective.text })] : [];
        });
        if (reused.length === profile().objectives.length) {
          var assessment = { videoId: video.videoId, objectiveMatches: reused, outcome: FocusFeedVideo.outcome(reused),
            reason: "Policy applied to saved scores for the current topics.", evidence: [] };
          previous = Object.assign({}, previous, { scope: judgmentKey, assessment: assessment, source: "local_cache", objectives: objectiveKeys(profile()) });
          completed.set(card, previous);
          render(card, video, decision(assessment, video), "local_cache"); return;
        }
        // A positive score for a surviving topic is sufficient for OR policy.
        // A match for a removed topic cannot justify retaining that decision.
        var surviving = learning ? learning.apply(corrections, video, profile(), { objectiveMatches: reused }) : { objectiveMatches: reused };
        if (surviving.objectiveMatches.some(function (match) { return match.matchProbability >= .5; })) {
          render(card, video, FocusFeedVideo.policyDecision({ outcome: "match" }, mode), "retained_match"); return;
        }
      }
      function waiting(reason) {
        if (previous && previous.assessment) render(card, video, decision(previous.assessment, video), reason === "unavailable" ? "refresh_failed" : "refreshing");
        else render(card, video, reason === "unavailable" ? FocusFeedVideo.uncertaintyAction(mode) : "pending", reason);
      }
      if (rawVideo.noNewTopicChecks) {
        var saved = previous || records.get(video.videoId);
        if (saved && saved.fp === fp && saved.assessment) render(card, video, decision(saved.assessment, video), saved.source || "model");
        else render(card, video, FocusFeedVideo.uncertaintyAction(mode), "focus_paused");
        return;
      }
      if (previous && previous.scope === judgmentKey && previous.fp === fp && previous.expiresAt > Date.now() && resolved(previous.assessment, video)) {
        render(card, video, decision(previous.assessment, video), previous.source || "model");
        if (previous.assessment.outcome === "uncertain") investigate(video);
        return;
      }
      var record = records.get(video.videoId);
      if (record && record.fp !== fp) {
        if (record.status === "queued") { record.video = video; record.fp = fp; record.readyAt = Math.min(record.settleDeadline, monotonic() + 150); }
        else { records.delete(video.videoId); record = null; }
      }
      if (record && record.status === "done" && record.expiresAt <= Date.now()) {
        records.delete(video.videoId); record = null;
      }
      if (record && record.status === "done" && !resolved(record.assessment, video)) {
        records.delete(video.videoId); record = null;
      }
      if (record && record.status === "done") {
        completed.set(card, { videoId: video.videoId, scope: judgmentKey, fp: fp, assessment: record.assessment, objectives: record.objectives, source: record.source, expiresAt: record.expiresAt });
        render(card, video, decision(record.assessment, video), record.source || "model");
        if (record.assessment.outcome === "uncertain") investigate(video);
        return;
      }
      // Only unresolved cards need channel-topic mapping. Retained matches above
      // already settle the decision, including after another topic was added.
      if (learning && mode === "general" && learning.channelProfiles(channelProfiles, video).some(function (p) {
        return p.endpoint === endpoint && p.expiresAt > Date.now() && (p.judgments || []).some(function (j) {
          return j.contract === p.contract && j.blockChannel && j.expiresAt > Date.now();
        });
      }) && investigate(video)) {
        render(card, video, previous && previous.assessment ? decision(previous.assessment, video) : "pending", "channel_pending"); return;
      }
      if (record && record.status === "error" && (rawVideo.noAutomaticRetry || Date.now() < record.retryAt)) {
        waiting("unavailable"); return;
      }
      if (!FocusFeedVideo.hasMinimumModelMetadata(video)) {
        if (previous) waiting(); else render(card, video, "pending", "metadata_pending");
        return;
      }
      var rect = card.getBoundingClientRect();
      var near = rect.bottom >= -300 && rect.top <= (root.innerHeight || 800) + 600;
      if (!near && !rawVideo.managed) { waiting(); return; }
      if (Date.now() < retryAt) { waiting("unavailable"); return; }
      if (!record || record.status === "error") {
        var queued = Array.from(records.values()).filter(function (r) { return r.status === "queued"; });
        if (queued.length >= 60) { waiting(); return; }
        record = { video: video, fp: fp, status: "queued", attempts: record ? record.attempts + 1 : 1, at: Date.now(), readyAt: monotonic() + 250, settleDeadline: monotonic() + 600, priority: rect.top < (root.innerHeight || 800) && rect.bottom > 0 ? 100 : 10 };
        records.set(video.videoId, record);
      }
      waiting();
      schedule();
    }
    function schedule() {
      reportActivity();
      var queued = Array.from(records.values()).filter(function (r) { return r.status === "queued"; });
      if (!queued.length) return;
      var delay = Math.max(0, admissionTime(queued) - monotonic());
      if (!timer && capacity() > 0 && !stopped && !suspended) timer = setTimeout(function () { timer = null; pump(); }, delay);
    }
    function reportActivity() {
      if (!adapter.activity || activityScheduled) return;
      activityScheduled = true;
      Promise.resolve().then(function () {
        activityScheduled = false; if (stopped) return;
        var pending = Array.from(records.values()).filter(function (r) { return r.status === "queued" || r.status === "inflight"; }).length;
        adapter.activity({ pending: pending, refreshing: Array.from(displayed.values()).some(function (d) { return (d.status === "resolved" || d.status === "refreshing") && d.route !== "unfiltered"; }) });
      });
    }
    function admissionTime(queued) {
      // Admit a scan's candidates together, rather than splitting one batch because
      // its final card was observed a millisecond after its first card.
      return Math.min(Math.max.apply(Math, queued.map(function (r) { return r.readyAt; })),
        Math.min.apply(Math, queued.map(function (r) { return r.settleDeadline; })));
    }
    function objectiveKeys(value) {
      return value.objectives.map(function (o) { return { id: o.id, key: FocusFeedVideo.objectiveKey(o) }; });
    }
    function capacity() {
      return Math.max(0, 40 - Array.from(records.values()).filter(function (r) { return r.status === "inflight"; }).length);
    }
    function validAssessment(a, videoId, selectedProfile) {
      return FocusFeedVideo.isValidDecisionAssessment(a, videoId) &&
        !a.objectiveMatches.some(function (m) { return !selectedProfile.objectives.some(function (o) { return o.id === m.objectiveId && o.text === m.text; }); }) &&
        a.outcome === FocusFeedVideo.outcome(a.objectiveMatches) &&
        (a.objectiveMatches.length === selectedProfile.objectives.length || a.outcome === "match");
    }
    function progress(message) {
      var job = current.get(message.requestId), a = message.assessment;
      if (!job || job.run !== generation || stopped || suspended || !a || !validAssessment(a, a.videoId, job.profile)) return;
      var r = job.batch.find(function (r) { return r.video.videoId === a.videoId; });
      if (!r || records.get(a.videoId) !== r || r.status !== "inflight") return;
      r.status = "done"; r.assessment = a; r.objectives = objectiveKeys(job.profile);
      r.source = message.origin && message.origin.source || "model";
      r.expiresAt = message.origin && Number.isFinite(message.origin.expiresAt) ? message.origin.expiresAt : Date.now() + 300000;
      rescan(); schedule();
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
      if (!capacity() || stopped || suspended || !state || !state.enabled) return;
      var queued = Array.from(records.values()).filter(function (r) { return r.status === "queued"; });
      if (queued.length && monotonic() < admissionTime(queued)) { schedule(); return; }
      var batch = Array.from(records.values()).filter(function (r) { return r.status === "queued" && r.readyAt <= monotonic(); })
        .sort(function (a, b) { return b.priority - a.priority || a.at - b.at; }).slice(0, capacity());
      if (!batch.length) { schedule(); return; }
      var run = generation;
      var requestProfile = profile();
      var job = { id: "auto-" + Date.now() + "-" + (++serial), batch: batch, run: run, profile: requestProfile };
      current.set(job.id, job);
      batch.forEach(function (r) { r.status = "inflight"; });
      reportActivity();
      var timeout;
      try {
        var response = await Promise.race([
          api.runtime.sendMessage({ type: "FF_AUTO_CLASSIFY", revision: state.revision,
            request: FocusFeedVideo.cloudRequest({ requestId: job.id, profile: requestProfile, videos: batch.map(function (r) { return r.video; }) }) }),
          new Promise(function (_resolve, reject) { timeout = setTimeout(function () { reject(new Error("Classifier timed out")); }, 90000); })
        ]);
        if (run !== generation || stopped) return;
        if (!response || !response.ok || !response.data || !response.data.ok) throw new Error(response && response.error && response.error.message || "Backend unavailable");
        var result = response.data.data;
        var assessments = result.assessments;
        if (!Array.isArray(assessments) || assessments.length !== batch.length) throw new Error("Incomplete classifier response");
        var ids = new Set();
        batch.forEach(function (r) {
          var a = assessments.find(function (a) { return a.videoId === r.video.videoId; });
          if (!validAssessment(a, r.video.videoId, requestProfile) || ids.has(a.videoId)) throw new Error("Invalid classifier response");
          ids.add(a.videoId);
        });
        var cacheInfo = result.diagnostics && result.diagnostics.cache || {};
        var usage = result.diagnostics && result.diagnostics.usage || {};
        metrics.requests += 1;
        metrics.cacheHits += Number(cacheInfo.hits) || 0;
        metrics.shared += Number(cacheInfo.shared) || 0;
        metrics.providerCalls += Number(cacheInfo.providerCalls) || 0;
        metrics.providerQuestions += Number(cacheInfo.providerQuestions) || 0;
        metrics.inputTokens += Number(usage.input_tokens) || 0;
        metrics.outputTokens += Number(usage.output_tokens) || 0;
        batch.forEach(function (r) {
          var a = assessments.find(function (a) { return a.videoId === r.video.videoId; });
          r.status = "done"; r.assessment = a; r.objectives = objectiveKeys(requestProfile); r.action = decision(a, r.video);
          var cached = result.diagnostics && result.diagnostics.cache;
          var origin = cached && cached.byVideo && cached.byVideo[r.video.videoId];
          r.source = result.diagnostics && (result.diagnostics.missingVideoIds || []).indexOf(r.video.videoId) !== -1
            ? "invalid_assessment" : origin && origin.source || "model";
          r.expiresAt = origin && Number.isFinite(origin.expiresAt) ? origin.expiresAt : Date.now() + 300000;
        });
        setStatus(mode === "focus" ? "Focus active" : "General active");
      } catch (error) {
        if (run !== generation || stopped) return;
        api.runtime.sendMessage({ type: "FF_AUTO_CANCEL", requestId: job.id }).catch(function () {});
        retryAt = Date.now() + 30000;
        batch.forEach(function (r) { if (r.status === "inflight") {
          r.status = "error"; r.retryAt = r.attempts >= 2 ? Infinity : retryAt;
        } });
        setStatus("Backend unavailable · channel blocks remain active");
      } finally {
        clearTimeout(timeout);
        current.delete(job.id);
        if (run === generation && !stopped && !suspended) { rescan(); schedule(); }
      }
    }
    function navigate(start) {
      suspended = start;
      cancel(false); cards.clear(); displayed.clear(); adapter.clear(true);
      reportActivity();
      if (!start) reload();
    }
    function snapshot() {
      var decisions = new Map();
      displayed.forEach(function (d, card) {
        if (!card.isConnected) return;
        var r = records.get(d.video.videoId) || completed.get(card);
        decisions.set(d.video.videoId || d.video.channelId, Object.assign({}, d, r && d.route !== "channel_block" ? { assessment: r.assessment } : {}));
      });
      return { status: status, mode: mode, enabled: !!(state && state.enabled), metrics: Object.assign({}, metrics), records: Array.from(decisions.values()).slice(-100),
        hidden: Array.from(cards.keys()).filter(function (c) { return c.dataset.focusfeedAutoHidden === "true"; }).length };
    }
    function tick() {
      if (state && profile().mode !== mode) { reload(); return; }
      if (!suspended && !stopped) rescan();
    }
    return { observe: observe, reload: reload, navigate: navigate, tick: tick, snapshot: snapshot, progress: progress,
      preferencesChanged: reload, stop: function () { stopped = true; cancel(true); clearTimeout(expiryTimer); cards.clear(); displayed.clear(); adapter.clear(); } };
  }
  root.FocusFeedAutoRuntime = { create: create };
})(globalThis);
