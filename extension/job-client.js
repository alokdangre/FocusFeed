// Short HTTP requests around durable backend jobs. Only opaque handles are saved.
(function (root) {
  "use strict";
  var KEY = "focusfeedJobsV1", MAX_AGE = 20 * 60 * 1000;
  function failure(code, message, status) { return Object.assign(new Error(message), { code: code, status: status }); }
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.keys(value).sort().reduce(function (out, k) { out[k] = stable(value[k]); return out; }, {});
    return value;
  }
  function create(options) {
    var storage = options.storage, generation = 0, writes = Promise.resolve(), controllers = new Set();
    var ready = storage.setAccessLevel ? storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }) : Promise.resolve();
    function mutate(fn) {
      var operation = writes.catch(function () {}).then(async function () {
        await ready;
        var saved = await storage.get(KEY), records = saved[KEY] || {};
        Object.keys(records).forEach(function (k) { if (!records[k] || records[k].createdAt + MAX_AGE <= Date.now()) delete records[k]; });
        var value = fn(records);
        await storage.set({ [KEY]: records });
        return value;
      });
      writes = operation;
      return operation;
    }
    async function clear() {
      generation++;
      controllers.forEach(function (controller) { controller.abort(); });
      await mutate(function (records) { Object.keys(records).forEach(function (k) { delete records[k]; }); });
    }
    function delay(ms, signal) {
      return new Promise(function (resolve, reject) {
        function abort() { clearTimeout(timer); reject(failure("cancelled", "AI request cancelled.")); }
        var timer = setTimeout(function () { signal.removeEventListener("abort", abort); resolve(); }, ms);
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    }
    async function run(path, init, endpoint, userId, signal) {
      var epoch = generation, controller = new AbortController();
      function abort() { controller.abort(); }
      function current() {
        if (epoch !== generation || controller.signal.aborted) throw failure("cancelled", "AI request cancelled.");
      }
      if (signal) { if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }
      controllers.add(controller);
      try {
        var request = JSON.parse(init.body), semantic = Object.assign({}, request);
        delete semantic.requestId;
        var bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(stable([endpoint, userId, path, semantic]))));
        var hash = Array.from(new Uint8Array(bytes)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
        current();
        var record = await mutate(function (records) {
          current();
          if (!records[hash]) {
            if (Object.keys(records).length >= 100) throw failure("job_capacity", "Too many pending AI requests. Try again shortly.");
            records[hash] = { requestId: crypto.randomUUID(), createdAt: Date.now() };
          }
          return Object.assign({}, records[hash]);
        });
        current();
        var body;
        if (record.jobId) {
          body = await options.request("/jobs/" + record.jobId, { method: "GET" }, 15000, controller.signal, endpoint);
        } else {
          body = await options.request(path, Object.assign({}, init, { body: JSON.stringify(Object.assign({}, request, { requestId: record.requestId })) }),
            15000, controller.signal, endpoint);
        }
        current();
        if (!body || !/^[a-f0-9]{64}$/.test(body.jobId)) throw failure("invalid_job", "The server returned an invalid AI request.");
        record.jobId = body.jobId;
        await mutate(function (records) { current(); records[hash] = record; });
        var deadline = record.createdAt + 11 * 60 * 1000;
        while (body.status === "queued" || body.status === "running") {
          if (Date.now() >= deadline) throw failure("job_timeout", "AI is taking too long. Retry to check the saved request.");
          await delay(Math.min(5000, Math.max(1000, Number(body.pollAfterMs) || 1500)), controller.signal);
          current();
          body = await options.request("/jobs/" + record.jobId, { method: "GET" }, 15000, controller.signal, endpoint);
          current();
          if (body.jobId !== record.jobId) throw failure("invalid_job", "The server returned a different AI request.");
        }
        if (body.status === "failed") {
          // Retain the handle: an automatic page retry must not create fresh
          // billable work after an ambiguous provider failure or worker crash.
          throw failure(body.error && body.error.code || "job_failed", body.error && body.error.message || "AI request failed.", body.error && body.error.status);
        }
        if (body.status !== "completed" || !body.result || typeof body.result !== "object") throw failure("invalid_job", "The server returned an invalid AI result.");
        await mutate(function (records) { current(); delete records[hash]; });
        return Object.assign({}, body.result, { requestId: request.requestId });
      } finally {
        controllers.delete(controller);
        if (signal) signal.removeEventListener("abort", abort);
      }
    }
    return { run: run, clear: clear };
  }
  root.FocusFeedJobs = { create: create };
})(typeof globalThis !== "undefined" ? globalThis : this);
