// Explicit channel blocks, including compatibility for saved topic-scoped blocks.
(function (root) {
  "use strict";

  function normalizeChannelId(value) {
    var text = String(value || "").trim();
    if (!text) return "";
    try {
      if (/^(https?:)?\/\//i.test(text)) {
        var url = new URL(text, "https://www.youtube.com");
        if (!/(^|\.)youtube\.com$/.test(url.hostname)) return "";
        text = url.pathname;
      }
    } catch (_error) { return ""; }
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
    var videoIds = [videoId].concat(video && video.aliases || []).concat(creators(video).flatMap(function (creator) {
      return [creator.channelId].concat(creator.aliases);
    })).map(normalizeChannelId).filter(Boolean);
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
  function creators(video) {
    var found = [];
    var primary = video && video.channelId ? [{ channelId: video.channelId, label: video.channel, aliases: video.aliases }] : [];
    primary.concat(video && video.creators || []).forEach(function (value) {
      var id = normalizeChannelId(value.channelId); if (!id) return;
      var ids = [id].concat(value.aliases || []).map(normalizeChannelId).filter(Boolean);
      var existing = found.find(function (item) { return [item.channelId].concat(item.aliases).some(function (known) { return ids.includes(known); }); });
      if (existing) {
        existing.aliases = Array.from(new Set(existing.aliases.concat(ids))).filter(function (alias) { return alias !== existing.channelId; });
        if (value.label) existing.label = value.label;
      } else found.push({ channelId: id, aliases: ids.filter(function (alias) { return alias !== id; }), label: value.label || id });
    });
    return found;
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

  root.FocusFeedChannelPolicy = { normalizeChannelId: normalizeChannelId, taxonomyIds: taxonomyIds, creators: creators,
    matchesBlock: matchesBlock, matchingBlock: matchingBlock, createBlock: createBlock };
})(globalThis);
