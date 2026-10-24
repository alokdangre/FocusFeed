(function (root) {
  "use strict";

  function validateRaw(response, request) {
    var raw = response.diagnostics && response.diagnostics.rawOutput;
    if (typeof raw !== "string") throw new Error("Raw local output is missing.");
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.assessments)) throw new Error("No assessment array returned.");
    var wanted = new Set(request.videos.map(function (video) { return video.videoId; }));
    var seen = new Set();
    parsed.assessments.forEach(function (assessment) {
      if (!assessment || !wanted.has(assessment.videoId) || seen.has(assessment.videoId)) {
        throw new Error("Duplicate or unexpected output ID.");
      }
      seen.add(assessment.videoId);
      if (!root.FocusFeedWorkflow.isValidDecisionAssessment(assessment, assessment.videoId)) {
        throw new Error("Model output contained invalid assessment fields.");
      }
    });
    return response;
  }

  function cloudRequest(request) {
    return {
      requestId: request.requestId,
      profile: { id: request.profile.id, version: request.profile.version, mode: request.profile.mode, objectives: request.profile.objectives },
      videos: request.videos.map(function (video) {
        return {
          videoId: video.videoId,
          title: video.title,
          channel: video.channel,
          channelId: video.channelId || undefined,
          duration: video.duration,
          isShort: video.isShort,
          isLive: video.isLive,
          isPremiere: video.isPremiere,
          descriptionSnippet: video.description,
        };
      }),
    };
  }

  root.FocusFeedLiveProvider = { validateRaw: validateRaw, cloudRequest: cloudRequest };
})(globalThis);
