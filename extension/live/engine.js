// A bounded live run. Only rule/cache misses enter the provider scheduler.
(function (root) {
  "use strict";
  var W = root.FocusFeedWorkflow;
  var PAGE_SIZE = 12;
  var MAX_VIDEOS = 120;
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function videoInput(value) {
    var video = W.normalizeVideo(value);
    video.videoId = video.videoId.slice(0, 80);
    video.title = video.title.slice(0, 300);
    video.channel = video.channel.slice(0, 200);
    video.duration = video.duration.slice(0, 30);
    video.description = video.description.slice(0, 1000);
    return video;
  }
  function profileInput(profile) {
    var result = {};
    ["id", "version", "goal", "usefulTopics", "unwantedTopics", "exceptions", "languages", "mode"].forEach(function (field) {
      result[field] = profile[field];
    });
    return copy(result);
  }
  function fingerprint(video) { return W.stableStringify(videoInput(video)); }
  function create(options) {
    var profile = profileInput(options.profile);
    var preferences = copy(options.preferences);
    var classifier = copy(options.classifier);
    var contextId = options.runId;
    var records = new Map();
    var entries = options.cacheEntries || {};
    var allowance = PAGE_SIZE;
    var callBudget = 3;
    var modelBudget = PAGE_SIZE;
    var calls = 0;
    var modelVideos = 0;
    var stopped = false;
    var events = [];
    var cacheErrors = [];
    var startedAt = Date.now();
    var scheduler;
    function emit(record) {
      if (options.onRecord) options.onRecord(copy(record));
      if (options.onChange) options.onChange();
    }
    function event(value) {
      events.push(copy(value));
      if (events.length > 1000) events.shift();
      if (options.onChange) options.onChange();
    }
    function identity(video) {
      var value = W.buildCacheIdentity(video, profile, classifier);
      // Match exact provider strings as well as the shared compatibility signature.
      value.signature += "|" + W.stableStringify({ video: video, profile: profile });
      return value;
    }
    scheduler = root.FocusFeedWorkflowScheduler.create({
      initialContextId: contextId, batchSize: 4, queueCap: 24, maxInFlight: 1,
      batchWindowMs: 150, timeoutMs: options.timeoutMs || 120000,
      validateAssessment: function (assessment, entry) {
        return W.isValidDecisionAssessment(assessment, entry.videoId) &&
          ["tutorial", "practice", "news", "commentary", "entertainment", "music", "other", "unclear"].includes(assessment.contentPurpose);
      },
      provider: async function (request, context) {
        if (stopped || calls >= callBudget || modelVideos + request.videos.length > modelBudget) {
          throw new Error("Model allowance used. Load more explicitly to increase the allowance.");
        }
        // Consume before dispatch. Failures, cancellations, and retries cannot refund paid work.
        calls += 1;
        modelVideos += request.videos.length;
        event({ type: "provider_dispatch", atMs: Date.now(), requestId: request.requestId, videos: request.videos.length });
        var response = await options.provider({
          requestId: contextId + "-" + request.requestId,
          profile: copy(profile), videos: copy(request.videos),
        }, context.signal);
        if (response.classifier && (response.classifier.model !== classifier.model || response.classifier.promptVersion !== classifier.promptVersion)) {
          throw new Error("Provider identity changed. Start a new run to refresh its cache identity.");
        }
        var diagnostics = response.diagnostics || {};
        if (diagnostics.duplicateAssessmentCount || diagnostics.unexpectedAssessmentCount || diagnostics.invalidAssessmentCount) {
          throw new Error("Provider output failed ID or schema validation.");
        }
        var missing = new Set(diagnostics.missingVideoIds || []);
        event({ type: "provider_response", atMs: Date.now(), requestId: request.requestId, timing: response.timing || null, diagnostics: {
          missing: missing.size, returned: (response.assessments || []).length,
        }});
        return { assessments: (response.assessments || []).filter(function (assessment) { return !missing.has(assessment.videoId); }) };
      },
      onResult: function (result) {
        var record = records.get(result.videoId);
        if (stopped || !record || record.key !== result.key) return;
        record.route = "model";
        record.status = "resolved";
        record.assessment = copy(result.assessment);
        record.action = W.policyDecision(result.assessment, profile.mode);
        record.reason = result.assessment.reason || "Classified from recommendation metadata.";
        record.timing = result.timing;
        record.completedAt = Date.now();
        var entry = W.createCacheEntry({ identity: record.identity, assessment: result.assessment, source: "live-provider" });
        entries[record.identity.key] = entry;
        if (options.cache) options.cache.put(record.identity, result.assessment, { source: "live-provider" }).catch(function (error) {
          cacheErrors.push(error.message);
          if (cacheErrors.length > 20) cacheErrors.shift();
          event({ type: "cache_write_failed", atMs: Date.now(), message: error.message });
        });
        emit(record);
      },
      onFailure: function (failure) {
        var record = records.get(failure.videoId);
        if (stopped || !record || record.key !== failure.key) return;
        record.status = "failed"; record.route = "unresolved"; record.action = "show";
        record.reason = failure.message; record.failure = failure.code; record.completedAt = Date.now();
        emit(record);
      },
      onEvent: event,
    });
    function offer(input, priority) {
      if (stopped) return { status: "stopped" };
      var video = videoInput(input);
      if (!video.videoId) return { status: "metadata" };
      var previous = records.get(video.videoId);
      var fp = fingerprint(video);
      if (previous && previous.fingerprint === fp) return { status: "duplicate" };
      if (!previous && records.size >= allowance) return { status: "deferred" };
      if (previous) scheduler.removeSubscriber(video.videoId, "metadata_changed");
      var cacheIdentity = identity(video);
      var record = {
        video: video, fingerprint: fp, identity: cacheIdentity,
        key: cacheIdentity.signature, admittedAt: Date.now(),
        status: "pending", route: "model_pending", action: "show", reason: "Waiting for classification.",
      };
      records.set(video.videoId, record);
      var route = W.routeCandidate({ video: video, profile: profile, preferences: preferences, classifier: classifier });
      if (route.route === "rule" || route.route === "metadata") {
        Object.assign(record, route); emit(record); return record;
      }
      var cached = entries[cacheIdentity.key];
      if (W.cacheEntryStatus(cached, cacheIdentity, Date.now()) === "hit") {
        Object.assign(record, { route: "cache", status: "resolved", assessment: copy(cached.assessment),
          action: W.policyDecision(cached.assessment, profile.mode), reason: cached.assessment.reason || "Reused compatible assessment.", completedAt: Date.now() });
        emit(record); return record;
      }
      if (calls >= callBudget || modelVideos >= modelBudget) {
        record.route = "deferred"; record.status = "deferred"; record.reason = "Model allowance used. No automatic retry.";
        emit(record); return record;
      }
      var admission = scheduler.enqueue({ key: record.key, videoId: video.videoId, subscriberId: video.videoId,
        contextId: contextId, payload: video, priority: priority || 0 });
      if (admission.status === "deferred") {
        record.route = "deferred"; record.status = "deferred"; record.reason = "Queue is full; video stays visible.";
      }
      emit(record);
      return record;
    }
    function loadMore() {
      if (stopped || allowance >= MAX_VIDEOS) return false;
      allowance += PAGE_SIZE; callBudget += 3; modelBudget += PAGE_SIZE;
      event({ type: "user_load_more", atMs: Date.now(), allowance: allowance });
      return true;
    }
    function stop() {
      if (stopped) return;
      stopped = true; scheduler.stop("live_run_stopped");
      records.forEach(function (record) {
        if (record.status === "pending") {
          record.status = "canceled"; record.route = "unresolved"; record.reason = "Run stopped; no late action will apply."; emit(record);
        }
      });
    }
    function report() {
      var rows = Array.from(records.values());
      var counts = {};
      rows.forEach(function (record) { counts[record.route] = (counts[record.route] || 0) + 1; });
      return { schemaVersion: "focusfeed-live-report-v1", runId: contextId, startedAt: startedAt, exportedAt: Date.now(),
        profile: copy(profile), preferences: copy(preferences), classifier: copy(classifier), stopped: stopped,
        budget: { allowance: allowance, callBudget: callBudget, modelVideoBudget: modelBudget, calls: calls, modelVideos: modelVideos },
        counts: counts, scheduler: scheduler.snapshot(), events: copy(events), cacheErrors: cacheErrors.slice(), records: copy(rows) };
    }
    return { offer: offer, loadMore: loadMore, stop: stop, report: report };
  }
  root.FocusFeedLiveEngine = { create: create, fingerprint: fingerprint, videoInput: videoInput, profileInput: profileInput, PAGE_SIZE: PAGE_SIZE, MAX_VIDEOS: MAX_VIDEOS };
})(globalThis);
