// One bounded provider queue shared by YouTube tabs; the backend caches raw scores.
(function (root) {
  "use strict";
  function create(dispatch, options) {
    options = options || {};
    var queue = [], active = null, nextAt = 0, timer = null;
    var spacing = options.spacing === undefined ? 1000 : options.spacing;
    function pump() {
      if (active || timer || !queue.length) return;
      var delay = nextAt - Date.now();
      if (delay > 0) { timer = setTimeout(function () { timer = null; pump(); }, delay); return; }
      var job = queue.shift();
      active = job;
      nextAt = Date.now() + spacing;
      Promise.resolve().then(function () { return dispatch(job.request, job.controller.signal); })
        .then(job.resolve, job.reject).finally(function () { active = null; pump(); });
    }
    function submit(owner, request) {
      if (queue.length >= 16 || queue.some(function (job) { return job.owner === owner; })) {
        return Promise.reject(new Error("Classifier queue is busy. Waiting for capacity."));
      }
      return new Promise(function (resolve, reject) {
        queue.push({ owner: owner, request: request, controller: new AbortController(), resolve: resolve, reject: reject });
        pump();
      });
    }
    function cancel(owner, id) {
      queue = queue.filter(function (job) {
        if (job.owner !== owner || (id && job.request.requestId !== id)) return true;
        job.reject(new Error("Request cancelled.")); return false;
      });
      if (active && active.owner === owner && (!id || active.request.requestId === id)) active.controller.abort();
    }
    function cancelAll() {
      var owners = new Set(queue.map(function (job) { return job.owner; }));
      if (active) owners.add(active.owner);
      owners.forEach(function (owner) { cancel(owner); });
    }
    return { submit: submit, cancel: cancel, cancelAll: cancelAll };
  }
  root.FocusFeedRequestBroker = { create: create };
})(globalThis);
