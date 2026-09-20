(function () {
  "use strict";

  var fixtures = FocusFeedLifecycleFixtures;
  var runButton = document.getElementById("runLifecycle");
  var exportButton = document.getElementById("exportLifecycleReport");
  var runState = document.getElementById("lifecycleRunState");
  var summary = document.getElementById("lifecycleSummary");
  var fixtureRows = document.getElementById("lifecycleFixtureRows");
  var resultRows = document.getElementById("lifecycleResultRows");
  var latestReport = null;

  function appendText(parent, tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function printable(value) {
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  function renderInvariants(parent, values) {
    var list = document.createElement("ul");
    list.className = "invariant-list";
    Object.keys(values).forEach(function (key) {
      var item = document.createElement("li");
      appendText(item, "strong", "", key + ": ");
      appendText(item, "span", "", printable(values[key]));
      list.appendChild(item);
    });
    parent.appendChild(list);
  }

  function eventCounts(events) {
    return (events || []).reduce(function (counts, event) {
      counts[event.type] = (counts[event.type] || 0) + 1;
      return counts;
    }, {});
  }

  function renderFixtures() {
    document.getElementById("lifecycleFixtureVersion").textContent =
      "Fixtures " + fixtures.version + " · " + fixtures.scenarios.length + " scenarios";
    fixtureRows.textContent = "";
    fixtures.scenarios.forEach(function (scenario) {
      var row = document.createElement("tr");
      var name = document.createElement("td");
      appendText(name, "strong", "case-name", scenario.name);
      appendText(name, "span", "case-id", scenario.id);
      row.appendChild(name);
      appendText(row, "td", "case-note", scenario.note);
      var expected = document.createElement("td");
      renderInvariants(expected, scenario.expected);
      row.appendChild(expected);
      fixtureRows.appendChild(row);
    });
  }

  function renderMetrics(report) {
    var burst = report.records.find(function (record) { return record.id === "burst-backpressure"; });
    var timed = report.records.find(function (record) { return record.id === "dedupe-and-scroll-away"; });
    var providerVideos = report.records.reduce(function (total, record) {
      return total + (record.actual.providerVideos || 0);
    }, 0);
    var staleIgnored = report.records.reduce(function (total, record) {
      return total + (record.actual.staleResultsIgnored || 0);
    }, 0);
    document.getElementById("lifecyclePassMetric").textContent = report.summary.passed + " / " + report.summary.scenarios;
    document.getElementById("queuePeakMetric").textContent = report.summary.maxQueueDepth + " / 24";
    document.getElementById("inFlightPeakMetric").textContent = report.summary.maxInFlightRequests + " / 1";
    document.getElementById("duplicateMetric").textContent = burst.actual.duplicateJoins;
    document.getElementById("providerWorkMetric").textContent = providerVideos;
    document.getElementById("staleMetric").textContent = report.summary.staleApplications + " applied · " + staleIgnored + " ignored";
    document.getElementById("failureMetric").textContent = report.summary.unresolvedFailures;
    document.getElementById("virtualLatencyMetric").textContent =
      timed.actual.queueP95Ms + " / " + timed.actual.providerP95Ms + " / " + timed.actual.totalP95Ms + " ms";
  }

  function renderResults(report) {
    resultRows.textContent = "";
    report.records.forEach(function (record) {
      var row = document.createElement("tr");
      var name = document.createElement("td");
      appendText(name, "strong", "case-name", record.name);
      appendText(name, "span", "result-status " + (record.pass ? "pass" : "fail"), record.pass ? "PASS" : "MISMATCH");
      row.appendChild(name);
      var expected = document.createElement("td");
      renderInvariants(expected, record.expected);
      row.appendChild(expected);
      var actual = document.createElement("td");
      renderInvariants(actual, record.actual);
      row.appendChild(actual);
      var trace = document.createElement("td");
      var badges = document.createElement("div");
      badges.className = "event-summary";
      var counts = eventCounts(record.events);
      Object.keys(counts).sort().forEach(function (type) {
        appendText(badges, "span", "", type + " ×" + counts[type]);
      });
      if (!Object.keys(counts).length) appendText(badges, "span", "", "No captured events");
      trace.appendChild(badges);
      row.appendChild(trace);
      resultRows.appendChild(row);
    });
  }

  async function runLifecycle() {
    runButton.disabled = true;
    exportButton.disabled = true;
    runState.className = "run-chip running";
    runState.textContent = "Running";
    summary.textContent = "Executing deterministic fake-provider scenarios…";
    try {
      var report = await fixtures.runAll();
      report.exportedAt = new Date().toISOString();
      report.environment = { userAgent: navigator.userAgent };
      latestReport = report;
      renderMetrics(report);
      renderResults(report);
      var allPassed = report.summary.failed === 0;
      runState.className = "run-chip " + (allPassed ? "passed" : "failed");
      runState.textContent = allPassed ? "All passed" : report.summary.failed + " failed";
      summary.textContent = report.summary.passed + " of " + report.summary.scenarios +
        " lifecycle scenarios matched every expected invariant.";
      exportButton.disabled = false;
    } catch (error) {
      runState.className = "run-chip failed";
      runState.textContent = "Run failed";
      summary.textContent = error && error.message ? error.message : String(error);
    } finally {
      runButton.disabled = false;
    }
  }

  runButton.addEventListener("click", runLifecycle);
  exportButton.addEventListener("click", function () {
    if (!latestReport) return;
    var blob = new Blob([JSON.stringify(latestReport, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "focusfeed-lifecycle-" + Date.now() + ".json";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  });

  renderFixtures();
})();
