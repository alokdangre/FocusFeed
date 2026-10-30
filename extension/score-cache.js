// Shared raw probabilities. UI mode, DOM nodes, and publisher IDs do not own scores.
(function (root) {
  "use strict";
  function create(dispatch, options) {
    options = options || {};
    var cache = new Map(), flights = new Map(), subscribers = new Map(), ledger = [], jobs = new Map();
    var epoch = 0, serial = 0, saveTimer, storage = options.storage, storageKey = "focusfeedScoresV1", ledgerBytes = 0;
    var metrics = { httpAttempts: 0, httpCompleted: 0, httpFailed: 0, auxiliaryHttpAttempts: 0, localHits: 0, sharedPairs: 0, providerCalls: 0, providerQuestions: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, ledgerDropped: 0 };
    function log(event) {
      var value = Object.assign({ at: Date.now() }, event); ledger.push(value); ledgerBytes += JSON.stringify(value).length * 2;
      while (ledger.length > 200 || ledgerBytes > 1000000) { ledgerBytes -= JSON.stringify(ledger.shift()).length * 2; metrics.ledgerDropped++; }
    }
    function prune() {
      cache.forEach(function (v, k) { if (v.expiresAt <= Date.now()) cache.delete(k); });
      while (cache.size > 800) cache.delete(cache.keys().next().value);
    }
    var ready = storage ? storage.get(storageKey).then(function (data) {
      if (epoch !== 0) return;
      var saved = data[storageKey] || {};
      (Array.isArray(saved) ? saved : saved.scores || []).slice(-800).forEach(function (pair) {
        if (Array.isArray(pair) && typeof pair[0] === "string" && pair[1] && Number.isFinite(pair[1].p) && pair[1].p >= 0 && pair[1].p <= 1 && pair[1].expiresAt > Date.now()) cache.set(pair[0], pair[1]);
      });
      if (saved.metrics) Object.keys(metrics).forEach(function (k) { if (Number.isFinite(saved.metrics[k]) && saved.metrics[k] >= 0) metrics[k] = saved.metrics[k]; });
      if (Array.isArray(saved.ledger)) saved.ledger.slice(-200).forEach(log);
      prune();
    }).catch(function () {}) : Promise.resolve();
    function persist() {
      if (!storage || saveTimer) return;
      saveTimer = setTimeout(function () {
        saveTimer = null; prune(); storage.set({ [storageKey]: { scores: Array.from(cache), metrics: metrics, ledger: ledger } }).catch(function () {});
      }, 50);
    }
    function key(namespace, video, objective, mode) {
      var value = Object.assign({}, video, { description: video.descriptionSnippet });
      return JSON.stringify([namespace, FocusFeedVideo.fingerprint(value), FocusFeedVideo.objectiveKey(objective), video.itemType === "collection" ? mode : "video"]);
    }
    // Each video advances one topic at a time. The shared queue refills freed
    // slots with other videos, including subscribers from other tabs.
    var queue = [], active = false, pumpTimer = null, refillAt = 0, yieldStats = new Map();
    var fillDelay = options.fillDelay === undefined ? 300 : options.fillDelay;
    function needed(flight) {
      return Array.from(subscribers.values()).some(function (sub) { return !sub.cancelled && sub.keys.has(flight.key); });
    }
    function schedule() {
      if (active) return;
      if (pumpTimer !== null) {
        if (!queue.length || new Set(queue.filter(function (f) { return f.scope === queue[0].scope; }).map(function (f) { return f.video.videoId; })).size < 20) return;
        clearTimeout(pumpTimer);
      }
      pumpTimer = setTimeout(function () { pumpTimer = null; pump(); }, 0);
    }
    function drop(flight, error) {
      if (flights.get(flight.key) === flight) flights.delete(flight.key);
      flight.reject(error);
    }
    function pump() {
      if (active) return;
      queue = queue.filter(function (f) {
        if (f.run === epoch && needed(f)) return true;
        drop(f, new Error("Request cancelled.")); return false;
      });
      if (!queue.length) return;
      var first = queue[0], selected = [], videos = new Set();
      var available = new Set(queue.filter(function (f) { return f.scope === first.scope; }).map(function (f) { return f.video.videoId; })).size;
      var wait = Math.max(first.queuedAt + fillDelay, refillAt) - Date.now();
      if (available < 20 && wait > 0) {
        pumpTimer = setTimeout(function () { pumpTimer = null; pump(); }, wait); return;
      }
      queue = queue.filter(function (f) {
        if (f.scope !== first.scope || selected.length >= 20 || videos.has(f.video.videoId)) return true;
        selected.push(f); videos.add(f.video.videoId); return false;
      });
      var objectives = first.profile.objectives.filter(function (o) {
        return selected.some(function (f) { return FocusFeedVideo.objectiveKey(f.objective) === FocusFeedVideo.objectiveKey(o); });
      });
      var id = "scores-" + Date.now() + "-" + (++serial);
      var outbound = { requestId: id, endpoint: first.endpoint,
        profile: Object.assign({}, first.profile, { objectives: objectives }),
        videos: selected.map(function (f) { return f.video; }),
        pairs: selected.map(function (f) {
          var o = objectives.find(function (o) { return FocusFeedVideo.objectiveKey(o) === FocusFeedVideo.objectiveKey(f.objective); });
          return { videoId: f.video.videoId, objectiveId: o.id };
        }) };
      jobs.set(id, { id: id, keys: selected.map(function (f) { return f.key; }) });
      log({ requestId: id, status: "queued", trigger: "unresolved_topics",
        videoIds: outbound.videos.map(function (v) { return v.videoId; }), pairs: outbound.pairs });
      active = true;
      Promise.resolve().then(function () { return dispatch(id, outbound); }).then(function (response) {
        var result = response && response.ok && response.data;
        if (!result || !Array.isArray(result.assessments) || result.assessments.length !== selected.length ||
            result.diagnostics && (result.diagnostics.missingVideoIds || []).length) throw new Error("Incomplete classifier response.");
        // Validate the entire response before saving or releasing any pair.
        var resolved = selected.map(function (f, vi) {
          var a = result.assessments.find(function (a) { return a.videoId === f.video.videoId; });
          var pair = outbound.pairs[vi], oi = objectives.findIndex(function (o) { return o.id === pair.objectiveId; });
          if (!FocusFeedVideo.isValidDecisionAssessment(a, f.video.videoId) || a.objectiveMatches.length !== 1 ||
              a.objectiveMatches[0].objectiveId !== pair.objectiveId ||
              a.objectiveMatches[0].text !== objectives[oi].text ||
              a.outcome !== FocusFeedVideo.outcome(a.objectiveMatches)) throw new Error("Incomplete classifier response.");
          var info = result.diagnostics && result.diagnostics.cache;
          var origin = info && info.byVideo && info.byVideo[f.video.videoId];
          var q = info && info.byQuestion && info.byQuestion["v" + vi + "_o" + oi + "_match"];
          var ttl = q && q.expiresInMs !== undefined ? q.expiresInMs : origin && origin.expiresInMs;
          return { flight: f, score: { p: a.objectiveMatches[0].matchProbability,
            expiresAt: Number.isFinite(ttl) ? Date.now() + Math.max(0, ttl) : origin && Number.isFinite(origin.expiresAt) ? origin.expiresAt : Date.now() + 300000,
            source: origin && origin.source || "model" } };
        });
        resolved.forEach(function (r) {
          var f = r.flight;
          if (f.run === epoch) {
            cache.set(f.key, r.score);
            var statKey = JSON.stringify([f.namespace, FocusFeedVideo.objectiveKey(f.objective)]);
            var stat = yieldStats.get(statKey) || { checks: 0, matches: 0 };
            stat.checks++; if (r.score.p >= .5) stat.matches++; yieldStats.set(statKey, stat);
            if (yieldStats.size > 200) yieldStats.delete(yieldStats.keys().next().value);
          }
          if (flights.get(f.key) === f) flights.delete(f.key);
          f.resolve(r.score);
        }); persist();
      }).catch(function (error) {
        log({ requestId: id, status: "rejected", code: error.code || "dispatch_error" });
        selected.forEach(function (f) { drop(f, error); });
      }).finally(function () { jobs.delete(id); active = false; refillAt = Date.now() + fillDelay; schedule(); });
    }
    function pair(sub, video, objective) {
      var k = key(sub.namespace, video, objective, sub.request.profile.mode), flight = flights.get(k);
      sub.keys.add(k);
      if (flight) { metrics.sharedPairs++; return flight.promise.then(function (value) { return Object.assign({}, value, { source: "shared" }); }); }
      flight = { key: k, video: video, objective: objective, profile: sub.request.profile, endpoint: sub.request.endpoint,
        namespace: sub.namespace, run: epoch, queuedAt: Date.now(),
        scope: JSON.stringify([sub.namespace, sub.request.profile.mode, FocusFeedVideo.profileKey(sub.request.profile)]) };
      flight.promise = new Promise(function (resolve, reject) { flight.resolve = resolve; flight.reject = reject; });
      flights.set(k, flight); queue.push(flight); schedule(); return flight.promise;
    }
    function cancel(owner, requestId) {
      subscribers.forEach(function (s, id) {
        if (s.owner === owner && (!requestId || s.requestId === requestId)) {
          s.cancelled = true; s.reject(new Error("Request cancelled.")); subscribers.delete(id);
          log({ requestId: s.requestId, owner: owner, status: "cancelled" });
        }
      });
      jobs.forEach(function (job) {
        if (!Array.from(subscribers.values()).some(function (s) { return job.keys.some(function (k) { return s.keys.has(k); }); }) &&
            options.cancelQueued) options.cancelQueued(job.id);
      });
      schedule();
    }
    async function submit(owner, request, namespace, isCancelled) {
      await ready; prune();
      if (isCancelled && isCancelled()) throw new Error("Request cancelled.");
      var subscriberId = ++serial, run = epoch, now = Date.now(), byVideo = {};
      var sub = { owner: owner, requestId: request.requestId, request: request, namespace: namespace, keys: new Set(), cancelled: false };
      var cancelled = new Promise(function (_resolve, reject) { sub.reject = reject; });
      subscribers.set(subscriberId, sub);
      log({ requestId: request.requestId, owner: owner, status: "admitted",
        videoIds: request.videos.map(function (v) { return v.videoId; }), topicIds: request.profile.objectives.map(function (o) { return o.id; }) });
      async function solve(video) {
        var values = new Map(), objectives = request.profile.objectives;
        function label(o) {
          return (request.corrections || []).find(function (c) { return c.videoId === video.videoId && c.topicKey === FocusFeedVideo.objectiveKey(o); });
        }
        // Read every cached topic before choosing new work: a later cached match
        // can settle a video without asking any earlier missing topics.
        objectives.forEach(function (o) {
          var saved = cache.get(key(namespace, video, o, request.profile.mode)), correction = label(o);
          if (saved && saved.expiresAt > Date.now()) { values.set(o.id, Object.assign({}, saved, { source: "local_cache" })); metrics.localHits++; }
          else if (correction) values.set(o.id, { p: correction.match ? 1 : 0, source: "user_correction", expiresAt: now + 300000, labelSource: "user" });
        });
        while (true) {
          if (sub.cancelled || run !== epoch || isCancelled && isCancelled()) throw new Error("Request cancelled.");
          var matched = objectives.some(function (o) { var c = label(o), v = values.get(o.id); return c ? c.match : v && v.p >= .5; });
          if (matched || values.size === objectives.length) break;
          var missing = objectives.filter(function (o) { return !values.has(o.id); });
          missing.sort(function (a, b) {
            function rate(o) { var s = yieldStats.get(JSON.stringify([namespace, FocusFeedVideo.objectiveKey(o)])); return s ? s.matches / s.checks : 0; }
            return rate(b) - rate(a);
          });
          var o = missing[0], k = key(namespace, video, o, request.profile.mode);
          try { values.set(o.id, await pair(sub, video, o)); } finally { sub.keys.delete(k); }
        }
        var selected = objectives.filter(function (o) { return values.has(o.id); });
        var matches = selected.map(function (o) {
          var value = values.get(o.id);
          return Object.assign({ objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: value.p },
            value.labelSource ? { labelSource: value.labelSource } : {});
        });
        var scores = Array.from(values.values());
        byVideo[video.videoId] = { source: scores.every(function (s) { return s.source === "local_cache"; }) ? "local_cache" :
          scores.every(function (s) { return s.source === "shared"; }) ? "shared" :
          scores.every(function (s) { return s.source === scores[0].source; }) ? scores[0].source : "mixed",
          expiresAt: Math.min.apply(Math, scores.map(function (s) { return s.expiresAt; })),
          checkedTopics: matches.length, skippedTopics: objectives.length - matches.length };
        var assessment = { videoId: video.videoId, objectiveMatches: matches, outcome: FocusFeedVideo.outcome(matches),
          reason: "Policy applied to reusable scores; remaining topics skipped after a match.", evidence: [] };
        if (options.progress && !sub.cancelled && run === epoch) options.progress(owner, request.requestId, assessment, byVideo[video.videoId]);
        return assessment;
      }
      try {
        var assessments = await Promise.race([Promise.all(request.videos.map(solve)), cancelled]);
        if (sub.cancelled || run !== epoch) throw new Error("Request cancelled.");
        log({ requestId: request.requestId, owner: owner, status: "completed", durationMs: Date.now() - now });
        return { ok: true, data: { assessments: assessments, diagnostics: { cache: { byVideo: byVideo } } } };
      } catch (error) {
        if (!sub.cancelled) log({ requestId: request.requestId, status: "failed", code: error.code || "request_error" });
        throw error;
      } finally {
        sub.cancelled = true; subscribers.delete(subscriberId); schedule();
      }
    }
    function clear() {
      epoch++; subscribers.forEach(function (s) { s.cancelled = true; s.reject(new Error("Cache cleared.")); });
      subscribers.clear(); cache.clear();
      flights.forEach(function (f) { f.reject(new Error("Cache cleared.")); }); flights.clear(); queue = []; yieldStats.clear();
      persist(); log({ status: "cache_cleared" });
    }
    function http(event) {
      if (event.kind === "auxiliary") { if (event.status === "dispatched") metrics.auxiliaryHttpAttempts++; }
      else {
        if (event.status === "dispatched") metrics.httpAttempts++;
        if (event.status === "completed") metrics.httpCompleted++;
        if (event.status === "failed") metrics.httpFailed++;
      }
      if (event.status === "completed") {
        metrics.providerCalls += Number(event.kind === "auxiliary" ? event.providerCalls : event.cache && event.cache.providerCalls) || 0;
        metrics.providerQuestions += Number(event.kind === "auxiliary" ? event.providerQuestions : event.cache && event.cache.providerQuestions) || 0;
        metrics.cacheHits += Number(event.cache && event.cache.hits) || 0;
        metrics.inputTokens += Number(event.usage && event.usage.input_tokens) || 0;
        metrics.outputTokens += Number(event.usage && event.usage.output_tokens) || 0;
      }
      log(event);
      persist();
    }
    return { submit: submit, cancel: cancel, clear: clear, http: http,
      snapshot: function () { return { metrics: Object.assign({}, metrics), requests: ledger.slice(), cachedPairs: cache.size, inFlightPairs: flights.size }; } };
  }
  root.FocusFeedScoreCache = { create: create };
})(globalThis);
