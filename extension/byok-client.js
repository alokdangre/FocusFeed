// Worker-only TypeSafe integration. Credentials never enter content-script messages.
(function (root) {
  "use strict";
  var ENDPOINT = "https://api.typesafe.ai", KEY = "ownfeedTypeSafeSessionV1";
  function fail(code, message) { return Object.assign(new Error(message), { code: code }); }
  function invalid() { throw fail("invalid_extension_request", "The filtering request is incomplete or too large."); }
  function text(value, max, optional) {
    if (optional && (value === undefined || value === null)) return "";
    if (typeof value !== "string" || value.length > max || !optional && !value.trim()) invalid();
    return value;
  }
  function list(value, min, max) { if (!Array.isArray(value) || value.length < min || value.length > max) invalid(); return value; }
  function probability(answer) {
    if (!answer || answer.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
      throw fail("invalid_provider_response", "TypeSafe returned an incomplete judgment. Try again.");
    return answer.noul;
  }
  function question(template, vi, oi) {
    return JSON.parse(JSON.stringify(template).replaceAll("videos[0]", "videos[" + vi + "]").replaceAll("objectives[0]", "objectives[" + oi + "]"));
  }
  function objectiveState(o) {
    text(o.id, 80); text(o.text, 160);
    if (o.matchScope === "intent" && o.validationVersion === "focusfeed-intent-v1") return { match_scope: "intent", intent: o.text };
    var topic = FocusFeedByokContract.taxonomy[o.taxonomyId];
    if (!topic || o.taxonomyVersion !== FocusFeedByokContract.taxonomyVersion || o.text !== topic.label || o.id !== topic.taxonomy_id) invalid();
    return Object.assign({}, topic, { source_text: o.sourceText || o.text });
  }
  function build(path, request) {
    var c = FocusFeedByokContract, state, questions = {}, decode;
    if (!request || typeof request !== "object") invalid();
    text(request.requestId, 100);
    if (path === "/objectives/classify") {
      var topics = list(request.objectives, 1, 8).map(function (t) { return text(t, 160); });
      state = { objectives: topics };
      topics.forEach(function (_t, i) { questions["o" + i + "_nonsense"] = question(c.questions.objective, 0, i); });
      decode = async function (result) {
        var objectives = await Promise.all(topics.map(async function (topic, i) {
          var p = probability(result.answers["o" + i + "_nonsense"]), accepted = p < .7;
          var digest = await root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(topic.toLowerCase()));
          var id = "intent-" + Array.from(new Uint8Array(digest)).map(function (v) { return v.toString(16).padStart(2, "0"); }).join("").slice(0, 24);
          return { objectiveId: "objective-" + (i + 1), text: topic, contentType: accepted ? "topic" : "unclear",
            status: accepted ? "ready_for_confirmation" : "needs_clarification", nonsenseProbability: p,
            reason: accepted ? "Accepted. Your wording will be kept." : "Describe a recognizable content topic or format.",
            validatedObjective: accepted ? { id: id, text: topic, sourceText: topic, contentType: "topic", matchScope: "intent", validationVersion: "focusfeed-intent-v1" } : null };
        }));
        return { objectives: objectives, classifier: { provider: "typesafe-jev", model: result.model, promptVersion: c.objectiveVersion } };
      };
    } else {
      var profile = request.profile;
      if (!profile || !["general", "focus"].includes(profile.mode)) invalid();
      var objectives = list(profile.objectives, 1, 12), objectiveStates = objectives.map(objectiveState);
      if (new Set(objectives.map(function (o) { return o.id; })).size !== objectives.length) invalid();
      state = { objectives: objectiveStates };
      if (path === "/classify") {
        var videos = list(request.videos, 1, 20);
        var videoIds = new Set(videos.map(function (v) { return text(v.videoId, 80); }));
        if (videoIds.size !== videos.length) invalid();
        var selected = null;
        if (request.pairs !== undefined && request.pairs !== null) {
          selected = new Set();
          list(request.pairs, 1, 96).forEach(function (p) {
            if (!videoIds.has(p.videoId) || !objectives.some(function (o) { return o.id === p.objectiveId; })) invalid();
            var key = JSON.stringify([p.videoId, p.objectiveId]); if (selected.has(key)) invalid(); selected.add(key);
          });
          if (videos.some(function (v) { return !request.pairs.some(function (p) { return p.videoId === v.videoId; }); })) invalid();
        }
        state.videos = videos.map(function (v, vi) {
          var collection = v.itemType === "collection";
          var out = { title: text(v.title, 300), channel: text(v.channel, 200, true), duration: text(v.duration, 30, true) || "not supplied",
            format: v.isShort ? "short" : v.isLive ? "live" : v.isPremiere ? "premiere" : "standard video",
            description: text(v.descriptionSnippet, 1000, true) || "not supplied" };
          if (collection) {
            text(v.collectionId, 60); if (v.videoId !== "collection:" + v.collectionId) invalid();
            Object.assign(out, { item_type: "collection", collection_id: v.collectionId, collection_policy: profile.mode,
              entries: list(v.entries || [], 0, 5).map(function (e) { return { title: text(e.title, 200, true), channel: text(e.channel, 100, true) }; }) });
          } else if (v.collectionId || v.entries && v.entries.length || v.videoId.startsWith("collection:")) invalid();
          objectives.forEach(function (o, oi) {
            if (selected && !selected.has(JSON.stringify([v.videoId, o.id]))) return;
            var template = collection ? c.questions[profile.mode === "focus" ? "collectionFocus" : "collectionGeneral"] : c.questions[o.matchScope === "intent" ? "intent" : "taxonomy"];
            questions["v" + vi + "_o" + oi + "_match"] = question(template, vi, oi);
          });
          return out;
        });
        decode = function (result) {
          return { classifier: { provider: "typesafe-jev", model: result.model, promptVersion: c.videoVersion },
            assessments: videos.map(function (v, vi) {
              var matches = objectives.flatMap(function (o, oi) {
                var id = "v" + vi + "_o" + oi + "_match";
                return questions[id] ? [{ objectiveId: o.id, text: o.text, contentType: "topic", matchProbability: probability(result.answers[id]) }] : [];
              });
              var outcome = matches.some(function (m) { return m.matchProbability >= .5; }) ? "match" : matches.every(function (m) { return m.matchProbability <= .2; }) ? "no_match" : "uncertain";
              return { videoId: v.videoId, objectiveMatches: matches, outcome: outcome, evidence: [], reason: "TypeSafe judged the supplied topic and content metadata." };
            }) };
        };
      } else if (path === "/channels/classify") {
        var channel = request.channel;
        if (!channel || !/^UC[A-Za-z0-9_-]{10,}$/.test(text(channel.channelId, 100))) invalid();
        var known = list(channel.knownTopics || [], 0, 12).map(function (v) { return text(v, 160); });
        var uploads = list(channel.uploads || [], 0, 20).map(function (v) {
          text(v.videoId, 80); return { title: text(v.title, 300), description: text(v.description, 500, true) };
        });
        if (known.length && uploads.length) invalid();
        var confirmed = channel.confirmedVideo;
        state.channel = { title: text(channel.title, 200, true), description: text(channel.description, 1500, true),
          known_topics: known, uploads: uploads, confirmed_video: confirmed ? { video_id: text(confirmed.videoId, 80), title: text(confirmed.title, 300, true), topic: text(confirmed.topic, 160) } : null };
        objectives.forEach(function (_o, i) { questions["o" + i + "_dominant"] = question(c.questions[known.length ? "channelSummary" : "channelUploads"], 0, i); });
        decode = function (result) {
          var enough = known.length > 0 || new Set((channel.uploads || []).map(function (v) { return v.videoId; })).size >= 8;
          return { channelId: channel.channelId, classifier: { provider: "typesafe-jev", model: result.model, promptVersion: c.channelVersion },
            matches: objectives.map(function (o, i) { var p = probability(result.answers["o" + i + "_dominant"]);
              return { objectiveId: o.id, text: o.text, dominantProbability: p, blockChannel: enough && p >= .5 }; }) };
        };
      } else invalid();
    }
    var payload = { model: c.model, state: state, questions: questions };
    if (!Object.keys(questions).length || Object.keys(questions).length > 96 || JSON.stringify(payload).length > 250000) invalid();
    return { payload: payload, decode: decode };
  }
  function create(options) {
    var session = options.session, local = options.local, generation = 0, changing = false, controllers = new Set(), mutations = Promise.resolve(), calls = [];
    var ready = session && session.setAccessLevel ? session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }) : Promise.reject(fail("byok_unavailable", "Update Chrome to use your API key."));
    // Attach a handler immediately; unsupported test/older environments still fail closed on use.
    ready.catch(function () {});
    async function record() {
      var current = generation; await ready; var value = (await session.get(KEY))[KEY];
      if (changing || current !== generation) throw fail("cancelled", "Your key changed. Retry this check.");
      return value;
    }
    function invalidate() { generation++; changing = true; controllers.forEach(function (c) { c.abort(); }); controllers.clear(); }
    async function publish(value, mirror) {
      var summary = { mode: "byok", endpoint: ENDPOINT, premium: !!value, userId: value ? value.id : null,
        validUntil: value ? Date.now() + 60000 : 0, checkedAt: Date.now(), keyConfigured: !!value };
      if (mirror !== false) await local.set({ focusfeedAccountV1: summary }); return summary;
    }
    async function status(mirror) { return publish(await record(), mirror); }
    async function premium() {
      var value = await record();
      if (!value) { await publish(null); throw fail("byok_key_required", "Add your TypeSafe API key in OwnFeed to use topic filtering."); }
      return publish(value);
    }
    async function send(path, key, body, signal, expectedGeneration) {
      if (changing || expectedGeneration !== undefined && expectedGeneration !== generation) throw fail("cancelled", "Your key changed. Retry this check.");
      var controller = new AbortController(), current = generation, cancel = function () { controller.abort(); };
      if (signal && signal.aborted) throw fail("cancelled", "Filtering was cancelled.");
      if (signal) signal.addEventListener("abort", cancel, { once: true });
      controllers.add(controller);
      var timer = setTimeout(cancel, 25000);
      try {
        var response = await options.fetch(ENDPOINT + path, { method: body ? "POST" : "GET", credentials: "omit", cache: "no-store", redirect: "error",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
        if (!response.ok) {
          var error = fail(response.status === 401 || response.status === 403 ? "byok_key_rejected" : response.status === 429 ? "provider_rate_limit" : "provider_error",
            response.status === 401 || response.status === 403 ? "TypeSafe rejected this key or its model access. Check your TypeSafe account." :
            response.status === 429 ? "TypeSafe's usage limit was reached. Check your balance or try later." : "TypeSafe could not complete this check. Try later.");
          error.status = response.status; throw error;
        }
        var result = await response.json();
        if (current !== generation || controller.signal.aborted) throw fail("cancelled", "Filtering was cancelled.");
        return result;
      } catch (error) {
        if (error.code && ["byok_key_rejected", "provider_rate_limit", "provider_error", "cancelled"].includes(error.code)) throw error;
        throw fail(controller.signal.aborted ? "cancelled" : "provider_unavailable", controller.signal.aborted ? "Filtering was cancelled or timed out." : "Could not reach TypeSafe. Check your connection and retry.");
      } finally { clearTimeout(timer); controllers.delete(controller); if (signal) signal.removeEventListener("abort", cancel); }
    }
    function change(operation) {
      var task = mutations.then(operation); mutations = task.catch(function () {}); return task;
    }
    function save(key) {
      return change(async function () {
        await ready;
        if (typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key.trim())) throw fail("invalid_api_key", "Paste a valid TypeSafe API key without spaces.");
        key = key.trim();
        var checkedGeneration = generation;
        // The live catalog can list only aliases while accepting pinned versions.
        // Verify the model we actually use instead of treating catalog membership
        // as authorization. This deliberately makes one small billable request.
        var check = await send("/v1/systemone", key, { model: FocusFeedByokContract.model,
          state: "OwnFeed API key verification.", questions: { ownfeed_key_check: {
            type: "noul", instructions: "Does the state describe an API key verification?"
          } } });
        if (checkedGeneration !== generation) throw fail("cancelled", "Your key changed. Retry this check.");
        if (!check || check.model !== FocusFeedByokContract.model)
          throw fail("invalid_provider_response", "TypeSafe did not return the expected model for the key check. Try again.");
        probability(check.answers && check.answers.ownfeed_key_check);
        invalidate(); var current = generation;
        try {
          await session.remove(KEY); await options.onBoundary();
          if (current !== generation) throw fail("cancelled", "Your key changed. Retry this check.");
          var value = { key: key, id: "byok-" + root.crypto.randomUUID() };
          await session.set({ [KEY]: value });
          if (current !== generation) throw fail("cancelled", "Your key changed. Retry this check.");
          await local.set({ classifierEndpoint: ENDPOINT });
          return await publish(value);
        } finally { if (current === generation) changing = false; }
      });
    }
    function remove() {
      invalidate();
      return change(async function () {
        await ready; invalidate(); var current = generation;
        try { await session.remove(KEY); var summary = await publish(null); await options.onBoundary(); return summary; }
        finally { if (current === generation) changing = false; }
      });
    }
    async function request(path, options, signal) {
      if (path === "/health") { await premium(); return { configured: true, status: "ok", provider: "typesafe-jev", model: FocusFeedByokContract.model,
        promptVersion: FocusFeedByokContract.videoVersion, objectivePromptVersion: FocusFeedByokContract.objectiveVersion,
        taxonomyVersion: FocusFeedByokContract.taxonomyVersion, auth: { mode: "byok" }, billing: { enabled: false } }; }
      if (path === "/cache/clear") { await premium(); return { cleared: true }; }
      var current = generation, value = await record(); if (!value) { await publish(null); throw fail("byok_key_required", "Add your TypeSafe API key in OwnFeed to use topic filtering."); }
      var request;
      try { request = JSON.parse(options.body); } catch (_error) { invalid(); }
      var work = build(path, request), started = Date.now();
      calls = calls.filter(function (at) { return at > Date.now() - 60000; });
      if (controllers.size >= 2 || calls.length >= 30) throw fail("provider_rate_limit", "OwnFeed paused new AI checks to limit API usage. Try again in a minute.");
      calls.push(Date.now());
      var result = await send("/v1/systemone", value.key, work.payload, signal, current);
      if (!result || !result.answers || typeof result.answers !== "object" || result.model !== FocusFeedByokContract.model)
        throw fail("invalid_provider_response", "TypeSafe returned an incomplete response. Try again.");
      // Validate all requested judgments before releasing any result.
      Object.keys(work.payload.questions).forEach(function (id) { probability(result.answers[id]); });
      var response = await work.decode(result);
      if (current !== generation) throw fail("cancelled", "Your key changed. Retry this check.");
      var usage = {};
      ["input_tokens", "output_tokens"].forEach(function (k) { if (result.usage && Number.isFinite(result.usage[k]) && result.usage[k] >= 0) usage[k] = result.usage[k]; });
      return Object.assign(response, { requestId: request.requestId, timing: { totalMs: Date.now() - started },
        diagnostics: { usage: usage, questionCount: Object.keys(work.payload.questions).length, missingVideoIds: [] } });
    }
    return { save: save, remove: remove, status: status, premium: premium, request: request };
  }
  root.FocusFeedByok = { ENDPOINT: ENDPOINT, create: create, build: build };
})(typeof globalThis !== "undefined" ? globalThis : this);
