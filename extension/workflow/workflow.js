(function () {
  "use strict";

  var fixtures = FocusFeedWorkflowFixtures;
  var cache = FocusFeedAssessmentCache.create(chrome.storage.local, { maxEntries: 500 });
  var runColdButton = document.getElementById("runCold");
  var runWarmButton = document.getElementById("runWarm");
  var clearCacheButton = document.getElementById("clearCache");
  var runState = document.getElementById("runState");
  var cacheStatus = document.getElementById("cacheStatus");
  var runDescription = document.getElementById("runDescription");
  var fixtureRows = document.getElementById("fixtureRows");
  var resultRows = document.getElementById("resultRows");
  var resultSummary = document.getElementById("resultSummary");

  function appendText(parent, tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function expectedText(value) {
    return value.route + " · " + value.action + " · cache " + value.cacheStatus + " · " + value.ruleId;
  }

  function formatPreferences(preferences) {
    var parts = [];
    if (preferences.whitelistedChannels.length) parts.push("allow=" + preferences.whitelistedChannels.join(", "));
    if (preferences.blockedChannels.length) parts.push("block=" + preferences.blockedChannels.join(", "));
    if (preferences.blockedKeywords.length) parts.push("keywords=" + preferences.blockedKeywords.join(", "));
    if (preferences.hideShorts) parts.push("hideShorts=true");
    if (preferences.hideLiveStreams) parts.push("hideLive=true");
    if (preferences.hidePremieres) parts.push("hidePremieres=true");
    if (preferences.minDurationSec) parts.push("minimum=" + preferences.minDurationSec + "s");
    if (preferences.maxDurationSec) parts.push("maximum=" + preferences.maxDurationSec + "s");
    return parts.length ? parts.join(" · ") : "No explicit rule configured";
  }

  function renderFixtureSet() {
    document.getElementById("fixtureVersion").textContent = "Fixtures " + fixtures.version;
    document.getElementById("fixtureCount").textContent = fixtures.cases.length + " cases";
    fixtureRows.textContent = "";
    fixtures.cases.forEach(function (item) {
      var row = document.createElement("tr");
      var inputCell = document.createElement("td");
      appendText(inputCell, "strong", "case-name", item.name);
      appendText(inputCell, "span", "case-id", item.id);
      appendText(inputCell, "span", "input-line", '“' + (item.video.title || "[missing title]") + '”');
      appendText(inputCell, "span", "input-line", (item.video.channel || "[missing channel]") + " · " + (item.video.duration || "duration unknown"));
      appendText(inputCell, "span", "case-note", item.note);
      row.appendChild(inputCell);

      var settingsCell = document.createElement("td");
      appendText(settingsCell, "span", "setting-line", formatPreferences(item.preferences));
      appendText(settingsCell, "span", "setting-line", "mode=" + item.profile.mode + " · profile v" + item.profile.version);
      if (item.cacheSeed) appendText(settingsCell, "span", "setting-line", "warm seed=" + item.cacheSeed);
      row.appendChild(settingsCell);

      var coldCell = document.createElement("td");
      appendText(coldCell, "span", "setting-line", expectedText(item.expectedCold));
      row.appendChild(coldCell);
      var warmCell = document.createElement("td");
      appendText(warmCell, "span", "setting-line", expectedText(item.expectedWarm));
      row.appendChild(warmCell);
      fixtureRows.appendChild(row);
    });
  }

  function setRunning(mode) {
    runState.className = "run-chip running";
    runState.textContent = "Running " + mode;
    runColdButton.disabled = true;
    runWarmButton.disabled = true;
    clearCacheButton.disabled = true;
  }

  function setIdle() {
    runColdButton.disabled = false;
    runWarmButton.disabled = false;
    clearCacheButton.disabled = false;
  }

  function compare(actual, expected) {
    return actual.route === expected.route &&
      actual.action === expected.action &&
      actual.cacheStatus === expected.cacheStatus &&
      actual.ruleId === expected.ruleId;
  }

  function traceFor(result) {
    var steps = ["normalize"];
    if (result.route === "rule") {
      steps.push("rule resolved", "cache skipped", "action " + result.action);
    } else {
      steps.push("rule miss", "cache " + result.cacheStatus);
      if (result.route === "cache") steps.push("policy reapplied", "action " + result.action);
      if (result.route === "metadata") steps.push("metadata unresolved", "visible");
      if (result.route === "model_pending") steps.push("model pending", "visible");
    }
    return steps;
  }

  function percentile(values, fraction) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (left, right) { return left - right; });
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  }

  function formatLatency(value) {
    if (value < 0.1) return "<0.1 ms";
    return value.toFixed(2) + " ms";
  }

  function renderResults(mode, records) {
    resultRows.textContent = "";
    records.forEach(function (record) {
      var row = document.createElement("tr");
      var caseCell = document.createElement("td");
      appendText(caseCell, "strong", "case-name", record.item.name);
      appendText(caseCell, "span", record.pass ? "pass-mark" : "fail-mark", record.pass ? "PASS" : "MISMATCH");
      row.appendChild(caseCell);

      var expectedCell = document.createElement("td");
      appendText(expectedCell, "span", "setting-line", expectedText(record.expected));
      row.appendChild(expectedCell);

      var actualCell = document.createElement("td");
      var badges = document.createElement("div");
      badges.className = "route-stack";
      appendText(badges, "span", "route-badge", record.actual.route);
      appendText(badges, "span", "route-badge " + record.actual.action, record.actual.action);
      appendText(badges, "span", "route-badge", "cache " + record.actual.cacheStatus);
      actualCell.appendChild(badges);
      appendText(actualCell, "span", "route-reason", record.actual.ruleId + " · " + record.actual.reason);
      if (record.actual.cacheKey) appendText(actualCell, "span", "cache-key", record.actual.cacheKey);
      row.appendChild(actualCell);

      var traceCell = document.createElement("td");
      var trace = document.createElement("div");
      trace.className = "trace-list-inline";
      traceFor(record.actual).forEach(function (step) {
        var className = "trace-step";
        if (step.indexOf("hit") !== -1) className += " hit";
        if (step.indexOf("resolved") !== -1) className += " resolved";
        appendText(trace, "span", className, step);
      });
      traceCell.appendChild(trace);
      row.appendChild(traceCell);

      appendText(row, "td", "latency-cell", formatLatency(record.measuredMs));
      resultRows.appendChild(row);
    });

    var passed = records.filter(function (record) { return record.pass; }).length;
    var avoided = records.filter(function (record) {
      return record.actual.route === "rule" || record.actual.route === "cache";
    }).length;
    var pending = records.filter(function (record) { return record.actual.route === "model_pending"; }).length;
    var unresolved = records.filter(function (record) { return record.actual.route === "metadata"; }).length;
    var falseHides = records.filter(function (record) {
      return record.expected.action === "show" && record.actual.action === "hide";
    }).length;
    var p95 = percentile(records.map(function (record) { return record.measuredMs; }), 0.95);

    document.getElementById("passMetric").textContent = passed + " / " + records.length;
    document.getElementById("avoidedMetric").textContent = avoided + " / " + records.length;
    document.getElementById("pendingMetric").textContent = String(pending);
    document.getElementById("unresolvedMetric").textContent = String(unresolved);
    document.getElementById("falseHideMetric").textContent = String(falseHides);
    document.getElementById("latencyMetric").textContent = formatLatency(p95 || 0);
    resultSummary.textContent = mode + " replay: " + passed + " of " + records.length + " cases matched all expected fields.";
    runState.className = "run-chip " + (passed === records.length ? "passed" : "failed");
    runState.textContent = passed === records.length ? "All passed" : (records.length - passed) + " mismatches";
  }

  function seedPersistentCompatibleEntries(now) {
    var seeds = fixtures.compatibleSeeds(now);
    return seeds.reduce(function (promise, seed) {
      return promise.then(function () {
        return cache.put(seed.identity, seed.assessment, {
          createdAt: seed.createdAt,
          ttlMs: 60 * 60 * 1000,
          source: "workflow_replay_fixture",
        });
      });
    }, Promise.resolve()).then(function () {
      return cache.getAll(now);
    });
  }

  function cacheForReplay(mode, now) {
    if (mode === "cold") return Promise.resolve({});
    return seedPersistentCompatibleEntries(now).then(function (persistedEntries) {
      // Synthetic expired/incompatible/provider entries exercise invalidation.
      // Persisted compatible entries win so the hit path actually reads the store.
      return Object.assign({}, fixtures.buildWarmCache(now), persistedEntries);
    });
  }

  function runReplay(mode) {
    setRunning(mode);
    var now = Date.now();
    runDescription.textContent = mode === "warm"
      ? "Seeding compatible assessments, then testing hit, expiry, profile, provider, and policy behavior."
      : "Using an empty in-memory cache. Persistent entries are deliberately ignored for this run.";
    return cacheForReplay(mode, now).then(function (entries) {
      var records = fixtures.cases.map(function (item) {
        var start = performance.now();
        var actual = FocusFeedWorkflow.routeCandidate({
          video: item.video,
          profile: item.profile,
          preferences: item.preferences,
          classifier: item.classifier,
          cacheEntries: entries,
          now: now,
        });
        var measuredMs = performance.now() - start;
        var expected = mode === "warm" ? item.expectedWarm : item.expectedCold;
        return {
          item: item,
          actual: actual,
          expected: expected,
          measuredMs: measuredMs,
          pass: compare(actual, expected),
        };
      });
      renderResults(mode, records);
      return refreshCacheStatus();
    }).catch(function (error) {
      runState.className = "run-chip failed";
      runState.textContent = "Replay failed";
      resultSummary.textContent = error && error.message ? error.message : String(error);
    }).finally(setIdle);
  }

  function refreshCacheStatus(message) {
    return cache.stats().then(function (stats) {
      cacheStatus.textContent = (message ? message + " " : "") +
        "Persistent assessment cache: " + stats.active + " active, " + stats.expired +
        " expired, limit " + stats.maxEntries + ". Storage key: " + cache.storageKey + ".";
    });
  }

  runColdButton.addEventListener("click", function () { runReplay("cold"); });
  runWarmButton.addEventListener("click", function () { runReplay("warm"); });
  clearCacheButton.addEventListener("click", function () {
    setRunning("cache clear");
    cache.clear().then(function () {
      runState.className = "run-chip idle";
      runState.textContent = "Cache cleared";
      return refreshCacheStatus("Cache cleared.");
    }).catch(function (error) {
      runState.className = "run-chip failed";
      runState.textContent = "Clear failed";
      cacheStatus.textContent = error && error.message ? error.message : String(error);
    }).finally(setIdle);
  });

  renderFixtureSet();
  refreshCacheStatus().catch(function (error) {
    cacheStatus.textContent = "Could not read cache: " + (error && error.message ? error.message : String(error));
  });
})();
