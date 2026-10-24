// User-confirmed channel blocks and evidence-backed block suggestions.
(function (root) {
  "use strict";

  var MIN_UNWANTED = 3;
  var MIN_SESSIONS = 2;
  var MIN_UNWANTED_RATIO = 0.8;
  var PROMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

  function copy(value) { return JSON.parse(JSON.stringify(value)); }

  function normalizeChannelId(value) {
    var text = String(value || "").trim();
    if (!text) return "";
    try {
      if (/^https?:/i.test(text)) text = new URL(text).pathname;
    } catch (_error) {}
    var channelPath = text.match(/^\/?channel\/([^/?#]+)/i);
    if (channelPath) return channelPath[1];
    var handlePath = text.match(/^\/?(@[^/?#]+)/);
    if (handlePath) return handlePath[1].toLowerCase();
    if (/^UC[A-Za-z0-9_-]{10,}$/.test(text)) return text;
    if (/^@[A-Za-z0-9._-]+$/.test(text)) return text.toLowerCase();
    return "";
  }

  function taxonomyIds(profile) {
    var seen = {};
    return (profile && Array.isArray(profile.objectives) ? profile.objectives : [])
      .map(function (objective) { return String(objective && objective.taxonomyId || ""); })
      .filter(function (id) {
        if (!id || seen[id]) return false;
        seen[id] = true;
        return true;
      }).sort();
  }

  function scopeKey(profile) {
    return (profile && profile.mode === "focus" ? "focus" : "general") + "::" +
      taxonomyIds(profile).join("|");
  }

  function matchesBlock(block, video, profile) {
    var blockId = normalizeChannelId(block && block.channelId);
    var videoId = normalizeChannelId(video && video.channelId);
    if (!blockId || !videoId || blockId !== videoId) return false;
    if (block.scope === "global") return true;
    if (block.scope !== "topics") return false;
    if ((block.mode === "focus" ? "focus" : "general") !==
        (profile && profile.mode === "focus" ? "focus" : "general")) return false;
    var active = taxonomyIds(profile);
    var scoped = (Array.isArray(block.taxonomyIds) ? block.taxonomyIds : []).slice().sort();
    return active.length === scoped.length && active.every(function (id, index) {
      return id === scoped[index];
    });
  }

  function matchingBlock(blocks, video, profile) {
    return (Array.isArray(blocks) ? blocks : []).find(function (block) {
      return matchesBlock(block, video, profile);
    }) || null;
  }

  function evidenceKey(channelId, profile) {
    return normalizeChannelId(channelId) + "::" + scopeKey(profile);
  }

  function recordAssessment(stateInput, record, profile, sessionId, nowInput) {
    var state = copy(stateInput || {});
    var channelId = normalizeChannelId(record && record.video && record.video.channelId);
    var outcome = record && record.assessment && record.assessment.outcome;
    if (!channelId || record.route !== "model" || ["match", "no_match", "uncertain"].indexOf(outcome) === -1) {
      return { state: state, candidate: null };
    }
    var key = evidenceKey(channelId, profile);
    var item = state[key] || {
      evidenceKey: key,
      channelId: channelId,
      channelLabel: String(record.video.channel || channelId),
      mode: profile && profile.mode === "focus" ? "focus" : "general",
      taxonomyIds: taxonomyIds(profile),
      unwanted: 0,
      acceptable: 0,
      uncertain: 0,
      sessionIds: [],
      unwantedSessionIds: [],
      seen: [],
      promptedAt: null,
      snoozedUntil: null,
    };
    item.evidenceKey = key;
    var seenId = String(sessionId || "session") + ":" + String(record.video.videoId || "");
    if (item.seen.indexOf(seenId) !== -1) return { state: state, candidate: null };
    item.seen.push(seenId);
    if (item.seen.length > 200) item.seen = item.seen.slice(-200);
    var unwanted = item.mode === "focus" ? outcome === "no_match" : outcome === "match";
    if (outcome === "uncertain") {
      item.uncertain += 1;
    } else {
      var currentSession = String(sessionId || "session");
      if (item.sessionIds.indexOf(currentSession) === -1) {
        item.sessionIds.push(currentSession);
        if (item.sessionIds.length > 30) item.sessionIds = item.sessionIds.slice(-30);
      }
      if (unwanted) {
        item.unwanted += 1;
        if (!Array.isArray(item.unwantedSessionIds)) item.unwantedSessionIds = [];
        if (item.unwantedSessionIds.indexOf(currentSession) === -1) {
          item.unwantedSessionIds.push(currentSession);
          if (item.unwantedSessionIds.length > 30) {
            item.unwantedSessionIds = item.unwantedSessionIds.slice(-30);
          }
        }
      } else {
        item.acceptable += 1;
      }
    }
    item.channelLabel = String(record.video.channel || item.channelLabel || channelId);
    item.lastSeenAt = typeof nowInput === "number" ? nowInput : Date.now();
    state[key] = item;
    return { state: state, candidate: suggestionFor(item, nowInput) };
  }

  function suggestionFor(item, nowInput) {
    var now = typeof nowInput === "number" ? nowInput : Date.now();
    var decisive = Number(item.unwanted || 0) + Number(item.acceptable || 0);
    if (Number(item.unwanted || 0) < MIN_UNWANTED ||
        (item.unwantedSessionIds || []).length < MIN_SESSIONS ||
        !decisive || Number(item.unwanted || 0) / decisive < MIN_UNWANTED_RATIO ||
        Number(item.snoozedUntil || 0) > now ||
        (Number(item.promptedAt || 0) && now - Number(item.promptedAt) < PROMPT_COOLDOWN_MS)) {
      return null;
    }
    return copy(item);
  }

  function markPrompted(stateInput, candidate, nowInput) {
    var state = copy(stateInput || {});
    var key = candidate.evidenceKey;
    if (state[key]) state[key].promptedAt = typeof nowInput === "number" ? nowInput : Date.now();
    return state;
  }

  function snooze(stateInput, candidate, until) {
    var state = copy(stateInput || {});
    var key = candidate.evidenceKey;
    if (state[key]) state[key].snoozedUntil = until;
    return state;
  }

  function createBlock(candidate, scope, nowInput) {
    return {
      id: "channel-block-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      channelId: normalizeChannelId(candidate.channelId),
      channelLabel: String(candidate.channelLabel || candidate.channelId),
      scope: scope === "global" ? "global" : "topics",
      mode: candidate.mode === "focus" ? "focus" : "general",
      taxonomyIds: scope === "global" ? [] : (candidate.taxonomyIds || []).slice().sort(),
      createdAt: typeof nowInput === "number" ? nowInput : Date.now(),
    };
  }

  root.FocusFeedChannelPolicy = {
    MIN_UNWANTED: MIN_UNWANTED,
    MIN_SESSIONS: MIN_SESSIONS,
    MIN_UNWANTED_RATIO: MIN_UNWANTED_RATIO,
    normalizeChannelId: normalizeChannelId,
    taxonomyIds: taxonomyIds,
    matchesBlock: matchesBlock,
    matchingBlock: matchingBlock,
    recordAssessment: recordAssessment,
    suggestionFor: suggestionFor,
    markPrompted: markPrompted,
    snooze: snooze,
    createBlock: createBlock,
  };
})(globalThis);
