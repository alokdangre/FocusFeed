// Home pagination backpressure. Hold real requests; never fabricate YouTube responses.
(function (root) {
  "use strict";
  function create(onChange) {
    var enabled = false;
    var credits = 0;
    var waiting = [];
    var held = 0;
    var released = 0;
    function state() { return { enabled: enabled, waiting: waiting.length, held: held, released: released, credits: credits }; }
    function notify() { if (onChange) onChange(state()); }
    function remove(item) {
      waiting = waiting.filter(function (other) { return other !== item; });
      if (item.signal) item.signal.removeEventListener("abort", item.abort);
    }
    function wait(signal) {
      if (signal && signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
      if (!enabled) return Promise.resolve();
      if (credits) { credits = 0; released += 1; notify(); return Promise.resolve(); }
      if (waiting.length >= 4) return Promise.reject(new DOMException("Home pagination paused", "AbortError"));
      held += 1;
      return new Promise(function (resolve, reject) {
        var item = { signal: signal, resolve: resolve, reject: reject };
        item.abort = function () { remove(item); reject(new DOMException("Aborted", "AbortError")); notify(); };
        waiting.push(item);
        if (signal) signal.addEventListener("abort", item.abort, { once: true });
        notify();
      });
    }
    function allowOne() {
      if (!enabled) return;
      var item = waiting[0];
      if (item) { remove(item); released += 1; item.resolve(); }
      else credits = 1; // Never bank multiple pages after repeated clicks.
      notify();
    }
    function configure(value, cancel) {
      enabled = Boolean(value); credits = 0;
      if (!enabled) waiting.slice().forEach(function (item) {
        remove(item);
        if (cancel) item.reject(new DOMException("Page changed", "AbortError"));
        else item.resolve();
      });
      notify();
    }
    return { wait: wait, allowOne: allowOne, configure: configure, state: state };
  }
  function isHomeContinuation(url, body, locationHref) {
    try {
      var location = new URL(locationHref);
      var target = new URL(url, location);
      if (location.pathname !== "/" || target.origin !== location.origin || target.pathname !== "/youtubei/v1/browse") return false;
      var data = typeof body === "string" ? JSON.parse(body) : body;
      return Boolean(data && typeof data.continuation === "string" && data.continuation.length);
    } catch (_) { return false; }
  }
  root.FocusFeedPageGate = { create: create, isHomeContinuation: isHomeContinuation };
})(globalThis);
