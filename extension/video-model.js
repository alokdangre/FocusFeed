// Metadata normalization, provider contract and policy shared by the active runtime.
(function (root) {
  "use strict";
  var OUTCOMES = ["match", "no_match", "uncertain"];
  function text(value, limit) { return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit); }
  function videoInput(value) {
    var source = value || {};
    var video = {
      videoId: text(source.videoId, 80), title: text(source.title, 300), channel: text(source.channel, 200),
      channelId: text(source.channelId, 100), duration: text(source.duration, 30),
      isShort: source.isShort === true, isLive: source.isLive === true, isPremiere: source.isPremiere === true,
      description: text(source.description, 1000),
    };
    if (source.collection || source.itemType === "collection") {
      video.itemType = "collection"; video.collectionId = text(source.collectionId, 60);
      video.videoId = video.collectionId ? "collection:" + video.collectionId : "";
      video.channelId = "";
      video.entries = (source.entries || []).slice(0, 5).map(function (entry) {
        return { title: text(entry.title, 200), channel: text(entry.channel, 100) };
      });
    }
    return video;
  }
  function fingerprint(video) { var input = videoInput(video); delete input.channelId; return JSON.stringify(input); }
  function objectiveKey(o) { return JSON.stringify([o.matchScope || "taxonomy", o.text, o.taxonomyId || "", o.taxonomyVersion || "", o.validationVersion || ""]); }
  function profileKey(p) { return JSON.stringify(p.objectives.map(objectiveKey).sort()); }
  function outcome(matches) {
    return matches.some(function (m) { return m.matchProbability >= .5; }) ? "match" :
      matches.every(function (m) { return m.matchProbability <= .2; }) ? "no_match" : "uncertain";
  }
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
        var item = { videoId: video.videoId, title: video.title, channel: video.channel, channelId: video.channelId || undefined,
          duration: video.duration, isShort: video.isShort, isLive: video.isLive, isPremiere: video.isPremiere,
          descriptionSnippet: video.description };
        if (video.itemType === "collection") Object.assign(item, { itemType: "collection", collectionId: video.collectionId, entries: video.entries });
        return item;
      }),
    };
  }
  root.FocusFeedVideo = { videoInput: videoInput, fingerprint: fingerprint, hasMinimumModelMetadata: hasMinimumModelMetadata,
    uncertaintyAction: uncertaintyAction, policyDecision: policyDecision, isValidDecisionAssessment: isValidDecisionAssessment,
    cloudRequest: cloudRequest, objectiveKey: objectiveKey, profileKey: profileKey, outcome: outcome };
})(globalThis);
