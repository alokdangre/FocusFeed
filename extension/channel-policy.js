// Explicit channel blocks, including compatibility for saved topic-scoped blocks.
(function (root) {
  "use strict";

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
      .map(function (objective) {
        return objective && objective.matchScope === "intent"
          ? "intent:" + encodeURIComponent(objective.text.trim().toLowerCase())
          : String(objective && objective.taxonomyId || "");
      })
      .filter(function (id) {
        if (!id || seen[id]) return false;
        seen[id] = true;
        return true;
      }).sort();
  }

  function matchesBlock(block, video, profile) {
    var blockId = normalizeChannelId(block && block.channelId);
    var videoId = normalizeChannelId(video && video.channelId);
    var blockIds = [blockId].concat(block && block.aliases || []).map(normalizeChannelId).filter(Boolean);
    var videoIds = [videoId].concat(video && video.aliases || []).map(normalizeChannelId).filter(Boolean);
    if (!blockIds.some(function (id) { return videoIds.indexOf(id) !== -1; })) return false;
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

  root.FocusFeedChannelPolicy = { normalizeChannelId: normalizeChannelId, taxonomyIds: taxonomyIds,
    matchesBlock: matchesBlock, matchingBlock: matchingBlock, createBlock: createBlock };
})(globalThis);
