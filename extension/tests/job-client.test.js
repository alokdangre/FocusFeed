"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const source = fs.readFileSync(require("node:path").join(__dirname, "../job-client.js"), "utf8");
const endpoint = "https://api.example", jobId = "a".repeat(64);
function harness(request, data = {}) {
  let access;
  const storage = { get: async key => structuredClone({ [key]: data[key] }), set: async value => Object.assign(data, structuredClone(value)),
    setAccessLevel: async value => { access = value.accessLevel; } };
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, AbortController,
    setTimeout: fn => setTimeout(fn, 0), clearTimeout });
  vm.runInContext(source, context);
  const client = context.FocusFeedJobs.create({ request, storage });
  return { client, data, access: () => access };
}
function init(id = "original-request") { return { method: "POST", body: JSON.stringify({ requestId: id, objectives: ["private topic"], mode: "general" }) }; }
function completed() { return { jobId, status: "completed", result: { requestId: "server-id", objectives: [{ valid: true }] } }; }

test("submits and polls with short requests, saves only opaque trusted-session handles", async () => {
  const calls = [], h = harness(async (path, options, timeout, signal, selected) => {
    calls.push(path); assert.equal(timeout, 15000); assert.equal(selected, endpoint); assert.ok(signal);
    return path.startsWith("/jobs/") ? completed() : { jobId, status: "queued" };
  });
  const value = await h.client.run("/objectives/classify", init(), endpoint, "alice");
  assert.equal(value.requestId, "original-request");
  assert.deepEqual(calls, ["/objectives/classify", "/jobs/" + jobId]);
  assert.equal(h.access(), "TRUSTED_CONTEXTS");
  assert.doesNotMatch(JSON.stringify(h.data), /private topic|alice|https/);
});

test("lost submission acknowledgment retries the same request ID after a worker restart", async () => {
  let sentId;
  const first = harness(async (_path, options) => { sentId = JSON.parse(options.body).requestId; throw new Error("connection lost after accepted"); });
  await assert.rejects(first.client.run("/objectives/classify", init(), endpoint, "alice"));
  assert.doesNotMatch(JSON.stringify(first.data), /private topic/);
  const second = harness(async (path, options) => {
    assert.equal(path, "/objectives/classify"); assert.equal(JSON.parse(options.body).requestId, sentId); return completed();
  }, first.data);
  assert.equal((await second.client.run("/objectives/classify", init("page-retry"), endpoint, "alice")).requestId, "page-retry");
});

test("saved jobs resume polling after a worker restart without submitting new work", async () => {
  const first = harness(async path => { if (path.startsWith("/jobs/")) throw new Error("worker interrupted"); return { jobId, status: "running" }; });
  await assert.rejects(first.client.run("/objectives/classify", init(), endpoint, "alice"));
  const calls = [], second = harness(async path => { calls.push(path); return completed(); }, first.data);
  await second.client.run("/objectives/classify", init("new-page-request"), endpoint, "alice");
  assert.deepEqual(calls, ["/jobs/" + jobId]);
});

test("a failed job is not automatically resubmitted as fresh billable work", async () => {
  const calls = [], h = harness(async path => { calls.push(path); return { jobId, status: "failed", error: { code: "job_expired", message: "Expired", status: 504 } }; });
  await assert.rejects(h.client.run("/objectives/classify", init(), endpoint, "alice"), { code: "job_expired" });
  await assert.rejects(h.client.run("/objectives/classify", init("automatic-retry"), endpoint, "alice"), { code: "job_expired" });
  assert.deepEqual(calls, ["/objectives/classify", "/jobs/" + jobId]);
});

test("saved operations are separated by account, endpoint, route, and input", async () => {
  const ids = [], h = harness(async (_path, options) => { ids.push(JSON.parse(options.body).requestId); throw new Error("offline"); });
  for (const [user, server, path, options] of [
    ["alice", endpoint, "/objectives/classify", init()], ["bob", endpoint, "/objectives/classify", init()],
    ["alice", "https://other.example", "/objectives/classify", init()], ["alice", endpoint, "/channels/classify", init()],
    ["alice", endpoint, "/objectives/classify", { method: "POST", body: JSON.stringify({ requestId: "another", objectives: ["different"] }) }]
  ]) await assert.rejects(h.client.run(path, options, server, user));
  assert.equal(new Set(ids).size, 5);
});

test("sign-out cancels work and late responses cannot restore saved handles or results", async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness(async () => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = h.client.run("/objectives/classify", init(), endpoint, "alice");
  await ready; await h.client.clear(); release(completed());
  await assert.rejects(pending, { code: "cancelled" });
  assert.deepEqual(h.data.focusfeedJobsV1, {});
});

test("polling rejects an unexpected job identity", async () => {
  const h = harness(async path => path.startsWith("/jobs/") ? { ...completed(), jobId: "b".repeat(64) } : { jobId, status: "queued" });
  await assert.rejects(h.client.run("/objectives/classify", init(), endpoint, "alice"), { code: "invalid_job" });
});
