// FocusFeed real-provider smoke set — a small reviewed development subset.

(function (root) {
  "use strict";

  var SELECTED_SCENARIOS = ["dev-interview-focus", "dev-product-design", "heldout-finance"];
  var source = root.FocusFeedEvalDataset;
  if (!source) throw new Error("FocusFeed evaluation dataset must load before provider smoke fixtures.");

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  var scenarios = SELECTED_SCENARIOS.map(function (id) {
    var scenario = source.scenarios.find(function (candidate) { return candidate.id === id; });
    if (!scenario) throw new Error("Missing provider smoke scenario: " + id);
    return copy(scenario);
  });

  root.FocusFeedProviderSmokeFixtures = {
    version: "2026-09-20.1",
    datasetVersion: source.version,
    promptVariant: "few-shot-v4",
    queueCap: 24,
    maxInFlight: 1,
    batchSize: 4,
    timeoutMs: 120000,
    requestBudget: scenarios.length,
    totalCases: scenarios.reduce(function (total, scenario) { return total + scenario.cases.length; }, 0),
    scenarios: scenarios,
  };
})(globalThis);
