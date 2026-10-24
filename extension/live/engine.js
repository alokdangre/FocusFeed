// A bounded live run. Every eligible recommendation enters the provider scheduler.
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
    video.channelId = video.channelId.slice(0, 100);
    video.duration = video.duration.slice(0, 30);
    video.description = video.description.slice(0, 1000);
    return video;
  }

  function profileInput(profile) {
    var source = profile || {};
    return copy({
      id: source.id,
      version: source.version,
      mode: source.mode === "focus" ? "focus" : "general",
      objectives: Array.isArray(source.objectives) ? source.objectives : [],
    });
  }

  function fingerprint(video) { return W.stableStringify(videoInput(video)); }

  function create(options) {
    var profile = profileInput(options.profile);
    var classifier = copy(options.classifier);
    var contextId = options.runId;
    var records = new Map();
    var allowance = PAGE_SIZE;
    var callBudget = 3;
    var modelBudget = PAGE_SIZE;
    var calls = 0;
    var modelVideos = 0;
    var stopped = false;
    var events = [];
    var startedAt = Date.now();
    var scheduler;
    var channelBlocks = copy(options.channelBlocks || []);

    function emit(record) {
      if (options.onRecord) options.onRecord(copy(record));
      if (options.onChange) options.onChange();
    }

    function event(value) {
      events.push(copy(value));
      if (events.length > 1000) events.shift();
      if (options.onChange) options.onChange();
    }

    scheduler = root.FocusFeedWorkflowScheduler.create({
      initialContextId: contextId,
      batchSize: 4,
      queueCap: 24,
      maxInFlight: 1,
      batchWindowMs: 150,
      timeoutMs: options.timeoutMs || 120000,
      validateAssessment: function (assessment, entry) {
        return W.isValidDecisionAssessment(assessment, entry.videoId);
      },
      provider: async function (request, context) {
        if (stopped || calls >= callBudget || modelVideos + request.videos.length > modelBudget) {
          throw new Error("Model allowance used. Load more explicitly to increase the allowance.");
        }
        calls += 1;
        modelVideos += request.videos.length;
        event({ type: "provider_dispatch", atMs: Date.now(), requestId: request.requestId, videos: request.videos.length });
        var response = await options.provider({
          requestId: contextId + "-" + request.requestId,
          profile: copy(profile),
          videos: copy(request.videos),
        }, context.signal);
        if (response.classifier &&
            (response.classifier.model !== classifier.model ||
             response.classifier.promptVersion !== classifier.promptVersion)) {
          throw new Error("Provider identity changed. Start a new run with the updated provider context.");
        }
        var diagnostics = response.diagnostics || {};
        if (diagnostics.duplicateAssessmentCount ||
            diagnostics.unexpectedAssessmentCount ||
            diagnostics.invalidAssessmentCount) {
          throw new Error("Provider output failed ID or schema validation.");
        }
        var missing = new Set(diagnostics.missingVideoIds || []);
        event({
          type: "provider_response",
          atMs: Date.now(),
          requestId: request.requestId,
          timing: response.timing || null,
          diagnostics: {
            missing: missing.size,
            returned: (response.assessments || []).length,
            resolvedModel: response.classifier && response.classifier.model || null,
            thresholds: diagnostics.thresholds || null,
            usage: diagnostics.usage || null,
            judgments: diagnostics.judgments || null,
          },
        });
        return {
          assessments: (response.assessments || []).filter(function (assessment) {
            return !missing.has(assessment.videoId);
          }),
        };
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
        emit(record);
      },
      onFailure: function (failure) {
        var record = records.get(failure.videoId);
        if (stopped || !record || record.key !== failure.key) return;
        record.status = "failed";
        record.route = "unresolved";
        record.action = W.uncertaintyAction(profile.mode);
        record.reason = failure.message;
        record.failure = failure.code;
        record.completedAt = Date.now();
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
      var record = {
        video: video,
        fingerprint: fp,
        key: fp,
        admittedAt: Date.now(),
        status: "pending",
        route: "model_pending",
        action: W.uncertaintyAction(profile.mode),
        reason: "Waiting for Jev classification.",
      };
      records.set(video.videoId, record);
      var channelBlock = root.FocusFeedChannelPolicy &&
        root.FocusFeedChannelPolicy.matchingBlock(channelBlocks, video, profile);
      if (channelBlock) {
        Object.assign(record, {
          status: "resolved",
          route: "channel_block",
          action: "hide",
          reason: "Hidden by your confirmed " +
            (channelBlock.scope === "global" ? "global" : "topic-scoped") +
            " block for this channel.",
          channelBlockId: channelBlock.id,
          completedAt: Date.now(),
        });
        emit(record);
        return record;
      }
      if (!video.title.trim()) {
        Object.assign(record, {
          status: "unresolved",
          route: "metadata",
          reason: "A meaningful title is required before Jev classification.",
        });
        emit(record);
        return record;
      }
      if (calls >= callBudget || modelVideos >= modelBudget) {
        record.route = "deferred";
        record.status = "deferred";
        record.reason = "Model allowance used. No automatic retry.";
        emit(record);
        return record;
      }
      var admission = scheduler.enqueue({
        key: record.key,
        videoId: video.videoId,
        subscriberId: video.videoId,
        contextId: contextId,
        payload: video,
        priority: priority || 0,
      });
      if (admission.status === "deferred") {
        record.route = "deferred";
        record.status = "deferred";
        record.reason = "Queue is full; the mode's uncertainty policy remains active.";
      }
      emit(record);
      return record;
    }

    function loadMore() {
      if (stopped || allowance >= MAX_VIDEOS) return false;
      allowance += PAGE_SIZE;
      callBudget += 3;
      modelBudget += PAGE_SIZE;
      event({ type: "user_load_more", atMs: Date.now(), allowance: allowance });
      return true;
    }

    function addChannelBlock(block) {
      if (!block || !block.channelId) return false;
      channelBlocks.push(copy(block));
      records.forEach(function (record) {
        if (!root.FocusFeedChannelPolicy.matchesBlock(block, record.video, profile)) return;
        if (record.status === "pending") scheduler.removeSubscriber(record.video.videoId, "user_channel_block");
        record.status = "resolved";
        record.route = "channel_block";
        record.action = "hide";
        record.reason = "Hidden by your confirmed " +
          (block.scope === "global" ? "global" : "topic-scoped") +
          " block for this channel.";
        record.channelBlockId = block.id;
        record.completedAt = Date.now();
        emit(record);
      });
      event({ type: "channel_block_added", atMs: Date.now(), block: copy(block) });
      return true;
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      scheduler.stop("live_run_stopped");
      records.forEach(function (record) {
        if (record.status === "pending") {
          record.status = "canceled";
          record.route = "unresolved";
          record.reason = "Run stopped; no late action will apply.";
          emit(record);
        }
      });
    }

    function report() {
      var rows = Array.from(records.values());
      var counts = {};
      rows.forEach(function (record) { counts[record.route] = (counts[record.route] || 0) + 1; });
      return {
        schemaVersion: "focusfeed-live-report-v2",
        runId: contextId,
        startedAt: startedAt,
        exportedAt: Date.now(),
        profile: copy(profile),
        classifier: copy(classifier),
        stopped: stopped,
        budget: {
          allowance: allowance,
          callBudget: callBudget,
          modelVideoBudget: modelBudget,
          calls: calls,
          modelVideos: modelVideos,
        },
        counts: counts,
        scheduler: scheduler.snapshot(),
        events: copy(events),
        records: copy(rows),
      };
    }

    return { offer: offer, loadMore: loadMore, addChannelBlock: addChannelBlock, stop: stop, report: report };
  }

  root.FocusFeedLiveEngine = {
    create: create,
    fingerprint: fingerprint,
    videoInput: videoInput,
    profileInput: profileInput,
    PAGE_SIZE: PAGE_SIZE,
    MAX_VIDEOS: MAX_VIDEOS,
  };
})(globalThis);
