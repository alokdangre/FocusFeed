// Metadata normalization, provider contract and policy shared by the active runtime.
(function (root) {
  "use strict";
  var OUTCOMES = ["match", "no_match", "uncertain"];
  function text(value, limit) { return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit); }
  function videoInput(value) {
    var source = value || {};
    return {
      videoId: text(source.videoId, 80), title: text(source.title, 300), channel: text(source.channel, 200),
      channelId: text(source.channelId, 100), duration: text(source.duration, 30),
      isShort: source.isShort === true, isLive: source.isLive === true, isPremiere: source.isPremiere === true,
      description: text(source.description, 1000),
    };
  }
  function fingerprint(video) { return JSON.stringify(videoInput(video)); }
  function hasMinimumModelMetadata(video) { return !!(video && video.videoId && video.title && video.title.trim()); }
  function uncertaintyAction(mode) { return mode === "focus" ? "hide" : "show"; }
  function policyDecision(assessment, mode) {
    var match = assessment && assessment.outcome === "match";
    return mode === "focus" ? (match ? "show" : "hide") : (match ? "hide" : "show");
  }
  function isValidDecisionAssessment(assessment, videoId) {
    if (!assessment || !videoId || assessment.videoId !== videoId || typeof assessment.reason !== "string" ||
        OUTCOMES.indexOf(assessment.outcome) === -1 ||
        !Array.isArray(assessment.objectiveMatches) || !assessment.objectiveMatches.length ||
        (assessment.evidence !== undefined && !Array.isArray(assessment.evidence))) return false;
    var seen = new Set();
    return assessment.objectiveMatches.every(function (match) {
      if (!match || typeof match.objectiveId !== "string" || !match.objectiveId || seen.has(match.objectiveId) ||
          typeof match.text !== "string" || match.contentType !== "topic" ||
          typeof match.matchProbability !== "number" || !Number.isFinite(match.matchProbability) ||
          match.matchProbability < 0 || match.matchProbability > 1) return false;
      seen.add(match.objectiveId); return true;
    });
  }
  function cloudRequest(request) {
    return {
      requestId: request.requestId,
      profile: { id: request.profile.id, version: request.profile.version, mode: request.profile.mode, objectives: request.profile.objectives },
      videos: request.videos.map(function (video) {
        return { videoId: video.videoId, title: video.title, channel: video.channel, channelId: video.channelId || undefined,
          duration: video.duration, isShort: video.isShort, isLive: video.isLive, isPremiere: video.isPremiere,
          descriptionSnippet: video.description };
      }),
    };
  }
  root.FocusFeedVideo = { videoInput: videoInput, fingerprint: fingerprint, hasMinimumModelMetadata: hasMinimumModelMetadata,
    uncertaintyAction: uncertaintyAction, policyDecision: policyDecision, isValidDecisionAssessment: isValidDecisionAssessment,
    cloudRequest: cloudRequest };
})(globalThis);
