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
    function cancel(owner, requestId) {
      subscribers.forEach(function (s, id) {
        if (s.owner === owner && (!requestId || s.requestId === requestId)) {
          s.cancelled = true; s.reject(new Error("Request cancelled.")); subscribers.delete(id);
          log({ requestId: s.requestId, owner: owner, status: "cancelled" });
        }
      });
      jobs.forEach(function (job) {
        var needed = Array.from(subscribers.values()).some(function (s) { return job.keys.some(function (k) { return s.keys.has(k); }); });
        if (!needed && options.cancelQueued) options.cancelQueued(job.id);
      });
    }
    async function submit(owner, request, namespace, isCancelled) {
      await ready; prune();
      if (isCancelled && isCancelled()) throw new Error("Request cancelled.");
      var subscriberId = ++serial, run = epoch, now = Date.now(), pairs = [], groups = new Map();
      var sub = { owner: owner, requestId: request.requestId, keys: new Set(), cancelled: false };
      var cancelled = new Promise(function (_resolve, reject) { sub.reject = reject; });
      subscribers.set(subscriberId, sub);
      request.videos.forEach(function (video) {
        var missing = [];
        request.profile.objectives.forEach(function (objective) {
          var k = key(namespace, video, objective, request.profile.mode), saved = cache.get(k), flight = flights.get(k), source;
          var promise;
          if (saved) { source = "local_cache"; metrics.localHits++; promise = Promise.resolve(saved); }
          else if (flight) { source = "shared"; metrics.sharedPairs++; promise = flight.promise; }
          else {
            source = "model"; flight = {};
            flight.promise = new Promise(function (resolve, reject) { flight.resolve = resolve; flight.reject = reject; });
            flights.set(k, flight); missing.push({ key: k, objective: objective, flight: flight }); promise = flight.promise;
          }
          sub.keys.add(k); pairs.push({ video: video, objective: objective, key: k, promise: promise, source: source });
        });
        if (missing.length) {
          var groupKey = JSON.stringify(missing.map(function (p) { return FocusFeedVideo.objectiveKey(p.objective); }));
          if (!groups.has(groupKey)) groups.set(groupKey, []);
          groups.get(groupKey).push({ video: video, missing: missing });
        }
      });
      log({ requestId: request.requestId, owner: owner, status: "admitted", videoIds: request.videos.map(function (v) { return v.videoId; }),
        topicIds: request.profile.objectives.map(function (o) { return o.id; }), localPairs: pairs.filter(function (p) { return p.source === "local_cache"; }).length,
        sharedPairs: pairs.filter(function (p) { return p.source === "shared"; }).length });
      groups.forEach(function (group) {
        var id = "scores-" + Date.now() + "-" + (++serial), keys = group.flatMap(function (v) { return v.missing.map(function (p) { return p.key; }); });
        var outbound = Object.assign({}, request, { requestId: id, parentRequestId: request.requestId, profile: Object.assign({}, request.profile, { objectives: group[0].missing.map(function (p) { return p.objective; }) }), videos: group.map(function (v) { return v.video; }) });
        jobs.set(id, { id: id, keys: keys });
        log({ requestId: request.requestId, jobId: id, status: "queued", trigger: "missing_pairs", videoIds: outbound.videos.map(function (v) { return v.videoId; }), topicIds: outbound.profile.objectives.map(function (o) { return o.id; }) });
        // Dispatch's queue owns HTTP ordering; callers merely subscribe to pair promises.
        Promise.resolve().then(function () { return dispatch(id, outbound); }).then(function (response) {
          var result = response && response.ok && response.data;
          if (!result || !Array.isArray(result.assessments)) throw new Error("Invalid classifier response.");
          if (result.diagnostics && (result.diagnostics.missingVideoIds || []).length) throw new Error("Incomplete classifier response.");
          var resolved = [];
          group.forEach(function (item, vi) {
            var a = result.assessments.find(function (a) { return a.videoId === item.video.videoId; });
            if (!FocusFeedVideo.isValidDecisionAssessment(a, item.video.videoId) || a.objectiveMatches.length !== item.missing.length) throw new Error("Incomplete classifier response.");
            item.missing.forEach(function (p, oi) {
              var match = a.objectiveMatches.find(function (m) { return m.objectiveId === p.objective.id; });
              if (!match) throw new Error("Missing topic judgment.");
              var origin = result.diagnostics && result.diagnostics.cache && result.diagnostics.cache.byVideo && result.diagnostics.cache.byVideo[item.video.videoId];
              var question = result.diagnostics && result.diagnostics.cache && result.diagnostics.cache.byQuestion && result.diagnostics.cache.byQuestion["v" + vi + "_o" + oi + "_match"];
              var ttl = question && question.expiresInMs !== undefined ? question.expiresInMs : origin && origin.expiresInMs;
              resolved.push({ pair: p, score: { p: match.matchProbability, expiresAt: Number.isFinite(ttl) ? Date.now() + Math.max(0, ttl) : origin && Number.isFinite(origin.expiresAt) ? origin.expiresAt : Date.now() + 300000,
                source: origin && origin.source || "model" } });
            });
          });
          resolved.forEach(function (r) {
            if (run === epoch) cache.set(r.pair.key, r.score);
            r.pair.flight.resolve(r.score);
            if (flights.get(r.pair.key) === r.pair.flight) flights.delete(r.pair.key);
          }); persist();
        }).catch(function (error) {
          log({ requestId: id, parentRequestId: request.requestId, status: "rejected", code: error.code || "dispatch_error" });
          group.forEach(function (item) { item.missing.forEach(function (p) {
            p.flight.reject(error); if (flights.get(p.key) === p.flight) flights.delete(p.key);
          }); });
        }).finally(function () { jobs.delete(id); });
      });
      try {
        var values = await Promise.race([Promise.all(pairs.map(function (p) { return p.promise; })), cancelled]);
        if (sub.cancelled || run !== epoch) throw new Error("Request cancelled.");
        var byVideo = {}, assessments = request.videos.map(function (video) {
          var selected = pairs.map(function (p, i) { return { pair: p, value: values[i] }; }).filter(function (p) { return p.pair.video === video; });
          var matches = selected.map(function (p) { return { objectiveId: p.pair.objective.id, text: p.pair.objective.text, contentType: "topic", matchProbability: p.value.p }; });
          var local = selected.every(function (p) { return p.pair.source === "local_cache"; });
          byVideo[video.videoId] = { source: local ? "local_cache" : selected.every(function (p) { return p.pair.source === "shared"; }) ? "shared" : selected[0].value.source,
            expiresAt: Math.min.apply(Math, selected.map(function (p) { return p.value.expiresAt; })) };
          return { videoId: video.videoId, objectiveMatches: matches, outcome: FocusFeedVideo.outcome(matches), reason: "Policy applied to reusable topic probabilities.", evidence: [] };
        });
        log({ requestId: request.requestId, owner: owner, status: "completed", durationMs: Date.now() - now });
        return { ok: true, data: { assessments: assessments, diagnostics: { cache: { byVideo: byVideo, localHits: pairs.filter(function (p) { return p.source === "local_cache"; }).length } } } };
      } catch (error) {
        if (!sub.cancelled) log({ requestId: request.requestId, status: "failed", code: error.code || "request_error" });
        throw error;
      } finally { subscribers.delete(subscriberId); }
    }
    function clear() {
      epoch++; subscribers.forEach(function (s) { s.reject(new Error("Cache cleared.")); }); subscribers.clear(); cache.clear(); flights.clear();
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
