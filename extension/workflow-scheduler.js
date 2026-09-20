// FocusFeed workflow scheduler — bounded, deduplicated semantic work.

(function (root) {
  "use strict";

  var SCHEDULER_VERSION = "scheduler-v1";

  function create(options) {
    options = options || {};
    if (typeof options.provider !== "function") {
      throw new Error("A scheduler provider function is required.");
    }

    var provider = options.provider;
    var onResult = typeof options.onResult === "function" ? options.onResult : function () {};
    var onEvent = typeof options.onEvent === "function" ? options.onEvent : function () {};
    var onFailure = typeof options.onFailure === "function" ? options.onFailure : function () {};
    var validateAssessment = typeof options.validateAssessment === "function"
      ? options.validateAssessment
      : function (assessment, entry) {
        return Boolean(assessment && assessment.videoId === entry.videoId);
      };
    var setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout;
    var clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;
    var now = typeof options.now === "function" ? options.now : Date.now;
    var autoDispatch = options.autoDispatch !== false;
    var batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0 ? options.batchSize : 4;
    var queueCap = Number.isInteger(options.queueCap) && options.queueCap > 0 ? options.queueCap : 24;
    var maxInFlight = Number.isInteger(options.maxInFlight) && options.maxInFlight > 0 ? options.maxInFlight : 1;
    var batchWindowMs = Number.isFinite(options.batchWindowMs) && options.batchWindowMs >= 0 ? options.batchWindowMs : 100;
    var timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
    var sequence = 0;
    var requestSequence = 0;
    var currentContextId = options.initialContextId || null;
    var queue = [];
    var entries = new Map();
    var inFlight = new Map();
    var paused = false;
    var stopped = false;
    var dispatchTimer = null;
    var timingSamples = {
      queueWaitMs: [],
      providerMs: [],
      totalMs: [],
    };
    var stats = {
      appearances: 0,
      uniqueAdmitted: 0,
      duplicateJoins: 0,
      priorityPromotions: 0,
      overloadDeferred: 0,
      priorityEvictions: 0,
      providerRequests: 0,
      providerVideos: 0,
      resultsApplied: 0,
      completedItems: 0,
      failedItems: 0,
      failedSubscribers: 0,
      timedOutItems: 0,
      validationFailedItems: 0,
      unexpectedAssessments: 0,
      staleAdmissions: 0,
      staleResultsIgnored: 0,
      canceledSubscribers: 0,
      pauseCount: 0,
      resumeCount: 0,
      peakQueueDepth: 0,
      peakInFlightRequests: 0,
    };

    function emit(type, detail) {
      onEvent(Object.assign({ type: type, atMs: now() }, detail || {}));
    }

    function sortedQueue() {
      return queue.slice().sort(function (left, right) {
        return right.priority - left.priority || left.sequence - right.sequence;
      });
    }

    function updatePeaks() {
      stats.peakQueueDepth = Math.max(stats.peakQueueDepth, queue.length);
      stats.peakInFlightRequests = Math.max(stats.peakInFlightRequests, inFlight.size);
    }

    function scheduleDispatch(delay) {
      if (!autoDispatch || paused || stopped || !queue.length || inFlight.size >= maxInFlight || dispatchTimer) return;
      dispatchTimer = setTimer(function () {
        dispatchTimer = null;
        flush();
      }, Number.isFinite(delay) ? delay : batchWindowMs);
    }

    function defer(entry, reason) {
      stats.overloadDeferred += 1;
      emit("deferred", {
        key: entry.key,
        videoId: entry.videoId,
        reason: reason,
      });
    }

    function enqueue(candidate) {
      if (!candidate || !candidate.key || !candidate.videoId || !candidate.subscriberId) {
        throw new Error("Scheduled work requires key, videoId, and subscriberId.");
      }
      if (!candidate.payload || candidate.payload.videoId !== candidate.videoId) {
        throw new Error("Scheduled work payload videoId must exactly match videoId.");
      }
      if (stopped) return { status: "stopped", key: candidate.key, reason: "scheduler_stopped" };
      stats.appearances += 1;
      var candidateContextId = candidate.contextId || currentContextId || "default";
      if (currentContextId === null) currentContextId = candidateContextId;
      if (candidateContextId !== currentContextId) {
        stats.staleAdmissions += 1;
        emit("deferred", {
          key: candidate.key,
          videoId: candidate.videoId,
          reason: "stale_context",
        });
        return { status: "deferred", key: candidate.key, reason: "stale_context" };
      }
      var existing = entries.get(candidate.key);
      if (existing) {
        var candidatePriority = Number(candidate.priority) || 0;
        if (candidatePriority > existing.priority) {
          existing.priority = candidatePriority;
          stats.priorityPromotions += 1;
          emit("priority_updated", {
            key: existing.key,
            videoId: existing.videoId,
            priority: existing.priority,
          });
        }
        if (!existing.subscribers.has(candidate.subscriberId)) {
          existing.subscribers.set(candidate.subscriberId, {
            subscriberId: candidate.subscriberId,
            contextId: candidateContextId,
          });
          stats.duplicateJoins += 1;
          emit("deduplicated", {
            key: existing.key,
            videoId: existing.videoId,
            subscriberId: candidate.subscriberId,
          });
        }
        return { status: "deduplicated", key: candidate.key };
      }

      var entry = {
        key: candidate.key,
        videoId: candidate.videoId,
        contextId: candidateContextId,
        payload: candidate.payload,
        priority: Number(candidate.priority) || 0,
        sequence: sequence += 1,
        enqueuedAtMs: now(),
        subscribers: new Map(),
      };
      entry.subscribers.set(candidate.subscriberId, {
        subscriberId: candidate.subscriberId,
        contextId: entry.contextId,
      });

      if (queue.length >= queueCap) {
        var lowest = queue.slice().sort(function (left, right) {
          return left.priority - right.priority || right.sequence - left.sequence;
        })[0];
        if (entry.priority <= lowest.priority) {
          defer(entry, "queue_full");
          return { status: "deferred", key: entry.key, reason: "queue_full" };
        }
        queue.splice(queue.indexOf(lowest), 1);
        entries.delete(lowest.key);
        stats.priorityEvictions += 1;
        defer(lowest, "priority_eviction");
      }

      entries.set(entry.key, entry);
      queue.push(entry);
      stats.uniqueAdmitted += 1;
      updatePeaks();
      emit("queued", {
        key: entry.key,
        videoId: entry.videoId,
        subscriberId: candidate.subscriberId,
        priority: entry.priority,
        queueDepth: queue.length,
      });
      scheduleDispatch(batchWindowMs);
      return { status: "queued", key: candidate.key };
    }

    function flush() {
      if (paused || stopped || !queue.length || inFlight.size >= maxInFlight) return false;
      if (dispatchTimer) {
        clearTimer(dispatchTimer);
        dispatchTimer = null;
      }
      queue = sortedQueue();
      var batchEntries = queue.splice(0, batchSize);
      var requestId = "scheduler-" + (requestSequence += 1);
      var request = {
        requestId: requestId,
        contextId: batchEntries[0].contextId,
        videos: batchEntries.map(function (entry) { return entry.payload; }),
      };
      var controller = typeof AbortController === "function"
        ? new AbortController()
        : { signal: { aborted: false }, abort: function () { this.signal.aborted = true; } };
      var batch = {
        requestId: requestId,
        contextId: request.contextId,
        entries: batchEntries,
        controller: controller,
        active: true,
        staleReported: false,
        startedAtMs: now(),
      };
      batchEntries.forEach(function (entry) {
        entry.state = "in_flight";
        entry.requestId = requestId;
      });
      inFlight.set(requestId, batch);
      updatePeaks();
      stats.providerRequests += 1;
      stats.providerVideos += batchEntries.length;
      emit("batch_started", {
        requestId: requestId,
        contextId: request.contextId,
        videoIds: batchEntries.map(function (entry) { return entry.videoId; }),
        batchSize: batchEntries.length,
        queueDepth: queue.length,
        inFlightRequests: inFlight.size,
      });
      batch.timeoutHandle = setTimer(function () {
        if (!batch.active) return;
        batch.controller.abort();
        failBatch(batch, "timeout", "Provider request exceeded its time budget.");
      }, timeoutMs);

      Promise.resolve().then(function () {
        return provider(request, { requestId: requestId, signal: controller.signal });
      }).then(function (response) {
        if (!batch.active) {
          if (!batch.staleReported) {
            batch.staleReported = true;
            stats.staleResultsIgnored += 1;
            emit("stale_result_ignored", { requestId: requestId, reason: batch.staleReason || "canceled" });
          }
          return;
        }
        clearTimer(batch.timeoutHandle);
        batch.active = false;
        inFlight.delete(requestId);
        var providerEndedAtMs = now();
        var assessments = response && Array.isArray(response.assessments) ? response.assessments : [];
        var requestedIds = new Set(batchEntries.map(function (entry) { return entry.videoId; }));
        var grouped = new Map();
        assessments.forEach(function (assessment) {
          var videoId = assessment && assessment.videoId;
          if (!requestedIds.has(videoId)) {
            stats.unexpectedAssessments += 1;
            emit("response_item_rejected", {
              requestId: requestId,
              videoId: videoId || null,
              reason: "unexpected_assessment",
            });
            return;
          }
          if (!grouped.has(videoId)) grouped.set(videoId, []);
          grouped.get(videoId).push(assessment);
        });
        batchEntries.forEach(function (entry) {
          var matches = grouped.get(entry.videoId) || [];
          if (!matches.length) {
            failEntry(entry, batch, "missing_assessment", "The provider omitted this requested video.", true);
            return;
          }
          if (matches.length > 1) {
            failEntry(entry, batch, "duplicate_assessment", "The provider returned this video more than once.", true);
            return;
          }
          var assessment = matches[0];
          var valid = false;
          try {
            valid = validateAssessment(assessment, entry) !== false;
          } catch (error) {
            valid = false;
          }
          if (!valid) {
            failEntry(entry, batch, "invalid_assessment", "The provider assessment failed validation.", true);
            return;
          }
          stats.completedItems += 1;
          var timing = {
            queuedAtMs: entry.enqueuedAtMs,
            providerStartedAtMs: batch.startedAtMs,
            providerEndedAtMs: providerEndedAtMs,
            queueWaitMs: Math.max(0, batch.startedAtMs - entry.enqueuedAtMs),
            providerMs: Math.max(0, providerEndedAtMs - batch.startedAtMs),
            totalMs: Math.max(0, providerEndedAtMs - entry.enqueuedAtMs),
          };
          timingSamples.queueWaitMs.push(timing.queueWaitMs);
          timingSamples.providerMs.push(timing.providerMs);
          timingSamples.totalMs.push(timing.totalMs);
          entry.subscribers.forEach(function (subscriber) {
            stats.resultsApplied += 1;
            onResult({
              requestId: requestId,
              key: entry.key,
              videoId: entry.videoId,
              subscriberId: subscriber.subscriberId,
              contextId: subscriber.contextId,
              assessment: assessment,
              timing: timing,
            });
          });
          emit("result_applied", {
            requestId: requestId,
            key: entry.key,
            videoId: entry.videoId,
            subscriberCount: entry.subscribers.size,
            queueWaitMs: timing.queueWaitMs,
            providerMs: timing.providerMs,
            totalMs: timing.totalMs,
          });
          entries.delete(entry.key);
        });
        emit("batch_completed", {
          requestId: requestId,
          batchSize: batchEntries.length,
          providerMs: Math.max(0, providerEndedAtMs - batch.startedAtMs),
        });
      }, function (error) {
        if (!batch.active) {
          if (!batch.staleReported && (!error || error.name !== "AbortError")) {
            batch.staleReported = true;
            stats.staleResultsIgnored += 1;
            emit("stale_result_ignored", { requestId: requestId, reason: batch.staleReason || "canceled" });
          }
          return;
        }
        failBatch(batch, "provider_error", error && error.message ? error.message : "Provider request failed.");
      }).finally(function () {
        if (batch.active) {
          batch.active = false;
          inFlight.delete(requestId);
        }
        scheduleDispatch(0);
      });
      return true;
    }

    function failEntry(entry, batch, code, message, isValidationFailure) {
      entries.delete(entry.key);
      if (!entry.subscribers.size) return;
      stats.failedItems += 1;
      stats.failedSubscribers += entry.subscribers.size;
      if (isValidationFailure) stats.validationFailedItems += 1;
      entry.subscribers.forEach(function (subscriber) {
        onFailure({
          requestId: batch.requestId,
          key: entry.key,
          videoId: entry.videoId,
          subscriberId: subscriber.subscriberId,
          contextId: subscriber.contextId,
          code: code,
          message: message,
        });
      });
      emit("item_failed", {
        requestId: batch.requestId,
        key: entry.key,
        videoId: entry.videoId,
        code: code,
      });
    }

    function failBatch(batch, code, message) {
      if (!batch.active) return false;
      batch.active = false;
      batch.staleReason = code;
      clearTimer(batch.timeoutHandle);
      inFlight.delete(batch.requestId);
      batch.entries.forEach(function (entry) {
        if (code === "timeout") stats.timedOutItems += 1;
        failEntry(entry, batch, code, message, false);
      });
      emit("provider_failed", {
        requestId: batch.requestId,
        code: code,
        reason: message,
      });
      scheduleDispatch(0);
      return true;
    }

    function cancelEntry(entry, reason) {
      stats.canceledSubscribers += entry.subscribers.size;
      entry.subscribers.forEach(function (subscriber) {
        emit("subscriber_canceled", {
          key: entry.key,
          videoId: entry.videoId,
          subscriberId: subscriber.subscriberId,
          reason: reason,
        });
      });
      entries.delete(entry.key);
    }

    function removeSubscriber(subscriberId, reason) {
      var removed = 0;
      entries.forEach(function (entry) {
        if (!entry.subscribers.has(subscriberId)) return;
        entry.subscribers.delete(subscriberId);
        removed += 1;
        stats.canceledSubscribers += 1;
        emit("subscriber_canceled", {
          key: entry.key,
          videoId: entry.videoId,
          subscriberId: subscriberId,
          reason: reason || "no_longer_relevant",
        });
        if (entry.subscribers.size) return;
        entries.delete(entry.key);
        if (entry.state !== "in_flight") {
          var queueIndex = queue.indexOf(entry);
          if (queueIndex >= 0) queue.splice(queueIndex, 1);
          return;
        }
        var batch = inFlight.get(entry.requestId);
        if (!batch) return;
        var hasSubscribers = batch.entries.some(function (batchEntry) {
          return batchEntry.subscribers.size > 0;
        });
        if (!hasSubscribers) {
          batch.active = false;
          batch.staleReason = "no_subscribers";
          clearTimer(batch.timeoutHandle);
          batch.controller.abort();
          inFlight.delete(batch.requestId);
          emit("batch_aborted", { requestId: batch.requestId, reason: "no_subscribers" });
          scheduleDispatch(0);
        }
      });
      return removed;
    }

    function setContext(nextContextId) {
      if (!nextContextId) throw new Error("A non-empty contextId is required.");
      if (nextContextId === currentContextId) return false;
      var previousContextId = currentContextId;
      currentContextId = nextContextId;
      if (dispatchTimer) {
        clearTimer(dispatchTimer);
        dispatchTimer = null;
      }
      queue.forEach(function (entry) { cancelEntry(entry, "context_changed"); });
      queue = [];
      inFlight.forEach(function (batch) {
        batch.active = false;
        batch.staleReason = "context_changed";
        clearTimer(batch.timeoutHandle);
        batch.entries.forEach(function (entry) { cancelEntry(entry, "context_changed"); });
        batch.controller.abort();
        emit("batch_aborted", { requestId: batch.requestId, reason: "context_changed" });
      });
      inFlight.clear();
      emit("context_changed", {
        previousContextId: previousContextId,
        contextId: nextContextId,
      });
      return true;
    }

    function trimQueue(reason) {
      queue = sortedQueue();
      var removed = queue.splice(queueCap);
      removed.forEach(function (entry) {
        entries.delete(entry.key);
        defer(entry, reason);
      });
    }

    function pause() {
      if (paused) return false;
      paused = true;
      stats.pauseCount += 1;
      if (dispatchTimer) {
        clearTimer(dispatchTimer);
        dispatchTimer = null;
      }
      inFlight.forEach(function (batch) {
        batch.active = false;
        batch.staleReason = "paused";
        clearTimer(batch.timeoutHandle);
        batch.controller.abort();
        batch.entries.forEach(function (entry) {
          if (!entry.subscribers.size || entry.contextId !== currentContextId) {
            entries.delete(entry.key);
            return;
          }
          entry.state = "queued";
          delete entry.requestId;
          if (queue.indexOf(entry) === -1) queue.push(entry);
        });
        emit("batch_aborted", { requestId: batch.requestId, reason: "paused" });
      });
      inFlight.clear();
      trimQueue("pause_queue_full");
      updatePeaks();
      emit("paused", { queueDepth: queue.length });
      return true;
    }

    function resume() {
      if (!paused || stopped) return false;
      paused = false;
      stats.resumeCount += 1;
      emit("resumed", { queueDepth: queue.length });
      scheduleDispatch(0);
      return true;
    }

    function stop(reason) {
      if (stopped) return false;
      stopped = true;
      paused = true;
      if (dispatchTimer) {
        clearTimer(dispatchTimer);
        dispatchTimer = null;
      }
      queue.forEach(function (entry) { cancelEntry(entry, reason || "stopped"); });
      queue = [];
      inFlight.forEach(function (batch) {
        batch.active = false;
        batch.staleReason = reason || "stopped";
        clearTimer(batch.timeoutHandle);
        batch.entries.forEach(function (entry) { cancelEntry(entry, reason || "stopped"); });
        batch.controller.abort();
        emit("batch_aborted", { requestId: batch.requestId, reason: reason || "stopped" });
      });
      inFlight.clear();
      emit("stopped", { reason: reason || "stopped" });
      return true;
    }

    function snapshot() {
      function summarize(values) {
        if (!values.length) return { count: 0, p50: null, p95: null, max: null };
        var ordered = values.slice().sort(function (left, right) { return left - right; });
        function percentile(fraction) {
          return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
        }
        return {
          count: ordered.length,
          p50: percentile(0.5),
          p95: percentile(0.95),
          max: ordered[ordered.length - 1],
        };
      }
      return {
        version: SCHEDULER_VERSION,
        contextId: currentContextId,
        paused: paused,
        stopped: stopped,
        queueDepth: queue.length,
        inFlightRequests: inFlight.size,
        queuedKeys: sortedQueue().map(function (entry) { return entry.key; }),
        stats: Object.assign({}, stats),
        timing: {
          queueWaitMs: summarize(timingSamples.queueWaitMs),
          providerMs: summarize(timingSamples.providerMs),
          totalMs: summarize(timingSamples.totalMs),
        },
      };
    }

    return {
      enqueue: enqueue,
      flush: flush,
      removeSubscriber: removeSubscriber,
      setContext: setContext,
      pause: pause,
      resume: resume,
      stop: stop,
      snapshot: snapshot,
    };
  }

  root.FocusFeedWorkflowScheduler = {
    SCHEDULER_VERSION: SCHEDULER_VERSION,
    create: create,
  };
})(globalThis);
