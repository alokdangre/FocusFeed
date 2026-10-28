// Personal corrections and expiring channel policy. Raw Jev probabilities remain separate.
(function (root) {
  "use strict";
  var PROFILES = "focusfeedChannelProfilesV1", CORRECTIONS = "focusfeedCorrectionsV1";
  var PROMPT = "typesafe-jev-channel-dominant-2026-10-28.3";
  function endpointKey(value) {
    try {
      var url = new URL(value || "http://127.0.0.1:3000");
      url.pathname = url.pathname.replace(/\/+$/, ""); url.search = ""; url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch (_) { return ""; }
  }
  function empty() { return { revision: 0, items: [], history: [], allowedChannels: [] }; }
  function channelProfiles(profiles, video) {
    var ids = FocusFeedChannelPolicy.creators(video).flatMap(function (c) { return [c.channelId].concat(c.aliases); });
    return (profiles || []).filter(function (p) { return [p.channelId].concat(p.aliases || []).some(function (id) { return ids.includes(id); }); });
  }
  function correction(data, video, objective) {
    return (data && data.items || []).find(function (c) { return c.videoId === video.videoId && c.topicKey === FocusFeedVideo.objectiveKey(objective); });
  }
  function allowed(data, channelId, key) {
    return (data && data.allowedChannels || []).some(function (item) { return item.channelId === channelId && item.topicKey === key; });
  }
  function judgment(p, objective, endpoint, now) {
    if (p.endpoint !== endpoint || p.expiresAt <= now) return null;
    return (p.judgments || []).find(function (j) { return j.key === FocusFeedVideo.objectiveKey(objective) &&
      j.contract === p.contract && j.expiresAt > now && j.promptVersion === PROMPT; });
  }
  function action(data, profiles, video, profile, endpoint, now) {
    if (!profile || profile.mode !== "general" || video.itemType === "collection") return null;
    now = now || Date.now();
    var allCorrected = true;
    for (var objective of profile.objectives) {
      var saved = correction(data, video, objective);
      if (saved) { if (saved.match) return { action: "hide", reason: "user_correction" }; continue; }
      allCorrected = false;
      for (var p of channelProfiles(profiles, video)) {
        var j = judgment(p, objective, endpoint, now);
        if (j && j.blockChannel && !allowed(data, p.channelId, j.key)) return { action: "hide", reason: "channel_topic" };
      }
    }
    return allCorrected && profile.objectives.length ? { action: "show", reason: "user_correction" } : null;
  }
  function apply(data, video, profile, assessment) {
    if (!assessment || !profile || profile.mode !== "general") return assessment;
    var matches = assessment.objectiveMatches.map(function (m) {
      var objective = profile.objectives.find(function (o) { return o.id === m.objectiveId; });
      var saved = objective && correction(data, video, objective);
      return saved ? Object.assign({}, m, { matchProbability: saved.match ? 1 : 0 }) : m;
    });
    return Object.assign({}, assessment, { objectiveMatches: matches, outcome: FocusFeedVideo.outcome(matches) });
  }
  root.FocusFeedLearningPolicy = { PROFILES: PROFILES, CORRECTIONS: CORRECTIONS, PROMPT: PROMPT,
    empty: empty, endpointKey: endpointKey, channelProfiles: channelProfiles, correction: correction, allowed: allowed, judgment: judgment, action: action, apply: apply };
})(globalThis);
