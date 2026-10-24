// FocusFeed workflow core — shared normalization, validation, and feed policy.
// This file is shared by the YouTube content script and the workflow replay page.

(function (root) {
  "use strict";

  var WORKFLOW_VERSION = "workflow-v2.1";
  var CACHE_SCHEMA_VERSION = "assessment-cache-v3";
  var DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var OBJECTIVE_TYPES = [
    "topic", "creator_or_channel", "content_format", "content_purpose",
    "language", "audience_level", "style_or_tone", "other_matchable"
  ];
  var OUTCOMES = ["match", "no_match", "uncertain"];

  function normalizeText(value) {
    var text = value === null || value === undefined ? "" : String(value);
    if (text.normalize) text = text.normalize("NFKC");
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeChannelIdentity(value) {
    return normalizeText(value).replace(/^@/, "");
  }

  function normalizeList(values, normalizer) {
    var seen = {};
    return (Array.isArray(values) ? values : []).map(function (value) {
      return (normalizer || normalizeText)(value);
    }).filter(function (value) {
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    }).sort();
  }

  function parseDurationSec(value) {
    if (typeof value === "number" && isFinite(value) && value >= 0) return Math.floor(value);
    var text = String(value || "").trim();
    if (!text || !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text)) return null;
    var parts = text.split(":").map(function (part) { return Number(part); });
    if (parts.some(function (part) { return !Number.isInteger(part); })) return null;
    if (parts.length === 2) {
      if (parts[1] > 59) return null;
      return parts[0] * 60 + parts[1];
    }
    if (parts[1] > 59 || parts[2] > 59) return null;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  function isWordCharacter(char) {
    if (!char) return false;
    try {
      return /[\p{L}\p{N}_]/u.test(char);
    } catch (_error) {
      return /[A-Za-z0-9_]/.test(char);
    }
  }

  function matchesLiteralKeyword(text, keyword) {
    var haystack = normalizeText(text);
    var needle = normalizeText(keyword);
    if (!haystack || !needle) return false;
    var fromIndex = 0;
    while (fromIndex <= haystack.length - needle.length) {
      var index = haystack.indexOf(needle, fromIndex);
      if (index === -1) return false;
      var before = index > 0 ? haystack[index - 1] : "";
      var afterIndex = index + needle.length;
      var after = afterIndex < haystack.length ? haystack[afterIndex] : "";
      if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
      fromIndex = index + 1;
    }
    return false;
  }

  function normalizeVideo(video) {
    var source = video || {};
    return {
      videoId: String(source.videoId || "").trim(),
      title: String(source.title || "").replace(/\s+/g, " ").trim(),
      channel: String(source.channel || "").replace(/\s+/g, " ").trim(),
      channelId: String(source.channelId || "").trim(),
      duration: source.duration === null || source.duration === undefined ? "" : String(source.duration).trim(),
      isShort: source.isShort === true,
      isLive: source.isLive === true,
      isPremiere: source.isPremiere === true,
      description: String(source.description || "").replace(/\s+/g, " ").trim(),
    };
  }

  function normalizePreferences(preferences) {
    var source = preferences || {};
    var signals = {};
    Object.keys(source.channelSignals || {}).forEach(function (channel) {
      var identity = normalizeChannelIdentity(channel);
      var value = Number(source.channelSignals[channel]);
      if (identity && isFinite(value)) signals[identity] = value;
    });
    return {
      enabled: source.enabled !== false,
      blockedKeywords: normalizeList(source.blockedKeywords),
      blockedChannels: normalizeList(source.blockedChannels, normalizeChannelIdentity),
      whitelistedChannels: normalizeList(source.whitelistedChannels, normalizeChannelIdentity),
      hideShorts: source.hideShorts === true,
      hideLiveStreams: source.hideLiveStreams === true,
      hidePremieres: source.hidePremieres === true,
      minDurationSec: Math.max(0, Number(source.minDurationSec) || 0),
      maxDurationSec: Math.max(0, Number(source.maxDurationSec) || 0),
      channelSignals: signals,
    };
  }

  function exactChannelMatch(channel, configuredChannels) {
    var identity = normalizeChannelIdentity(channel);
    return !!identity && configuredChannels.indexOf(identity) !== -1;
  }

  function resolvedRule(action, ruleId, reason, evidence) {
    return {
      status: "resolved",
      route: "rule",
      action: action,
      ruleId: ruleId,
      reason: reason,
      evidence: evidence || [],
    };
  }

  function evaluateExplicitRules(videoInput, preferencesInput) {
    var video = normalizeVideo(videoInput);
    var preferences = normalizePreferences(preferencesInput);
    var channelIdentity = normalizeChannelIdentity(video.channel);

    if (!preferences.enabled) return resolvedRule("show", "extension_disabled", "Filtering is disabled.");
    if (exactChannelMatch(video.channel, preferences.whitelistedChannels)) {
      return resolvedRule("show", "channel_allow_exact", "Exact allowed channel match.", [video.channel]);
    }
    if (channelIdentity && Number(preferences.channelSignals[channelIdentity] || 0) <= -2) {
      return resolvedRule("hide", "channel_feedback_hide", "The user marked this exact channel as less useful at least twice.", [video.channel]);
    }
    if (preferences.hideShorts && video.isShort === true) {
      return resolvedRule("hide", "format_short", "Verified Short filtered.", ["isShort=true"]);
    }
    if (preferences.hideLiveStreams && video.isLive === true) {
      return resolvedRule("hide", "format_live", "Verified live stream filtered.", ["isLive=true"]);
    }
    if (preferences.hidePremieres && video.isPremiere === true) {
      return resolvedRule("hide", "format_premiere", "Verified premiere filtered.", ["isPremiere=true"]);
    }
    if (!video.isLive && (preferences.minDurationSec > 0 || preferences.maxDurationSec > 0)) {
      var durationSec = parseDurationSec(video.duration);
      if (durationSec !== null && preferences.minDurationSec > 0 && durationSec < preferences.minDurationSec) {
        return resolvedRule("hide", "duration_below_min", "Video is shorter than the selected minimum.", [durationSec + " seconds"]);
      }
      if (durationSec !== null && preferences.maxDurationSec > 0 && durationSec > preferences.maxDurationSec) {
        return resolvedRule("hide", "duration_above_max", "Video is longer than the selected maximum.", [durationSec + " seconds"]);
      }
    }
    for (var i = 0; i < preferences.blockedKeywords.length; i++) {
      if (matchesLiteralKeyword(video.title, preferences.blockedKeywords[i])) {
        return resolvedRule("hide", "keyword_literal", "Title matches an explicit literal keyword rule.", [preferences.blockedKeywords[i]]);
      }
    }
    if (exactChannelMatch(video.channel, preferences.blockedChannels)) {
      return resolvedRule("hide", "channel_block_exact", "Exact blocked channel match.", [video.channel]);
    }
    return null;
  }

  function assessmentOutcome(assessment) {
    return assessment && OUTCOMES.indexOf(assessment.outcome) !== -1
      ? assessment.outcome
      : "uncertain";
  }

  function uncertaintyAction(mode) {
    return mode === "focus" ? "hide" : "show";
  }

  function policyDecision(assessment, mode) {
    var outcome = assessmentOutcome(assessment);
    if (mode === "focus") return outcome === "match" ? "show" : "hide";
    return outcome === "match" ? "hide" : "show";
  }

  function stableCopy(value) {
    if (Array.isArray(value)) return value.map(stableCopy);
    if (value && typeof value === "object") {
      var result = {};
      Object.keys(value).sort().forEach(function (key) {
        if (value[key] !== undefined) result[key] = stableCopy(value[key]);
      });
      return result;
    }
    return value;
  }

  function stableStringify(value) {
    return JSON.stringify(stableCopy(value));
  }

  function hashString(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function normalizeProfileForAssessment(profile) {
    var source = profile || {};
    return {
      objectives: (Array.isArray(source.objectives) ? source.objectives : []).map(function (objective) {
        return {
          id: String(objective && objective.id || ""),
          text: normalizeText(objective && objective.text),
          contentType: String(objective && objective.contentType || ""),
          taxonomyId: String(objective && objective.taxonomyId || ""),
          taxonomyVersion: String(objective && objective.taxonomyVersion || ""),
        };
      }),
    };
  }

  function normalizeClassifierIdentity(classifier) {
    var source = classifier || {};
    return {
      provider: String(source.provider || "unknown"),
      model: String(source.model || "unknown"),
      promptVersion: String(source.promptVersion || "unknown"),
      assessmentSchemaVersion: String(source.assessmentSchemaVersion || "taxonomy-match-v2"),
    };
  }

  function buildCacheIdentity(videoInput, profile, classifier) {
    var video = normalizeVideo(videoInput);
    var signature = stableStringify({
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      video: {
        videoId: video.videoId,
        title: normalizeText(video.title),
        channel: normalizeChannelIdentity(video.channel),
        channelId: video.channelId,
        duration: video.duration,
        isShort: video.isShort,
        isLive: video.isLive,
        isPremiere: video.isPremiere,
        description: normalizeText(video.description),
      },
      objectives: normalizeProfileForAssessment(profile).objectives,
      classifier: normalizeClassifierIdentity(classifier),
    });
    return {
      key: CACHE_SCHEMA_VERSION + ":" + hashString(signature),
      signature: signature,
      videoId: video.videoId,
    };
  }

  function findCacheEntry(cacheEntries, identity) {
    if (!cacheEntries) return null;
    if (Array.isArray(cacheEntries)) {
      for (var i = 0; i < cacheEntries.length; i++) {
        if (cacheEntries[i] && cacheEntries[i].key === identity.key) return cacheEntries[i];
      }
      return null;
    }
    return cacheEntries[identity.key] || null;
  }

  function isValidDecisionAssessment(assessment, expectedVideoId) {
    if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) return false;
    if (!expectedVideoId || assessment.videoId !== expectedVideoId) return false;
    if (!Array.isArray(assessment.objectiveMatches) || !assessment.objectiveMatches.length) return false;
    var seen = {};
    for (var i = 0; i < assessment.objectiveMatches.length; i++) {
      var match = assessment.objectiveMatches[i];
      if (!match || typeof match.objectiveId !== "string" || !match.objectiveId || seen[match.objectiveId]) return false;
      if (typeof match.text !== "string" || OBJECTIVE_TYPES.indexOf(match.contentType) === -1) return false;
      if (typeof match.matchProbability !== "number" || !isFinite(match.matchProbability) ||
          match.matchProbability < 0 || match.matchProbability > 1) return false;
      seen[match.objectiveId] = true;
    }
    if (typeof assessment.evidenceProbability !== "number" || !isFinite(assessment.evidenceProbability) ||
        assessment.evidenceProbability < 0 || assessment.evidenceProbability > 1) return false;
    if (OUTCOMES.indexOf(assessment.outcome) === -1) return false;
    if (assessment.evidence !== undefined && !Array.isArray(assessment.evidence)) return false;
    if (typeof assessment.reason !== "string") return false;
    return true;
  }

  function cacheEntryStatus(entry, identity, now) {
    if (!entry) return "miss";
    if (entry.key !== identity.key) return "invalid";
    if (entry.signature !== identity.signature) return "incompatible";
    if (!isValidDecisionAssessment(entry.assessment, identity.videoId)) return "invalid";
    if (typeof entry.createdAt !== "number" || !isFinite(entry.createdAt)) return "invalid";
    if (typeof entry.expiresAt !== "number" || !isFinite(entry.expiresAt)) return "invalid";
    if (entry.lastAccessedAt !== undefined &&
        (typeof entry.lastAccessedAt !== "number" || !isFinite(entry.lastAccessedAt))) return "invalid";
    if (entry.expiresAt <= entry.createdAt) return "invalid";
    if (entry.expiresAt <= now) return "expired";
    return "hit";
  }

  function hasMinimumModelMetadata(video) {
    return !!(video.videoId && normalizeText(video.title));
  }

  function routeCandidate(options) {
    var input = options || {};
    var startedAt = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    var video = normalizeVideo(input.video);
    var trace = [{ stage: "normalize", status: "complete" }];
    var mode = input.profile && input.profile.mode === "focus" ? "focus" : "general";
    var rule = evaluateExplicitRules(video, input.preferences);
    if (rule) {
      trace.push({ stage: "rule", status: "resolved", detail: rule.ruleId });
      trace.push({ stage: "cache", status: "skipped" });
      trace.push({ stage: "decision", status: rule.action });
      rule.cacheStatus = "not_checked";
      rule.trace = trace;
      rule.latencyMs = Math.max(0, (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - startedAt);
      return rule;
    }
    trace.push({ stage: "rule", status: "miss" });

    var identity = buildCacheIdentity(video, input.profile, input.classifier);
    var now = typeof input.now === "number" ? input.now : Date.now();
    var entry = findCacheEntry(input.cacheEntries, identity);
    var status = cacheEntryStatus(entry, identity, now);
    trace.push({ stage: "cache", status: status });
    if (status === "hit") {
      var cachedAction = policyDecision(entry.assessment, mode);
      trace.push({ stage: "policy", status: cachedAction, detail: mode });
      return {
        status: "resolved",
        route: "cache",
        action: cachedAction,
        ruleId: "assessment_cache_hit",
        reason: "Compatible raw Jev judgments reused; current " + mode + " policy was applied.",
        evidence: Array.isArray(entry.assessment.evidence) ? entry.assessment.evidence.slice(0, 3) : [],
        assessment: entry.assessment,
        cacheStatus: "hit",
        cacheKey: identity.key,
        trace: trace,
        latencyMs: Math.max(0, (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - startedAt),
      };
    }

    if (!hasMinimumModelMetadata(video)) {
      trace.push({ stage: "metadata", status: "insufficient" });
      return {
        status: "unresolved",
        route: "metadata",
        action: uncertaintyAction(mode),
        ruleId: "insufficient_metadata",
        reason: "A video ID and meaningful title are required before semantic classification.",
        evidence: [],
        cacheStatus: status,
        cacheKey: identity.key,
        trace: trace,
        latencyMs: Math.max(0, (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - startedAt),
      };
    }

    trace.push({ stage: "metadata", status: "sufficient" });
    trace.push({ stage: "queue", status: "eligible" });
    return {
      status: "pending",
      route: "model_pending",
      action: uncertaintyAction(mode),
      ruleId: "semantic_assessment_required",
      reason: "No explicit rule or compatible cached assessment resolved this video.",
      evidence: [],
      cacheStatus: status,
      cacheKey: identity.key,
      trace: trace,
      latencyMs: Math.max(0, (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - startedAt),
    };
  }

  function createCacheEntry(options) {
    var input = options || {};
    var createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
    var ttlMs = typeof input.ttlMs === "number" ? input.ttlMs : DEFAULT_CACHE_TTL_MS;
    return {
      key: input.identity.key,
      signature: input.identity.signature,
      assessment: stableCopy(input.assessment),
      createdAt: createdAt,
      lastAccessedAt: createdAt,
      expiresAt: createdAt + Math.max(1, ttlMs),
      source: input.source || "semantic_classifier",
    };
  }

  root.FocusFeedWorkflow = {
    WORKFLOW_VERSION: WORKFLOW_VERSION,
    CACHE_SCHEMA_VERSION: CACHE_SCHEMA_VERSION,
    DEFAULT_CACHE_TTL_MS: DEFAULT_CACHE_TTL_MS,
    normalizeText: normalizeText,
    normalizeChannelIdentity: normalizeChannelIdentity,
    parseDurationSec: parseDurationSec,
    matchesLiteralKeyword: matchesLiteralKeyword,
    normalizeVideo: normalizeVideo,
    normalizePreferences: normalizePreferences,
    evaluateExplicitRules: evaluateExplicitRules,
    assessmentOutcome: assessmentOutcome,
    hasMinimumModelMetadata: hasMinimumModelMetadata,
    uncertaintyAction: uncertaintyAction,
    policyDecision: policyDecision,
    stableStringify: stableStringify,
    buildCacheIdentity: buildCacheIdentity,
    isValidDecisionAssessment: isValidDecisionAssessment,
    cacheEntryStatus: cacheEntryStatus,
    routeCandidate: routeCandidate,
    createCacheEntry: createCacheEntry,
  };
})(globalThis);
