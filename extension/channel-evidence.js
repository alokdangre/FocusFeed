// Read public channel-page initial data without executing page scripts or private API calls.
(function (root) {
  "use strict";
  function initialData(html) {
    if (typeof html !== "string" || html.length > 6000000) throw new Error("Channel page is too large.");
    var match = /(?:var\s+ytInitialData\s*=|window\[\s*["']ytInitialData["']\s*\]\s*=|ytInitialData\s*=)\s*\{/.exec(html);
    if (!match) throw new Error("YouTube did not supply public channel data.");
    var start = match.index + match[0].lastIndexOf("{"), depth = 0, quoted = false, escape = false;
    for (var i = start; i < html.length; i++) {
      var c = html[i];
      if (quoted) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
    throw new Error("Channel data was incomplete.");
  }
  function text(value, limit) {
    if (typeof value !== "string") value = value && (value.simpleText || value.content || (value.runs || []).map(function (r) { return r.text || ""; }).join("")) || "";
    return String(value).replace(/\s+/g, " ").trim().slice(0, limit);
  }
  function parse(html, requestedId) {
    var data = initialData(html), meta = data.metadata && data.metadata.channelMetadataRenderer;
    if (!meta || !/^UC[A-Za-z0-9_-]{10,}$/.test(meta.externalId || "")) throw new Error("Channel identity could not be verified.");
    var aliases = [meta.externalId];
    [meta.vanityChannelUrl, meta.channelUrl].concat(meta.ownerUrls || []).forEach(function (url) {
      var id = FocusFeedChannelPolicy.normalizeChannelId(url); if (id && !aliases.includes(id)) aliases.push(id);
    });
    if (!aliases.includes(FocusFeedChannelPolicy.normalizeChannelId(requestedId))) throw new Error("Channel page identity did not match the selected creator.");
    var uploads = [], seen = new Set(), visited = 0;
    function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 35 || ++visited > 30000 || uploads.length >= 20) return;
      // Do not sample recommendations, other channels, or featured Home shelves.
      if (node.videoRenderer || node.gridVideoRenderer) {
        var v = node.videoRenderer || node.gridVideoRenderer;
        var title = text(v.title, 300);
        if (/^[A-Za-z0-9_-]{11}$/.test(v.videoId || "") && title && !seen.has(v.videoId)) {
          seen.add(v.videoId); uploads.push({ videoId: v.videoId, title: title, description: text(v.descriptionSnippet, 500) });
        }
        return;
      }
      if (node.lockupViewModel) {
        var lockup = node.lockupViewModel, lm = lockup.metadata && lockup.metadata.lockupMetadataViewModel;
        if (lockup.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && /^[A-Za-z0-9_-]{11}$/.test(lockup.contentId || "") && lm && !seen.has(lockup.contentId)) {
          var name = text(lm.title, 300);
          if (name) { seen.add(lockup.contentId); uploads.push({ videoId: lockup.contentId, title: name, description: "" }); }
        }
        return;
      }
      Object.values(node).forEach(function (value) { if (Array.isArray(value)) value.forEach(function (v) { walk(v, depth + 1); }); else walk(value, depth + 1); });
    }
    var tabs = data.contents && data.contents.twoColumnBrowseResultsRenderer && data.contents.twoColumnBrowseResultsRenderer.tabs || [];
    var selected = tabs.map(function (t) { return t.tabRenderer; }).find(function (t) {
      var url = t && t.endpoint && t.endpoint.commandMetadata && t.endpoint.commandMetadata.webCommandMetadata && t.endpoint.commandMetadata.webCommandMetadata.url;
      return t && t.selected && (t.title === "Videos" || /\/videos(?:[?#]|$)/.test(url || ""));
    });
    if (selected) walk(selected.content, 0);
    if (!uploads.length) throw new Error("The channel's public Videos tab did not supply uploads.");
    return { channelId: meta.externalId, aliases: aliases.filter(function (id) { return id !== meta.externalId; }),
      title: text(meta.title, 200), description: text(meta.description, 1500), uploads: uploads };
  }
  root.FocusFeedChannelEvidence = { initialData: initialData, parse: parse };
})(globalThis);
