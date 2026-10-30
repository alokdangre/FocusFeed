// Worker-owned channel retrieval, deduplication, and personal feedback writes.
(function (root) {
  "use strict";
  function create(options) {
    var policy = FocusFeedLearningPolicy, storage = options.storage, flights = new Map(), queue = [], active = 0, epoch = 0;
    var failures = new Map();
    var flightTraces = new Map();
    var journal = FocusFeedChannelInvestigations.create(options);
    function bounded(data) {
      return Object.assign(policy.empty(), data || {}, { items: (data && data.items || []).slice(-500),
        collections: (data && data.collections || []).slice(-500), history: (data && data.history || []).slice(-500), allowedChannels: (data && data.allowedChannels || []).slice(-500) });
    }
    async function correct(message, profile) {
      if (!profile || profile.mode !== "general" || typeof message.match !== "boolean") throw new Error("Corrections apply to General preferences.");
      var objective = profile.objectives.find(function (o) { return FocusFeedVideo.objectiveKey(o) === message.topicKey; });
      var video = FocusFeedVideo.videoInput(message.video);
      if (!objective || !policy.validTarget(video)) throw new Error("This item or topic changed. Reopen its menu.");
      return options.write(async function () {
        var prefs = await storage.get({ [policy.CORRECTIONS]: policy.empty(), focusfeedSettingsV2: null }), data = bounded(prefs[policy.CORRECTIONS]);
        var state = FocusFeedSettings.migrate(prefs), current = FocusFeedSettings.effective(state);
        if (!state.enabled || state.revision !== message.revision || current.mode !== "general" || !current.objectives.some(function (o) { return FocusFeedVideo.objectiveKey(o) === message.topicKey; })) throw new Error("Preferences changed. Reopen the video menu.");
        var previous = data.items.find(function (c) { return c.videoId === video.videoId && c.topicKey === message.topicKey; });
        var item = { id: "correction-" + Date.now() + "-" + Math.random().toString(16).slice(2),
          videoId: video.videoId, channelId: video.channelId, topicKey: message.topicKey, topic: objective.text,
          title: video.title, match: message.match, createdAt: Date.now() };
        item.labelSource = "user"; item.scope = video.itemType === "collection" ? "collection" : "video";
        if (video.itemType === "collection") { item.itemType = "collection"; item.collectionId = video.collectionId; }
        var original = message.assessment;
        var event = { id: item.id, type: "correction", item: item, previous: previous || null,
          video: video, modelAssessment: FocusFeedVideo.isValidDecisionAssessment(original, video.videoId) ? original : null };
        data.items = data.items.filter(function (c) { return c.videoId !== video.videoId || c.topicKey !== message.topicKey; }).concat(item);
        data.history.push(event); data.revision++;
        await storage.set({ [policy.CORRECTIONS]: bounded(data) });
        return item;
      });
    }
    async function hideCollection(rawVideo) {
      var video = FocusFeedVideo.videoInput(rawVideo);
      if (video.itemType !== "collection" || !policy.validTarget(video)) throw new Error("Collection identity is unavailable. Reopen its menu.");
      return options.write(async function () {
        var prefs = await storage.get({ [policy.CORRECTIONS]: policy.empty(), focusfeedSettingsV2: null });
        if (!FocusFeedSettings.migrate(prefs).enabled) throw new Error("Filtering is paused.");
        var data = bounded(prefs[policy.CORRECTIONS]);
        var existing = data.collections.find(function (c) { return c.collectionId === video.collectionId; });
        if (existing) return { item: existing, created: false };
        var item = { id: "collection-hide-" + Date.now() + "-" + Math.random().toString(16).slice(2), itemType: "collection",
          collectionId: video.collectionId, videoId: video.videoId, title: video.title, createdAt: Date.now() };
        data.collections.push(item); data.history.push({ id: item.id, type: "collection_hide", item: item, video: video }); data.revision++;
        await storage.set({ [policy.CORRECTIONS]: bounded(data) }); return { item: item, created: true };
      });
    }
    async function undo(id) {
      return options.write(async function () {
        var prefs = await storage.get({ [policy.CORRECTIONS]: policy.empty(), [policy.PROFILES]: [] });
        var data = bounded(prefs[policy.CORRECTIONS]), item = data.items.find(function (c) { return c.id === id; });
        if (!item) {
          var hidden = data.collections.find(function (c) { return c.id === id; });
          if (!hidden) return { removed: false };
          data.collections = data.collections.filter(function (c) { return c.id !== id; }); data.revision++;
          data.history.push({ id: "undo-" + Date.now(), type: "undo", correctionId: id, createdAt: Date.now() });
          await storage.set({ [policy.CORRECTIONS]: bounded(data) }); return { removed: true };
        }
        var event = data.history.find(function (e) { return e.id === id && e.type === "correction"; });
        data.items = data.items.filter(function (c) { return c.id !== id; });
        if (event && event.previous) data.items.push(event.previous);
        data.history.push({ id: "undo-" + Date.now(), type: "undo", correctionId: id, createdAt: Date.now() }); data.revision++;
        // Retract rules learned from this correction as well as the video override.
        var profiles = prefs[policy.PROFILES].map(function (p) {
          function depends(j) { return j.triggerId === id || (j.triggerIds || []).includes(id); }
          (p.judgments || []).filter(depends).forEach(function (j) {
            if (!policy.allowed(data, p.channelId, j.key)) data.allowedChannels.push({ channelId: p.channelId, topicKey: j.key });
          });
          return Object.assign({}, p, { judgments: (p.judgments || []).filter(function (j) { return !depends(j); }) });
        });
        await storage.set({ [policy.CORRECTIONS]: bounded(data), [policy.PROFILES]: profiles });
        return { removed: true };
      });
    }
    async function allowChannel(channelId, topicKey) {
      if (!FocusFeedChannelPolicy.normalizeChannelId(channelId) || typeof topicKey !== "string" || topicKey.length > 1000) throw new Error("Invalid channel preference.");
      return options.write(async function () {
        var prefs = await storage.get({ [policy.CORRECTIONS]: policy.empty() }), data = bounded(prefs[policy.CORRECTIONS]);
        if (!policy.allowed(data, channelId, topicKey)) data.allowedChannels.push({ channelId: channelId, topicKey: topicKey });
        data.revision++;
        await storage.set({ [policy.CORRECTIONS]: bounded(data) }); return { allowed: true };
      });
    }
    async function clear(extra) {
      epoch++; failures.clear(); journal.invalidate();
      await options.write(function () { return storage.set(Object.assign({ [policy.PROFILES]: [], [FocusFeedChannelInvestigations.KEY]: [] }, extra || {})); });
    }
    async function fetchEvidence(id) {
      var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 10000);
      try {
        var url = "https://www.youtube.com/" + (id[0] === "@" ? encodeURIComponent(id).replace(/^%40/i, "@") : "channel/" + encodeURIComponent(id)) + "/videos?hl=en";
        var response = await options.fetch(url, { signal: controller.signal, credentials: "omit", cache: "no-store" });
        if (!response.ok || response.redirected && new URL(response.url).hostname !== "www.youtube.com") throw new Error("YouTube channel evidence is unavailable.");
        var html;
        if (response.body && response.body.getReader) {
          var reader = response.body.getReader(), decoder = new TextDecoder(), parts = [], bytes = 0;
          while (true) {
            var chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 6000000) { controller.abort(); throw new Error("Channel page is too large."); }
            parts.push(decoder.decode(chunk.value, { stream: true }));
          }
          parts.push(decoder.decode()); html = parts.join("");
        } else html = await response.text();
        return FocusFeedChannelEvidence.parse(html, id);
      } finally { clearTimeout(timer); }
    }
    function learn(video, profile, triggerId, trace) {
      if (trace && !journal.current(trace)) return Promise.resolve({ status: "cancelled" });
      var id = FocusFeedChannelPolicy.normalizeChannelId(video.channelId);
      if (video.itemType === "collection" || video.collection || !id || !profile || profile.mode !== "general" || !FocusFeedSettings.valid(profile)) return Promise.resolve({ status: "skipped" });
      var key = JSON.stringify([id, profile.objectives.map(FocusFeedVideo.objectiveKey), triggerId || ""]);
      if (flights.has(key)) {
        if (!trace) return flights.get(key);
        var shared = flightTraces.get(key);
        journal.update(trace, { status: "shared", stage: "shared_investigation", sharedWith: shared && shared.id });
        return flights.get(key).then(async function (result) {
          await journal.update(trace, { status: result.status, stage: "finished", finishedAt: Date.now(),
            judgments: shared && shared.judgments || [], reason: "Reused another in-flight channel investigation." });
          return result;
        }, async function (error) {
          await journal.update(trace, { status: "failed", finishedAt: Date.now(), error: journal.error(error) }); throw error;
        });
      }
      trace = trace || journal.start(video, profile, triggerId);
      if (triggerId && queue.length >= 4) {
        var auto = queue.findIndex(function (job) { return !job.triggerId; });
        if (auto !== -1) queue.splice(auto, 1)[0].defer();
      }
      if (queue.length >= 4 || !triggerId && (failures.get(key) || 0) > Date.now()) {
        return journal.update(trace, { status: "deferred", stage: "queue", reason: queue.length >= 4 ? "Channel investigation queue is full." : "Retry cooldown is active." }).then(function () { return { status: "deferred" }; });
      }
      var run = epoch;
      journal.update(trace, { status: "queued", stage: "queued" });
      var promise = new Promise(function (resolve, reject) {
        var job = { execute: async function () {
          try {
            var result = await investigate(id, profile, triggerId, run, trace);
            await journal.update(trace, { status: result.status, stage: "finished", finishedAt: Date.now(),
              reason: result.reason || (result.status === "learned" ? (result.blockedTopics.length ? "A channel-level topic match was established." : "No channel-level topic match passed the required thresholds.") : result.status === "cached" ? "Reused stored channel judgments." : "This result was not applied.") });
            return result;
          } catch (error) {
            await journal.update(trace, { status: "failed", finishedAt: Date.now(), error: journal.error(error) });
            throw error;
          }
        }, resolve: resolve, reject: reject, triggerId: triggerId,
          defer: function () { journal.update(trace, { status: "deferred", stage: "queue", reason: "A user correction took priority." }); resolve({ status: "deferred" }); } };
        if (triggerId) queue.unshift(job); else queue.push(job);
      });
      flights.set(key, promise);
      flightTraces.set(key, trace);
      promise.finally(function () { flights.delete(key); flightTraces.delete(key); }).catch(function () {});
      promise.catch(function () { failures.set(key, Date.now() + 60000); if (failures.size > 200) failures.delete(failures.keys().next().value); });
      drain(); return promise;
    }
    function drain() {
      while (active < 2 && queue.length) {
        var job = queue.shift(); active++;
        (function (job) { Promise.resolve().then(job.execute).then(job.resolve, job.reject).finally(function () { active--; drain(); }); })(job);
      }
    }
    async function investigate(id, profile, triggerId, run, trace) {
      if (run !== epoch) return { status: "cancelled" };
      var startedAt = Date.now();
      await journal.update(trace, { status: "running", stage: "backend_contract", startedAt: startedAt });
      var endpoint = await options.endpoint(), contract = await options.contract(endpoint);
      await journal.update(trace, { endpoint: endpoint, classifier: { model: contract.model, promptVersion: contract.channelPromptVersion } });
      if (contract.channelPromptVersion !== policy.PROMPT) throw new Error("Restart the FocusFeed API to enable channel learning.");
      var namespace = JSON.stringify([endpoint, contract.model, contract.channelPromptVersion]);
      var prefs = await storage.get({ [policy.PROFILES]: [], [policy.CORRECTIONS]: policy.empty() });
      var confirmed = triggerId && prefs[policy.CORRECTIONS].items.find(function (c) { return c.id === triggerId; });
      if (triggerId && !confirmed) return { status: "cancelled" };
      var p = policy.channelProfiles(prefs[policy.PROFILES], { channelId: id })[0];
      var pinned = /^jev-\d+\.\d+\.\d+$/.test(contract.model);
      var fresh = pinned && p && p.endpoint === endpoint && p.contract === namespace && p.expiresAt > Date.now();
      if (!fresh) {
        await journal.update(trace, { stage: "fetch_evidence" });
        var evidence = await fetchEvidence(id);
        p = Object.assign(evidence, { version: "evidence-" + Date.now() + "-" + Math.random().toString(16).slice(2),
          expiresAt: Date.now() + 86400000, endpoint: endpoint, contract: namespace, judgments: [] });
      }
      await journal.update(trace, { stage: "evidence_ready", channelId: p.channelId, channelLabel: p.title,
        evidence: { title: p.title, description: p.description, uploads: p.uploads, version: p.version, expiresAt: p.expiresAt, source: fresh ? "cache" : "public_channel_page" } });
      var objectives = profile.objectives.filter(function (o) {
        return !policy.allowed(prefs[policy.CORRECTIONS], p.channelId, FocusFeedVideo.objectiveKey(o)) &&
          (triggerId || !policy.judgment(p, o, endpoint, Date.now()));
      });
      if (!objectives.length) { trace.judgments = p.judgments || []; return { status: "cached", channelId: p.channelId }; }
      var established = (p.judgments || []).filter(function (j) { return j.blockChannel && j.contract === namespace && j.expiresAt > Date.now(); }).slice(-12);
      var knownTopics = established.map(function (j) { return j.text; });
      async function evaluate(useSummary, selected) {
        var requestId = "channel-" + Date.now() + "-" + Math.random().toString(16).slice(2);
        var request = { requestId: requestId, profile: { id: profile.id, version: profile.version, mode: "general", objectives: selected },
          channel: { channelId: p.channelId, title: p.title, description: p.description,
            uploads: useSummary ? [] : p.uploads, knownTopics: useSummary ? knownTopics : [],
            ...(confirmed ? { confirmedVideo: { videoId: confirmed.videoId, title: confirmed.title, topic: confirmed.topic } } : {}) } };
        var step = { requestId: requestId, evidenceMode: useSummary ? "summary" : "uploads", request: request, startedAt: Date.now(), status: "pending" };
        trace.steps.push(step);
        await journal.update(trace, { stage: "classify_channel" });
        var body;
        try {
          body = await options.request("/channels/classify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }, 60000, null, endpoint);
          step.response = body; step.status = "completed"; step.finishedAt = Date.now();
          await journal.update(trace, {});
        } catch (error) {
          step.status = "failed"; step.error = journal.error(error); step.finishedAt = Date.now();
          await journal.update(trace, {}); throw error;
        }
        if (!body || body.requestId !== requestId || body.channelId !== p.channelId || !body.classifier ||
            body.classifier.promptVersion !== policy.PROMPT || typeof body.classifier.model !== "string" || !body.classifier.model || pinned && body.classifier.model !== contract.model || !Array.isArray(body.matches) || body.matches.length !== selected.length ||
            selected.some(function (o) { return body.matches.filter(function (m) { return m.objectiveId === o.id && m.text === o.text; }).length !== 1; })) throw new Error("Incomplete channel classification.");
        return body.matches.map(function (m) {
          if (typeof m.dominantProbability !== "number" || !Number.isFinite(m.dominantProbability) || m.dominantProbability < 0 || m.dominantProbability > 1 ||
              typeof m.blockChannel !== "boolean" || m.blockChannel !== (m.dominantProbability >= .5 && (useSummary || p.uploads.length >= 8))) throw new Error("Invalid channel probability.");
          return Object.assign({}, m, { key: FocusFeedVideo.objectiveKey(selected.find(function (o) { return o.id === m.objectiveId; })),
            contract: namespace, promptVersion: policy.PROMPT, triggerId: triggerId || null,
            triggerIds: triggerId ? [triggerId] : useSummary ? Array.from(new Set(established.flatMap(function (j) { return (j.triggerIds || []).concat(j.triggerId || []); }))) : [],
            startedAt: startedAt,
            expiresAt: Math.min(p.expiresAt, Date.now() + (pinned ? 86400000 : 300000)) });
        });
      }
      var judgments = await evaluate(knownTopics.length > 0 && !triggerId, objectives);
      if (knownTopics.length && !triggerId) {
        var unresolved = objectives.filter(function (o) { return !judgments.find(function (j) { return j.objectiveId === o.id; }).blockChannel; });
        if (unresolved.length) {
          var detailed = await evaluate(false, unresolved);
          judgments = judgments.filter(function (j) { return !detailed.some(function (d) { return d.key === j.key; }); }).concat(detailed);
        }
      }
      await journal.update(trace, { stage: "apply_policy", judgments: judgments });
      return options.write(async function () {
        var latest = await storage.get({ [policy.PROFILES]: [], [policy.CORRECTIONS]: policy.empty(), focusfeedSettingsV2: null });
        var current = FocusFeedSettings.effective(FocusFeedSettings.migrate(latest));
        if (run !== epoch || triggerId && !latest[policy.CORRECTIONS].items.some(function (c) { return c.id === triggerId; }) ||
            judgments.some(function (j) { return j.triggerIds.some(function (id) { return !latest[policy.CORRECTIONS].items.some(function (c) { return c.id === id; }); }); }) ||
            current.mode !== "general" || objectives.some(function (o) { return !current.objectives.some(function (c) { return FocusFeedVideo.objectiveKey(c) === FocusFeedVideo.objectiveKey(o); }); }) ||
            await options.endpoint() !== endpoint) return { status: "cancelled" };
        var list = latest[policy.PROFILES], old = list.find(function (c) { return c.channelId === p.channelId; });
        // Merge simultaneous topic investigations; do not overwrite another result or extend evidence freshness.
        var base = old && old.contract === namespace && old.expiresAt > Date.now() ? old : p;
        if (base.version !== p.version && old && JSON.stringify([base.description, base.uploads]) !== JSON.stringify([p.description, p.uploads])) return { status: "superseded" };
        if (base.version !== p.version && old) p = Object.assign({}, base);
        var accepted = judgments.filter(function (incoming) {
          var existing = (base.judgments || []).find(function (j) { return j.key === incoming.key; });
          return !existing || existing.expiresAt <= Date.now() || ((existing.startedAt || 0) <= incoming.startedAt && !(existing.triggerId && !incoming.triggerId));
        });
        p.judgments = (base.judgments || []).filter(function (j) { return !accepted.some(function (n) { return n.key === j.key; }); }).concat(accepted).slice(-48);
        trace.judgments = accepted;
        p.aliases = Array.from(new Set((p.aliases || []).concat(base.aliases || [], id))).filter(function (a) { return a !== p.channelId; });
        await storage.set({ [policy.PROFILES]: list.filter(function (c) { return c.channelId !== p.channelId; }).concat(p).slice(-80) });
        return { status: "learned", channelId: p.channelId, blockedTopics: accepted.filter(function (j) { return j.blockChannel; }).map(function (j) { return j.text; }) };
      });
    }
    return { correct: correct, hideCollection: hideCollection, undo: undo, allowChannel: allowChannel, clear: clear, learn: learn, fetchEvidence: fetchEvidence,
      startInvestigation: journal.start, recordInvestigation: journal.update, investigationError: journal.error };
  }
  root.FocusFeedChannelLearning = { create: create };
})(globalThis);
