"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedWorkflowScheduler;
require("../workflow-scheduler.js");

const schedulerModule = global.FocusFeedWorkflowScheduler;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

async function deduplicatesSharedWork() {
  const providerCall = deferred();
  const requests = [];
  const applied = [];
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    provider(request) {
      requests.push(request);
      return providerCall.promise;
    },
    onResult(result) {
      applied.push(result);
    },
  });

  scheduler.enqueue({
    key: "profile-1:video-1",
    videoId: "video-1",
    subscriberId: "card-a",
    contextId: "profile-1",
    payload: { videoId: "video-1", title: "Graph traversal" },
    priority: 100,
  });
  scheduler.enqueue({
    key: "profile-1:video-1",
    videoId: "video-1",
    subscriberId: "card-b",
    contextId: "profile-1",
    payload: { videoId: "video-1", title: "Graph traversal" },
    priority: 100,
  });

  scheduler.flush();
  await settle();
  assert.equal(requests.length, 1, "duplicates must share one provider request");
  assert.equal(requests[0].videos.length, 1, "the provider batch must contain one unique video");

  providerCall.resolve({ assessments: [{ videoId: "video-1", goalRelevance: "directly_useful" }] });
  await settle();

  assert.deepEqual(applied.map((item) => item.subscriberId).sort(), ["card-a", "card-b"]);
  assert.equal(scheduler.snapshot().stats.duplicateJoins, 1);
  assert.equal(scheduler.snapshot().stats.providerVideos, 1);
}

async function boundsWaitingWorkByPriority() {
  const events = [];
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    queueCap: 2,
    provider() {
      return Promise.resolve({ assessments: [] });
    },
    onEvent(event) {
      events.push(event);
    },
  });

  function candidate(id, priority) {
    return {
      key: `profile-1:${id}`,
      videoId: id,
      subscriberId: `card-${id}`,
      contextId: "profile-1",
      payload: { videoId: id, title: id },
      priority,
    };
  }

  assert.equal(scheduler.enqueue(candidate("far-a", 10)).status, "queued");
  assert.equal(scheduler.enqueue(candidate("near", 30)).status, "queued");
  assert.equal(scheduler.enqueue(candidate("visible", 100)).status, "queued");
  assert.equal(scheduler.enqueue(candidate("far-b", 5)).status, "deferred");

  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.queueDepth, 2, "waiting work must never exceed the configured bound");
  assert.deepEqual(snapshot.queuedKeys, ["profile-1:visible", "profile-1:near"]);
  assert.equal(snapshot.stats.priorityEvictions, 1);
  assert.equal(snapshot.stats.overloadDeferred, 2, "both an evicted item and a rejected item remain visibly deferred");
  assert.deepEqual(
    events.filter((event) => event.type === "deferred").map((event) => event.reason).sort(),
    ["priority_eviction", "queue_full"]
  );
}

async function ignoresLateResultsAfterContextChange() {
  const providerCall = deferred();
  const applied = [];
  const events = [];
  let providerContext;
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    provider(request, context) {
      providerContext = context;
      return providerCall.promise;
    },
    onResult(result) {
      applied.push(result);
    },
    onEvent(event) {
      events.push(event);
    },
  });

  scheduler.enqueue({
    key: "profile-1:video-1",
    videoId: "video-1",
    subscriberId: "card-a",
    contextId: "profile-1",
    payload: { videoId: "video-1", title: "Old goal result" },
    priority: 100,
  });
  scheduler.flush();
  await settle();
  assert.equal(providerContext.signal.aborted, false);

  scheduler.setContext("profile-2");
  assert.equal(providerContext.signal.aborted, true, "changing goal context should abort obsolete provider work");
  providerCall.resolve({ assessments: [{ videoId: "video-1", goalRelevance: "unrelated" }] });
  await settle();

  assert.deepEqual(applied, [], "an old-goal result must never reach a current card");
  assert.equal(scheduler.snapshot().stats.staleResultsIgnored, 1);
  assert.ok(events.some((event) => event.type === "context_changed"));
  assert.ok(events.some((event) => event.type === "stale_result_ignored"));
}

async function cancelsOnlyObsoleteSubscribers() {
  const providerCall = deferred();
  const applied = [];
  let signal;
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    provider(request, context) {
      signal = context.signal;
      return providerCall.promise;
    },
    onResult(result) {
      applied.push(result.subscriberId);
    },
  });
  const base = {
    key: "profile-1:shared",
    videoId: "shared",
    contextId: "profile-1",
    payload: { videoId: "shared", title: "Shared video" },
    priority: 100,
  };
  scheduler.enqueue(Object.assign({}, base, { subscriberId: "card-a" }));
  scheduler.enqueue(Object.assign({}, base, { subscriberId: "card-b" }));
  scheduler.flush();
  await settle();

  assert.equal(scheduler.removeSubscriber("card-a", "left_viewport"), 1);
  assert.equal(signal.aborted, false, "shared work must continue while another current card needs it");
  providerCall.resolve({ assessments: [{ videoId: "shared", goalRelevance: "supporting" }] });
  await settle();
  assert.deepEqual(applied, ["card-b"]);

  const queued = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    provider() {
      throw new Error("removed queued work must not reach the provider");
    },
  });
  queued.enqueue(Object.assign({}, base, {
    key: "profile-1:queued",
    videoId: "queued",
    subscriberId: "card-c",
    payload: { videoId: "queued", title: "Queued video" },
  }));
  assert.equal(queued.removeSubscriber("card-c", "left_viewport"), 1);
  assert.equal(queued.snapshot().queueDepth, 0);
  assert.equal(queued.flush(), false);
}

async function timesOutWithoutRetrying() {
  const providerCall = deferred();
  const failures = [];
  let timer;
  let providerSignal;
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    timeoutMs: 5000,
    setTimer(callback, delay) {
      timer = { callback, delay, cleared: false };
      return timer;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
    provider(request, context) {
      providerSignal = context.signal;
      return providerCall.promise;
    },
    onFailure(failure) {
      failures.push(failure);
    },
  });

  scheduler.enqueue({
    key: "profile-1:slow",
    videoId: "slow",
    subscriberId: "card-slow",
    contextId: "profile-1",
    payload: { videoId: "slow", title: "Slow result" },
    priority: 100,
  });
  scheduler.flush();
  await settle();
  assert.equal(timer.delay, 5000);

  timer.callback();
  assert.equal(providerSignal.aborted, true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "timeout");
  assert.equal(scheduler.snapshot().stats.timedOutItems, 1);
  assert.equal(scheduler.snapshot().stats.providerRequests, 1, "a timeout must not retry itself");
  assert.equal(scheduler.snapshot().inFlightRequests, 0);

  providerCall.resolve({ assessments: [{ videoId: "slow", goalRelevance: "directly_useful" }] });
  await settle();
  assert.equal(scheduler.snapshot().stats.staleResultsIgnored, 1, "a late timeout result must stay ignored");
}

async function rejectsIncompleteOrAmbiguousProviderOutput() {
  const failures = [];
  const applied = [];
  const events = [];
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    provider() {
      return Promise.resolve({
        assessments: [
          { videoId: "video-a", goalRelevance: "directly_useful" },
          { videoId: "video-a", goalRelevance: "unrelated" },
          { videoId: "not-requested", goalRelevance: "supporting" },
        ],
      });
    },
    onResult(result) {
      applied.push(result);
    },
    onFailure(failure) {
      failures.push(failure);
    },
    onEvent(event) {
      events.push(event);
    },
  });
  ["video-a", "video-b"].forEach((videoId) => {
    scheduler.enqueue({
      key: `profile-1:${videoId}`,
      videoId,
      subscriberId: `card-${videoId}`,
      contextId: "profile-1",
      payload: { videoId, title: videoId },
      priority: 100,
    });
  });
  scheduler.flush();
  await settle();
  await settle();

  assert.deepEqual(applied, []);
  assert.deepEqual(failures.map((item) => item.code).sort(), ["duplicate_assessment", "missing_assessment"]);
  assert.equal(scheduler.snapshot().stats.validationFailedItems, 2);
  assert.equal(scheduler.snapshot().stats.unexpectedAssessments, 1);
  assert.ok(events.some((event) => event.type === "response_item_rejected" && event.videoId === "not-requested"));
}

async function pausesAndRequeuesCurrentWork() {
  const firstCall = deferred();
  const requests = [];
  const signals = [];
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    batchSize: 2,
    queueCap: 4,
    provider(request, context) {
      requests.push(request);
      signals.push(context.signal);
      if (requests.length === 1) return firstCall.promise;
      return Promise.resolve({
        assessments: request.videos.map((video) => ({ videoId: video.videoId, goalRelevance: "supporting" })),
      });
    },
  });
  ["a", "b", "c"].forEach((videoId) => {
    scheduler.enqueue({
      key: `profile-1:${videoId}`,
      videoId,
      subscriberId: `card-${videoId}`,
      contextId: "profile-1",
      payload: { videoId, title: videoId },
      priority: 100,
    });
  });
  scheduler.flush();
  await settle();
  assert.equal(scheduler.snapshot().queueDepth, 1);

  scheduler.pause();
  assert.equal(signals[0].aborted, true);
  assert.equal(scheduler.snapshot().paused, true);
  assert.equal(scheduler.snapshot().queueDepth, 3, "paused in-flight work should remain available to resume");
  assert.equal(scheduler.snapshot().inFlightRequests, 0);
  assert.equal(scheduler.flush(), false, "paused work must not reach the provider");

  firstCall.resolve({ assessments: requests[0].videos.map((video) => ({ videoId: video.videoId })) });
  await settle();
  assert.equal(scheduler.snapshot().stats.staleResultsIgnored, 1);

  scheduler.resume();
  scheduler.flush();
  await settle();
  scheduler.flush();
  await settle();
  assert.equal(scheduler.snapshot().queueDepth, 0);
  assert.equal(scheduler.snapshot().stats.completedItems, 3);
}

async function reportsQueueProviderAndTotalTiming() {
  let now = 1000;
  const providerCall = deferred();
  const applied = [];
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    now() {
      return now;
    },
    provider() {
      return providerCall.promise;
    },
    onResult(result) {
      applied.push(result);
    },
  });
  scheduler.enqueue({
    key: "profile-1:timed",
    videoId: "timed",
    subscriberId: "card-timed",
    contextId: "profile-1",
    payload: { videoId: "timed", title: "Timed" },
    priority: 100,
  });
  now = 1010;
  scheduler.flush();
  await settle();
  now = 1060;
  providerCall.resolve({ assessments: [{ videoId: "timed", goalRelevance: "directly_useful" }] });
  await settle();

  assert.deepEqual(applied[0].timing, {
    queuedAtMs: 1000,
    providerStartedAtMs: 1010,
    providerEndedAtMs: 1060,
    queueWaitMs: 10,
    providerMs: 50,
    totalMs: 60,
  });
  assert.equal(scheduler.snapshot().timing.queueWaitMs.p95, 10);
  assert.equal(scheduler.snapshot().timing.providerMs.p95, 50);
  assert.equal(scheduler.snapshot().timing.totalMs.p95, 60);
}

async function promotesWorkWhenAVisibleSubscriberJoins() {
  const requests = [];
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    batchSize: 1,
    provider(request) {
      requests.push(request);
      return Promise.resolve({ assessments: [{ videoId: request.videos[0].videoId }] });
    },
  });
  function queued(videoId, subscriberId, priority) {
    return {
      key: `profile-1:${videoId}`,
      videoId,
      subscriberId,
      contextId: "profile-1",
      payload: { videoId, title: videoId },
      priority,
    };
  }
  scheduler.enqueue(queued("far", "card-far", 5));
  scheduler.enqueue(queued("near", "card-near", 50));
  scheduler.enqueue(queued("far", "card-far-visible", 100));

  assert.deepEqual(scheduler.snapshot().queuedKeys, ["profile-1:far", "profile-1:near"]);
  scheduler.flush();
  await settle();
  assert.equal(requests[0].videos[0].videoId, "far");
  assert.equal(scheduler.snapshot().stats.priorityPromotions, 1);
}

async function rejectsMismatchedRequestPayloads() {
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    provider() {
      return Promise.resolve({ assessments: [] });
    },
  });
  assert.throws(() => scheduler.enqueue({
    key: "profile-1:video-a",
    videoId: "video-a",
    subscriberId: "card-a",
    contextId: "profile-1",
    payload: { videoId: "video-b", title: "Wrong ID" },
  }), /payload videoId/i);
  assert.equal(scheduler.snapshot().stats.appearances, 0);
}

async function batchesAfterTheWindowAndRespectsConcurrency() {
  const firstCall = deferred();
  const requests = [];
  const timers = [];
  const scheduler = schedulerModule.create({
    initialContextId: "profile-1",
    batchWindowMs: 25,
    batchSize: 2,
    maxInFlight: 1,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    provider(request) {
      requests.push(request);
      if (requests.length === 1) return firstCall.promise;
      return Promise.resolve({ assessments: request.videos.map((video) => ({ videoId: video.videoId })) });
    },
  });
  ["a", "b", "c"].forEach((videoId) => {
    scheduler.enqueue({
      key: `profile-1:${videoId}`,
      videoId,
      subscriberId: `card-${videoId}`,
      contextId: "profile-1",
      payload: { videoId, title: videoId },
      priority: 100,
    });
  });
  assert.equal(timers.filter((timer) => timer.delay === 25 && !timer.cleared).length, 1);
  timers.find((timer) => timer.delay === 25 && !timer.cleared).callback();
  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].videos.map((video) => video.videoId), ["a", "b"]);
  assert.equal(scheduler.flush(), false, "manual flush must not exceed the in-flight bound");

  firstCall.resolve({ assessments: requests[0].videos.map((video) => ({ videoId: video.videoId })) });
  await settle();
  const continuation = timers.find((timer) => timer.delay === 0 && !timer.cleared);
  assert.ok(continuation, "completion should schedule remaining work without another batching delay");
  continuation.callback();
  await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].videos.map((video) => video.videoId), ["c"]);
  assert.equal(scheduler.snapshot().stats.peakInFlightRequests, 1);
}

async function stopAbortsAndClearsAllWork() {
  const providerCall = deferred();
  let providerSignal;
  const scheduler = schedulerModule.create({
    autoDispatch: false,
    initialContextId: "profile-1",
    batchSize: 2,
    provider(request, context) {
      providerSignal = context.signal;
      return providerCall.promise;
    },
  });
  ["a", "b", "c"].forEach((videoId) => {
    scheduler.enqueue({
      key: `profile-1:${videoId}`,
      videoId,
      subscriberId: `card-${videoId}`,
      contextId: "profile-1",
      payload: { videoId, title: videoId },
      priority: 100,
    });
  });
  scheduler.flush();
  await settle();
  assert.equal(scheduler.stop("user_stop"), true);
  assert.equal(providerSignal.aborted, true);
  assert.equal(scheduler.snapshot().stopped, true);
  assert.equal(scheduler.snapshot().queueDepth, 0);
  assert.equal(scheduler.snapshot().inFlightRequests, 0);
  assert.equal(scheduler.snapshot().stats.canceledSubscribers, 3);
  assert.equal(scheduler.enqueue({
    key: "profile-1:d",
    videoId: "d",
    subscriberId: "card-d",
    contextId: "profile-1",
    payload: { videoId: "d", title: "d" },
  }).status, "stopped");
  providerCall.resolve({ assessments: [{ videoId: "a" }, { videoId: "b" }] });
  await settle();
  assert.equal(scheduler.snapshot().stats.staleResultsIgnored, 1);
}

deduplicatesSharedWork()
  .then(boundsWaitingWorkByPriority)
  .then(ignoresLateResultsAfterContextChange)
  .then(cancelsOnlyObsoleteSubscribers)
  .then(timesOutWithoutRetrying)
  .then(rejectsIncompleteOrAmbiguousProviderOutput)
  .then(pausesAndRequeuesCurrentWork)
  .then(reportsQueueProviderAndTotalTiming)
  .then(promotesWorkWhenAVisibleSubscriberJoins)
  .then(rejectsMismatchedRequestPayloads)
  .then(batchesAfterTheWindowAndRespectsConcurrency)
  .then(stopAbortsAndClearsAllWork)
  .then(() => {
  console.log("workflow scheduler tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
