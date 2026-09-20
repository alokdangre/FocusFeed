(function (root) {
  "use strict";

  function build(scenario, repeat, uniquePart) {
    if (!scenario || !scenario.profile || !Array.isArray(scenario.cases)) {
      throw new Error("Evaluation scenario is incomplete.");
    }
    return {
      requestId: "eval-" + scenario.id + "-" + repeat + "-" + (uniquePart || Date.now()),
      profile: Object.assign({}, scenario.profile, {
        usefulTopics: scenario.profile.usefulTopics.slice(),
        unwantedTopics: scenario.profile.unwantedTopics.slice(),
        exceptions: scenario.profile.exceptions.slice(),
        languages: scenario.profile.languages.slice(),
      }),
      // Copy only candidate metadata. Gold labels, notes, and tags remain outside the request.
      videos: scenario.cases.map(function (testCase) {
        return Object.assign({}, testCase.video);
      }),
    };
  }

  root.FocusFeedEvalRequest = { build: build };
})(globalThis);
