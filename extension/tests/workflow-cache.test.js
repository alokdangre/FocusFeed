"use strict";

const assert = require("node:assert/strict");

delete global.FocusFeedWorkflow;
delete global.FocusFeedAssessmentCache;
require("../workflow-core.js");
require("../workflow-cache.js");

class MemoryStorage {
  constructor() {
    this.values = {};
  }

  async get(key) {
    return structuredClone({ [key]: this.values[key] });
  }

  async set(payload) {
    Object.assign(this.values, structuredClone(payload));
  }

  async remove(key) {
    delete this.values[key];
  }
}

function identity(id) {
  return global.FocusFeedWorkflow.buildCacheIdentity(
    { videoId: id, title: `Title ${id}`, channel: "Channel", duration: "10:00" },
    { id: "profile", version: 1, goal: "Study", mode: "focus" },
    { provider: "local", model: "nano", promptVersion: "v1", assessmentSchemaVersion: "v1" }
  );
}

function assessment(id) {
  return {
    videoId: id,
    goalRelevance: "directly_useful",
    unwantedMatch: "no",
    evidenceSufficiency: "sufficient",
    evidence: [`Title ${id}`],
  };
}

async function main() {
  const storage = new MemoryStorage();
  const cache = global.FocusFeedAssessmentCache.create(storage, { maxEntries: 2 });
  const baseTime = 100_000;
  const first = identity("one");
  const second = identity("two");
  const third = identity("three");

  await assert.rejects(
    cache.put(first, assessment("another-video"), { createdAt: baseTime, ttlMs: 10_000 }),
    /valid assessment for the cache identity/,
    "invalid assessments must be rejected before persistence"
  );
  await assert.rejects(
    cache.put(first, assessment("one"), { createdAt: Number.NaN, ttlMs: 10_000 }),
    /finite cache timestamps/i,
    "invalid cache timestamps must be rejected before persistence"
  );

  await cache.put(first, assessment("one"), { createdAt: baseTime, ttlMs: 10_000 });
  const hit = await cache.lookup(first, baseTime + 100);
  assert.equal(hit.status, "hit");
  assert.equal(hit.entry.lastAccessedAt, baseTime + 100);
  const reopenedCache = global.FocusFeedAssessmentCache.create(storage, { maxEntries: 2 });
  assert.equal((await reopenedCache.lookup(first, baseTime + 150)).status, "hit", "a new cache context must read the persisted entry without reseeding");

  await cache.put(second, assessment("two"), { createdAt: baseTime + 200, ttlMs: 10_000 });
  await cache.put(third, assessment("three"), { createdAt: baseTime + 300, ttlMs: 10_000 });
  const bounded = await cache.getAll(baseTime + 400);
  assert.equal(Object.keys(bounded).length, 2);
  assert.equal(bounded[first.key], undefined, "least recently accessed entry should be evicted at the bound");
  assert.ok(bounded[second.key]);
  assert.ok(bounded[third.key]);

  const expired = await cache.lookup(second, baseTime + 20_000);
  assert.equal(expired.status, "expired");
  assert.equal((await cache.stats(baseTime + 20_000)).total, 1);

  await cache.clear();
  assert.deepEqual(await cache.getAll(baseTime + 20_000), {});

  const concurrentStorage = new MemoryStorage();
  const concurrentCache = global.FocusFeedAssessmentCache.create(concurrentStorage, { maxEntries: 10 });
  const secondCacheContext = global.FocusFeedAssessmentCache.create(concurrentStorage, { maxEntries: 10 });
  await Promise.all([
    concurrentCache.put(first, assessment("one"), { createdAt: baseTime, ttlMs: 10_000 }),
    secondCacheContext.put(second, assessment("two"), { createdAt: baseTime, ttlMs: 10_000 }),
  ]);
  const concurrentEntries = await concurrentCache.getAll(baseTime + 100);
  assert.equal(Object.keys(concurrentEntries).length, 2, "simultaneous cache writes must not lose an assessment");
  assert.ok(concurrentEntries[first.key]);
  assert.ok(concurrentEntries[second.key]);

  await Promise.all([
    concurrentCache.put(third, assessment("three"), { createdAt: baseTime + 200, ttlMs: 10_000 }),
    secondCacheContext.clear(),
  ]);
  assert.deepEqual(
    await concurrentCache.getAll(baseTime + 300),
    {},
    "a clear queued after a write must not allow the older write to resurrect entries"
  );
  console.log("workflow persistent cache test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
