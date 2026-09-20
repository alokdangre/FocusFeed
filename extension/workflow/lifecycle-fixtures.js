// FocusFeed lifecycle fixtures — deterministic scheduler scenarios for browser replay.

(function (root) {
  "use strict";

  var VERSION = "2026-09-20.1";
  var SCENARIOS = [{
    id: "burst-backpressure",
    name: "100-card burst stays bounded",
    note: "Twenty-four unique candidates fill the queue, 70 repeated appearances deduplicate, and one visible overflow replaces distant work while five distant overflows defer.",
    expected: {
      appearances: 100,
      queueDepth: 24,
      peakQueueDepth: 24,
      duplicateJoins: 70,
      overloadDeferred: 6,
      priorityEvictions: 1,
      visibleOverflowAdmitted: true,
    },
  }, {
    id: "dedupe-and-scroll-away",
    name: "Shared work survives one card leaving",
    note: "Two cards for one video share work. Removing one shared card and one queued card prevents obsolete application without canceling the subscriber that remains.",
    expected: {
      appearances: 7,
      duplicateJoins: 1,
      providerRequests: 2,
      providerVideos: 5,
      duplicateProviderVideos: 0,
      completedItems: 5,
      resultsApplied: 5,
      canceledSubscribers: 2,
      obsoleteApplications: 0,
      peakInFlightRequests: 1,
      queueDepth: 0,
      inFlightRequests: 0,
      queueP95Ms: 60,
      providerP95Ms: 40,
      totalP95Ms: 80,
    },
  }, {
    id: "goal-change-stale-result",
    name: "Goal change rejects a late result",
    note: "Changing the semantic context aborts old work. A provider that resolves anyway cannot update a current card, while a new-context request can complete.",
    expected: {
      oldRequestAborted: true,
      staleResultsIgnored: 1,
      oldContextApplications: 0,
      currentContextApplications: 1,
      canceledSubscribers: 1,
      providerRequests: 2,
      providerVideos: 2,
      queueDepth: 0,
      inFlightRequests: 0,
    },
  }, {
    id: "pause-resume",
    name: "Pause stops work and resume continues it",
    note: "Pausing aborts the active fake-provider request and requeues current subscribers. A late paused response is ignored; resume completes the retained work.",
    expected: {
      pausedRequestAborted: true,
      queueDepthWhilePaused: 3,
      providerRequestsWhilePaused: 1,
      pauseCount: 1,
      resumeCount: 1,
      staleResultsIgnored: 1,
      providerRequests: 3,
      providerVideos: 5,
      completedItems: 3,
      resultsApplied: 3,
      queueDepth: 0,
      inFlightRequests: 0,
    },
  }, {
    id: "timeout-error-validation",
    name: "Timeouts and provider failures stay visible",
    note: "One request times out, one rejects, and one omits its requested ID. None retries or becomes a successful classification.",
    expected: {
      failureCodes: ["missing_assessment", "provider_error", "timeout"],
      providerRequests: 3,
      providerVideos: 3,
      failedItems: 3,
      timedOutItems: 1,
      validationFailedItems: 1,
      completedItems: 0,
      resultsApplied: 0,
      retries: 0,
      visibleFallbacks: 3,
      queueDepth: 0,
      inFlightRequests: 0,
    },
  }];

  function deferred() {
    var resolve;
    var reject;
    var promise = new Promise(function (resolvePromise, rejectPromise) {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise: promise, resolve: resolve, reject: reject };
  }

  async function settle() {
    var index;
    for (index = 0; index < 8; index += 1) await Promise.resolve();
  }

  function candidate(videoId, subscriberId, priority, contextId) {
    return {
      key: contextId + ":" + videoId,
      videoId: videoId,
      subscriberId: subscriberId,
      contextId: contextId,
      payload: {
        videoId: videoId,
        title: "Lifecycle fixture " + videoId,
        channel: "FocusFeed Fixture",
      },
      priority: priority,
    };
  }

  function same(actual, expected) {
    return Object.keys(expected).every(function (key) {
      if (Array.isArray(expected[key])) return JSON.stringify(actual[key]) === JSON.stringify(expected[key]);
      return actual[key] === expected[key];
    });
  }

  function runBurstBackpressure(definition) {
    var events = [];
    var contextId = "profile-v1";
    var scheduler = root.FocusFeedWorkflowScheduler.create({
      autoDispatch: false,
      initialContextId: contextId,
      queueCap: 24,
      batchSize: 4,
      maxInFlight: 1,
      provider: function () {
        throw new Error("The burst-bound scenario must not invoke the provider.");
      },
      onEvent: function (event) { events.push(event); },
    });

    var index;
    for (index = 0; index < 24; index += 1) {
      scheduler.enqueue(candidate("base-" + index, "card-base-" + index, 10, contextId));
    }
    for (index = 0; index < 70; index += 1) {
      var duplicateVideo = "base-" + (index % 14);
      scheduler.enqueue(candidate(duplicateVideo, "card-duplicate-" + index, 10, contextId));
    }
    for (index = 0; index < 6; index += 1) {
      scheduler.enqueue(candidate(
        "overflow-" + index,
        "card-overflow-" + index,
        index === 0 ? 100 : 1,
        contextId
      ));
    }

    var snapshot = scheduler.snapshot();
    var actual = {
      appearances: snapshot.stats.appearances,
      queueDepth: snapshot.queueDepth,
      peakQueueDepth: snapshot.stats.peakQueueDepth,
      duplicateJoins: snapshot.stats.duplicateJoins,
      overloadDeferred: snapshot.stats.overloadDeferred,
      priorityEvictions: snapshot.stats.priorityEvictions,
      visibleOverflowAdmitted: snapshot.queuedKeys.indexOf(contextId + ":overflow-0") !== -1,
    };
    return Promise.resolve({
      id: definition.id,
      name: definition.name,
      note: definition.note,
      expected: definition.expected,
      actual: actual,
      pass: same(actual, definition.expected),
      events: events,
    });
  }

  async function runDedupeAndScroll(definition) {
    var now = 0;
    var contextId = "profile-v1";
    var firstCall = deferred();
    var requests = [];
    var applied = [];
    var events = [];
    var scheduler = root.FocusFeedWorkflowScheduler.create({
      autoDispatch: false,
      initialContextId: contextId,
      queueCap: 24,
      batchSize: 4,
      maxInFlight: 1,
      now: function () { return now; },
      provider: function (request) {
        requests.push(request);
        if (requests.length === 1) return firstCall.promise;
        return Promise.resolve({
          assessments: request.videos.map(function (video) {
            return { videoId: video.videoId, goalRelevance: "supporting" };
          }),
        });
      },
      onResult: function (result) { applied.push(result.subscriberId); },
      onEvent: function (event) { events.push(event); },
    });

    var index;
    for (index = 0; index < 6; index += 1) {
      scheduler.enqueue(candidate("video-" + index, "card-video" + index, 100 - index, contextId));
    }
    scheduler.enqueue(candidate("video-0", "card-video0-duplicate", 100, contextId));

    now = 10;
    scheduler.flush();
    await settle();
    scheduler.removeSubscriber("card-video0", "left_viewport");
    scheduler.removeSubscriber("card-video5", "left_viewport");
    now = 50;
    firstCall.resolve({
      assessments: requests[0].videos.map(function (video) {
        return { videoId: video.videoId, goalRelevance: "supporting" };
      }),
    });
    await settle();

    now = 60;
    scheduler.flush();
    now = 80;
    await settle();

    var snapshot = scheduler.snapshot();
    var providerIds = requests.reduce(function (all, request) {
      return all.concat(request.videos.map(function (video) { return video.videoId; }));
    }, []);
    var duplicateProviderVideos = providerIds.filter(function (videoId, position) {
      return providerIds.indexOf(videoId) !== position;
    }).length;
    var actual = {
      appearances: snapshot.stats.appearances,
      duplicateJoins: snapshot.stats.duplicateJoins,
      providerRequests: snapshot.stats.providerRequests,
      providerVideos: snapshot.stats.providerVideos,
      duplicateProviderVideos: duplicateProviderVideos,
      completedItems: snapshot.stats.completedItems,
      resultsApplied: snapshot.stats.resultsApplied,
      canceledSubscribers: snapshot.stats.canceledSubscribers,
      obsoleteApplications: applied.filter(function (subscriberId) {
        return subscriberId === "card-video0" || subscriberId === "card-video5";
      }).length,
      peakInFlightRequests: snapshot.stats.peakInFlightRequests,
      queueDepth: snapshot.queueDepth,
      inFlightRequests: snapshot.inFlightRequests,
      queueP95Ms: snapshot.timing.queueWaitMs.p95,
      providerP95Ms: snapshot.timing.providerMs.p95,
      totalP95Ms: snapshot.timing.totalMs.p95,
    };
    return {
      id: definition.id,
      name: definition.name,
      note: definition.note,
      expected: definition.expected,
      actual: actual,
      pass: same(actual, definition.expected),
      events: events,
    };
  }

  async function runGoalChange(definition) {
    var firstCall = deferred();
    var requests = [];
    var signals = [];
    var applied = [];
    var events = [];
    var scheduler = root.FocusFeedWorkflowScheduler.create({
      autoDispatch: false,
      initialContextId: "profile-v1",
      provider: function (request, context) {
        requests.push(request);
        signals.push(context.signal);
        if (requests.length === 1) return firstCall.promise;
        return Promise.resolve({ assessments: [{ videoId: "shared-video", goalRelevance: "directly_useful" }] });
      },
      onResult: function (result) { applied.push(result); },
      onEvent: function (event) { events.push(event); },
    });

    scheduler.enqueue(candidate("shared-video", "card-old", 100, "profile-v1"));
    scheduler.flush();
    await settle();
    scheduler.setContext("profile-v2");
    var oldRequestAborted = signals[0].aborted;
    firstCall.resolve({ assessments: [{ videoId: "shared-video", goalRelevance: "unrelated" }] });
    await settle();

    scheduler.enqueue(candidate("shared-video", "card-current", 100, "profile-v2"));
    scheduler.flush();
    await settle();
    var snapshot = scheduler.snapshot();
    var actual = {
      oldRequestAborted: oldRequestAborted,
      staleResultsIgnored: snapshot.stats.staleResultsIgnored,
      oldContextApplications: applied.filter(function (item) { return item.contextId === "profile-v1"; }).length,
      currentContextApplications: applied.filter(function (item) { return item.contextId === "profile-v2"; }).length,
      canceledSubscribers: snapshot.stats.canceledSubscribers,
      providerRequests: snapshot.stats.providerRequests,
      providerVideos: snapshot.stats.providerVideos,
      queueDepth: snapshot.queueDepth,
      inFlightRequests: snapshot.inFlightRequests,
    };
    return {
      id: definition.id,
      name: definition.name,
      note: definition.note,
      expected: definition.expected,
      actual: actual,
      pass: same(actual, definition.expected),
      events: events,
    };
  }

  async function runPauseResume(definition) {
    var firstCall = deferred();
    var requests = [];
    var signals = [];
    var events = [];
    var applied = [];
    var scheduler = root.FocusFeedWorkflowScheduler.create({
      autoDispatch: false,
      initialContextId: "profile-v1",
      batchSize: 2,
      queueCap: 24,
      maxInFlight: 1,
      provider: function (request, context) {
        requests.push(request);
        signals.push(context.signal);
        if (requests.length === 1) return firstCall.promise;
        return Promise.resolve({
          assessments: request.videos.map(function (video) {
            return { videoId: video.videoId, goalRelevance: "supporting" };
          }),
        });
      },
      onResult: function (result) { applied.push(result); },
      onEvent: function (event) { events.push(event); },
    });
    ["pause-a", "pause-b", "pause-c"].forEach(function (videoId) {
      scheduler.enqueue(candidate(videoId, "card-" + videoId, 100, "profile-v1"));
    });
    scheduler.flush();
    await settle();
    scheduler.pause();
    var pausedSnapshot = scheduler.snapshot();
    var pausedRequestAborted = signals[0].aborted;
    var providerRequestsWhilePaused = requests.length;
    firstCall.resolve({
      assessments: requests[0].videos.map(function (video) { return { videoId: video.videoId }; }),
    });
    await settle();

    scheduler.resume();
    scheduler.flush();
    await settle();
    scheduler.flush();
    await settle();
    var snapshot = scheduler.snapshot();
    var actual = {
      pausedRequestAborted: pausedRequestAborted,
      queueDepthWhilePaused: pausedSnapshot.queueDepth,
      providerRequestsWhilePaused: providerRequestsWhilePaused,
      pauseCount: snapshot.stats.pauseCount,
      resumeCount: snapshot.stats.resumeCount,
      staleResultsIgnored: snapshot.stats.staleResultsIgnored,
      providerRequests: snapshot.stats.providerRequests,
      providerVideos: snapshot.stats.providerVideos,
      completedItems: snapshot.stats.completedItems,
      resultsApplied: snapshot.stats.resultsApplied,
      queueDepth: snapshot.queueDepth,
      inFlightRequests: snapshot.inFlightRequests,
    };
    return {
      id: definition.id,
      name: definition.name,
      note: definition.note,
      expected: definition.expected,
      actual: actual,
      pass: same(actual, definition.expected),
      events: events,
    };
  }

  async function runFailureModes(definition) {
    var slowCall = deferred();
    var providerCalls = 0;
    var timers = [];
    var failures = [];
    var applied = [];
    var events = [];
    var scheduler = root.FocusFeedWorkflowScheduler.create({
      autoDispatch: false,
      initialContextId: "profile-v1",
      batchSize: 1,
      timeoutMs: 5000,
      setTimer: function (callback, delay) {
        var timer = { callback: callback, delay: delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: function (timer) { timer.cleared = true; },
      provider: function () {
        providerCalls += 1;
        if (providerCalls === 1) return slowCall.promise;
        if (providerCalls === 2) return Promise.reject(new Error("Synthetic provider failure"));
        return Promise.resolve({ assessments: [] });
      },
      onResult: function (result) { applied.push(result); },
      onFailure: function (failure) { failures.push(failure); },
      onEvent: function (event) { events.push(event); },
    });
    ["slow", "failed", "missing"].forEach(function (videoId) {
      scheduler.enqueue(candidate(videoId, "card-" + videoId, 100, "profile-v1"));
    });

    scheduler.flush();
    await settle();
    timers.find(function (timer) { return !timer.cleared; }).callback();
    scheduler.flush();
    await settle();
    scheduler.flush();
    await settle();

    var snapshot = scheduler.snapshot();
    var failureCodes = failures.map(function (failure) { return failure.code; }).sort();
    var actual = {
      failureCodes: failureCodes,
      providerRequests: snapshot.stats.providerRequests,
      providerVideos: snapshot.stats.providerVideos,
      failedItems: snapshot.stats.failedItems,
      timedOutItems: snapshot.stats.timedOutItems,
      validationFailedItems: snapshot.stats.validationFailedItems,
      completedItems: snapshot.stats.completedItems,
      resultsApplied: snapshot.stats.resultsApplied,
      retries: Math.max(0, snapshot.stats.providerRequests - 3),
      visibleFallbacks: failures.length,
      queueDepth: snapshot.queueDepth,
      inFlightRequests: snapshot.inFlightRequests,
    };
    return {
      id: definition.id,
      name: definition.name,
      note: definition.note,
      expected: definition.expected,
      actual: actual,
      pass: same(actual, definition.expected),
      events: events,
    };
  }

  function runScenario(id) {
    var definition = SCENARIOS.find(function (scenario) { return scenario.id === id; });
    if (!definition) return Promise.reject(new Error("Unknown lifecycle scenario: " + id));
    if (id === "burst-backpressure") return runBurstBackpressure(definition);
    if (id === "dedupe-and-scroll-away") return runDedupeAndScroll(definition);
    if (id === "goal-change-stale-result") return runGoalChange(definition);
    if (id === "pause-resume") return runPauseResume(definition);
    if (id === "timeout-error-validation") return runFailureModes(definition);
    return Promise.reject(new Error("Lifecycle scenario is not implemented: " + id));
  }

  async function runAll() {
    var records = [];
    var index;
    for (index = 0; index < SCENARIOS.length; index += 1) {
      records.push(await runScenario(SCENARIOS[index].id));
    }
    return {
      schemaVersion: "focusfeed-lifecycle-report-v1",
      fixtureVersion: VERSION,
      schedulerVersion: root.FocusFeedWorkflowScheduler.SCHEDULER_VERSION,
      simulation: {
        virtualProvider: true,
        queueCap: 24,
        batchSize: 4,
        maxInFlight: 1,
        timeoutMs: 5000,
      },
      summary: {
        scenarios: records.length,
        passed: records.filter(function (record) { return record.pass; }).length,
        failed: records.filter(function (record) { return !record.pass; }).length,
        maxQueueDepth: Math.max.apply(null, records.map(function (record) {
          return record.actual.peakQueueDepth || record.actual.queueDepthWhilePaused || 0;
        })),
        maxInFlightRequests: Math.max.apply(null, records.map(function (record) {
          return record.actual.peakInFlightRequests || 0;
        })),
        duplicateProviderVideos: records.reduce(function (total, record) {
          return total + (record.actual.duplicateProviderVideos || 0);
        }, 0),
        staleApplications: records.reduce(function (total, record) {
          return total + (record.actual.obsoleteApplications || 0) + (record.actual.oldContextApplications || 0);
        }, 0),
        unresolvedFailures: records.reduce(function (total, record) {
          return total + (record.actual.visibleFallbacks || 0);
        }, 0),
      },
      records: records,
    };
  }

  root.FocusFeedLifecycleFixtures = {
    version: VERSION,
    scenarios: SCENARIOS,
    runScenario: runScenario,
    runAll: runAll,
  };
})(globalThis);
