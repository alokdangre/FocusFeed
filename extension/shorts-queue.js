// One Shorts visit owns removal history; each filter policy owns its fresh scores.
(function (root) {
  "use strict";
  var UNSETTLED = ["metadata_pending", "channel_pending", "refreshing", "refresh_retrying", "refresh_failed", "check_failed", "check_retrying", "unavailable", "invalid_assessment", "background_refresh", "background_failed"];
  function create() {
    var active = false, updating = false, policy = "", epoch = 0, visit = 0, candidates = new Map(), decisions = new Map(), removed = new Set();
    function validId(id) { return typeof id === "string" && id.length > 0 && id.length <= 80; }
    function beginVisit() { if (!active) { active = true; visit++; } }
    function endVisit() {
      active = false; updating = false; policy = ""; epoch++;
      candidates.clear(); decisions.clear(); removed.clear();
    }
    function offer(id) {
      if (!validId(id)) return false;
      if (removed.has(id)) return false;
      candidates.set(id, true);
      if (candidates.size > 200) candidates.delete(candidates.keys().next().value);
      return true;
    }
    function remove(id) {
      if (!active || !validId(id)) return;
      removed.add(id); candidates.delete(id); decisions.delete(id);
    }
    function commitPolicy(next) {
      var changed = next !== policy;
      if (changed) { policy = next; decisions.clear(); epoch++; }
      updating = false;
      return changed;
    }
    function remember(video, action, reason, freshness) {
      if (updating || !validId(video.videoId) || action === "pending" || UNSETTLED.includes(reason) || reason === "shorts_block") return;
      if (active && action === "hide") { remove(video.videoId); return; }
      if (removed.has(video.videoId)) return;
      decisions.set(video.videoId, { action: action, fingerprint: FocusFeedVideo.fingerprint(video),
        expiresAt: freshness && freshness.expiresAt || Date.now() + 300000 });
      if (decisions.size > 200) decisions.delete(decisions.keys().next().value);
    }
    function decision(video) {
      if (removed.has(video.videoId)) return { action: "hide", removed: true };
      if (updating) return null;
      var saved = decisions.get(video.videoId);
      return saved && saved.expiresAt > Date.now() && saved.fingerprint === FocusFeedVideo.fingerprint(video) ? saved : null;
    }
    return { beginVisit: beginVisit, endVisit: endVisit, offer: offer, remove: remove, remember: remember, decision: decision,
      commitPolicy: commitPolicy, beginUpdate: function () { updating = true; epoch++; },
      isUpdating: function () { return updating; }, isRemoved: function (id) { return removed.has(id); },
      epoch: function () { return epoch; },
      ids: function () { return Array.from(candidates.keys()); },
      stats: function () { return { removed: removed.size, epoch: epoch, visit: visit, updating: updating }; } };
  }
  root.FocusFeedShortsQueue = { create: create };
})(globalThis);
