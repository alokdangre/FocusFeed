// FocusFeed bounded persistent assessment cache.

(function (root) {
  "use strict";

  var STORAGE_KEY = "focusFeedAssessmentCacheV1";
  var DEFAULT_MAX_ENTRIES = 500;

  function copyEntries(value) {
    var entries = value && typeof value === "object" ? value : {};
    return Object.keys(entries).reduce(function (result, key) {
      if (entries[key] && typeof entries[key] === "object") result[key] = entries[key];
      return result;
    }, {});
  }

  function create(storageArea, options) {
    if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
      throw new Error("A chrome.storage-compatible area is required.");
    }
    var settings = options || {};
    var maxEntries = Math.max(1, Number(settings.maxEntries) || DEFAULT_MAX_ENTRIES);

    function read() {
      return storageArea.get(STORAGE_KEY).then(function (stored) {
        return copyEntries(stored && stored[STORAGE_KEY]);
      });
    }

    function write(entries) {
      var payload = {};
      payload[STORAGE_KEY] = entries;
      return storageArea.set(payload).then(function () { return entries; });
    }

    function pruneEntries(entries, now) {
      var removedExpired = 0;
      Object.keys(entries).forEach(function (key) {
        if (Number(entries[key].expiresAt || 0) <= now) {
          delete entries[key];
          removedExpired += 1;
        }
      });

      var keys = Object.keys(entries);
      var removedEvicted = 0;
      if (keys.length > maxEntries) {
        keys.sort(function (left, right) {
          return Number(entries[left].lastAccessedAt || entries[left].createdAt || 0) -
            Number(entries[right].lastAccessedAt || entries[right].createdAt || 0);
        });
        keys.slice(0, keys.length - maxEntries).forEach(function (key) {
          delete entries[key];
          removedEvicted += 1;
        });
      }
      return { expired: removedExpired, evicted: removedEvicted };
    }

    function getAll(now) {
      var timestamp = typeof now === "number" ? now : Date.now();
      return read().then(function (entries) {
        var changes = pruneEntries(entries, timestamp);
        if (changes.expired || changes.evicted) {
          return write(entries);
        }
        return entries;
      });
    }

    function lookup(identity, now) {
      var timestamp = typeof now === "number" ? now : Date.now();
      return read().then(function (entries) {
        var entry = entries[identity.key] || null;
        var status = root.FocusFeedWorkflow.cacheEntryStatus(entry, identity, timestamp);
        if (status === "hit") {
          entry.lastAccessedAt = timestamp;
          return write(entries).then(function () {
            return { status: status, entry: entry };
          });
        }
        if (status === "expired" || status === "invalid") {
          delete entries[identity.key];
          return write(entries).then(function () {
            return { status: status, entry: null };
          });
        }
        return { status: status, entry: null };
      });
    }

    function put(identity, assessment, metadata) {
      var details = metadata || {};
      var entry = root.FocusFeedWorkflow.createCacheEntry({
        identity: identity,
        assessment: assessment,
        createdAt: typeof details.createdAt === "number" ? details.createdAt : Date.now(),
        ttlMs: details.ttlMs,
        source: details.source,
      });
      return read().then(function (entries) {
        entries[identity.key] = entry;
        pruneEntries(entries, entry.createdAt);
        return write(entries).then(function () { return entry; });
      });
    }

    function clear() {
      if (typeof storageArea.remove === "function") {
        return storageArea.remove(STORAGE_KEY);
      }
      var payload = {};
      payload[STORAGE_KEY] = {};
      return storageArea.set(payload);
    }

    function stats(now) {
      var timestamp = typeof now === "number" ? now : Date.now();
      return read().then(function (entries) {
        var values = Object.keys(entries).map(function (key) { return entries[key]; });
        return {
          total: values.length,
          active: values.filter(function (entry) { return Number(entry.expiresAt || 0) > timestamp; }).length,
          expired: values.filter(function (entry) { return Number(entry.expiresAt || 0) <= timestamp; }).length,
          maxEntries: maxEntries,
        };
      });
    }

    return {
      storageKey: STORAGE_KEY,
      getAll: getAll,
      lookup: lookup,
      put: put,
      clear: clear,
      stats: stats,
    };
  }

  root.FocusFeedAssessmentCache = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_MAX_ENTRIES: DEFAULT_MAX_ENTRIES,
    create: create,
  };
})(globalThis);
