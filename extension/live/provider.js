(function (root) {
  "use strict";
  function validateRaw(response, request) {
    // The classifier normalizes invalid enums and fills missing rows. Do not let
    // those repairs masquerade as validated live output.
    var raw = response.diagnostics && response.diagnostics.rawOutput;
    if (typeof raw !== "string") throw new Error("Raw local output is missing.");
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.assessments)) throw new Error("No assessment array returned.");
    var wanted = new Set(request.videos.map(function (v) { return v.videoId; }));
    var seen = new Set();
    parsed.assessments.forEach(function (assessment) {
      if (!assessment || !wanted.has(assessment.videoId) || seen.has(assessment.videoId)) throw new Error("Duplicate or unexpected output ID.");
      seen.add(assessment.videoId);
      if (!root.FocusFeedWorkflow.isValidDecisionAssessment(assessment, assessment.videoId) ||
          !["tutorial", "practice", "news", "commentary", "entertainment", "music", "other", "unclear"].includes(assessment.contentPurpose) ||
          !Array.isArray(assessment.topics) || !Array.isArray(assessment.evidence) || typeof assessment.reason !== "string") {
        throw new Error("Model output contained invalid assessment fields.");
      }
    });
    return response;
  }
  function cloudRequest(request) {
    return { requestId: request.requestId, profile: request.profile, videos: request.videos.map(function (video) {
      return { videoId: video.videoId, title: video.title, channel: video.channel, duration: video.duration,
        isShort: video.isShort, isLive: video.isLive, isPremiere: video.isPremiere, descriptionSnippet: video.description };
    }) };
  }
  root.FocusFeedLiveProvider = { validateRaw: validateRaw, cloudRequest: cloudRequest };
})(globalThis);
