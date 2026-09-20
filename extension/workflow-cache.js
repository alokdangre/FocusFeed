// FocusFeed bounded persistent assessment cache.

(function (root) {
  "use strict";

  var STORAGE_KEY = "focusFeedAssessmentCacheV2";
  var DEFAULT_MAX_ENTRIES = 500;
  var MUTATION_LOCK_NAME = "focusfeed-assessment-cache-v2-mutation";
  var mutationChains = typeof WeakMap === "function" ? new WeakMap() : null;

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
    var storageKey = settings.storageKey || STORAGE_KEY;
    var lockName = MUTATION_LOCK_NAME + ":" + storageKey;
    var maxEntries = Math.max(1, Number(settings.maxEntries) || DEFAULT_MAX_ENTRIES);

    function enqueueLocally(task) {
      var previous = mutationChains && mutationChains.get(storageArea) || Promise.resolve();
      var result = previous.catch(function () {}).then(task);
      if (mutationChains) mutationChains.set(storageArea, result.catch(function () {}));
      return result;
    }

    function mutate(task) {
      if (root.navigator && root.navigator.locks && typeof root.navigator.locks.request === "function") {
        return root.navigator.locks.request(lockName, task);
      }
      return enqueueLocally(task);
    }

    function afterMutations(task) {
      var pending = mutationChains && mutationChains.get(storageArea) || Promise.resolve();
      return pending.catch(function () {}).then(task);
    }

    function read() {
      return storageArea.get(storageKey).then(function (stored) {
        return copyEntries(stored && stored[storageKey]);
      });
    }

    function write(entries) {
      var payload = {};
      payload[storageKey] = entries;
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
      return mutate(function () {
        return read().then(function (entries) {
          var changes = pruneEntries(entries, timestamp);
          if (changes.expired || changes.evicted) {
            return write(entries);
          }
          return entries;
        });
      });
    }

    function lookup(identity, now) {
      var timestamp = typeof now === "number" ? now : Date.now();
      return mutate(function () {
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
      });
    }

    function put(identity, assessment, metadata) {
      var details = metadata || {};
      if (!root.FocusFeedWorkflow.isValidDecisionAssessment(assessment, identity && identity.videoId)) {
        return Promise.reject(new Error("A valid assessment for the cache identity is required."));
      }
      if ((details.createdAt !== undefined &&
           (typeof details.createdAt !== "number" || !isFinite(details.createdAt))) ||
          (details.ttlMs !== undefined &&
           (typeof details.ttlMs !== "number" || !isFinite(details.ttlMs) || details.ttlMs <= 0))) {
        return Promise.reject(new Error("Finite cache timestamps and a positive TTL are required."));
      }
      var entry = root.FocusFeedWorkflow.createCacheEntry({
        identity: identity,
        assessment: assessment,
        createdAt: typeof details.createdAt === "number" ? details.createdAt : Date.now(),
        ttlMs: details.ttlMs,
        source: details.source,
      });
      return mutate(function () {
        return read().then(function (entries) {
          entries[identity.key] = entry;
          pruneEntries(entries, entry.createdAt);
          return write(entries).then(function () { return entry; });
        });
      });
    }

    function clear() {
      return mutate(function () {
        if (typeof storageArea.remove === "function") {
          return storageArea.remove(storageKey);
        }
        var payload = {};
        payload[storageKey] = {};
        return storageArea.set(payload);
      });
    }

    function stats(now) {
      var timestamp = typeof now === "number" ? now : Date.now();
      return afterMutations(function () { return read(); }).then(function (entries) {
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
      storageKey: storageKey,
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
