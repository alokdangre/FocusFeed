(function (root) {
  "use strict";

  var CLASSIFIER = {
    provider: "typesafe-jev",
    model: "jev-1.13.0",
    promptVersion: "typesafe-jev-video-match-2026-09-26.2",
    assessmentSchemaVersion: "objective-match-v1",
  };
  var BASE_PROFILE = {
    id: "workflow-replay",
    version: 1,
    mode: "general",
    objectives: [
      { id: "objective-1", text: "gaming streams", contentType: "content_format" },
    ],
  };
  var BASE_PREFERENCES = {
    enabled: true,
    blockedKeywords: [],
    blockedChannels: [],
    whitelistedChannels: [],
    hideShorts: false,
    hideLiveStreams: false,
    hidePremieres: false,
    minDurationSec: 0,
    maxDurationSec: 0,
    channelSignals: {},
  };

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function profile(overrides) { return Object.assign(copy(BASE_PROFILE), overrides || {}); }
  function preferences(overrides) { return Object.assign(copy(BASE_PREFERENCES), overrides || {}); }
  function video(videoId, title, channel, duration, overrides) {
    return Object.assign({
      videoId: videoId,
      title: title,
      channel: channel,
      duration: duration,
      isShort: false,
      isLive: false,
      isPremiere: false,
    }, overrides || {});
  }
  function expected(route, action, cacheStatus, ruleId) {
    return { route: route, action: action, cacheStatus: cacheStatus, ruleId: ruleId };
  }
  function assessment(videoId, probability, evidenceProbability) {
    var outcome = evidenceProbability < 0.7
      ? "uncertain"
      : probability >= 0.6
        ? "match"
        : probability <= 0.2
          ? "no_match"
          : "uncertain";
    return {
      videoId: videoId,
      objectiveMatches: [{
        objectiveId: "objective-1",
        text: "gaming streams",
        contentType: "content_format",
        matchProbability: probability,
      }],
      evidenceProbability: evidenceProbability,
      outcome: outcome,
      evidence: ["Title metadata"],
      reason: "Fixture raw Jev judgment.",
    };
  }

  var cases = [
    {
      id: "allow-exact-precedence",
      video: video("wf-allow", "Gaming stream", "Study Hub", "12:10"),
      preferences: preferences({
        whitelistedChannels: ["@Study Hub"],
        blockedChannels: ["Study Hub"],
        blockedKeywords: ["gaming"],
      }),
      expectedCold: expected("rule", "show", "not_checked", "channel_allow_exact"),
      expectedWarm: expected("rule", "show", "not_checked", "channel_allow_exact"),
    },
    {
      id: "block-exact",
      video: video("wf-block", "A daily upload", "MOON CALLS", "10:00"),
      preferences: preferences({ blockedChannels: ["@Moon Calls"] }),
      expectedCold: expected("rule", "hide", "not_checked", "channel_block_exact"),
      expectedWarm: expected("rule", "hide", "not_checked", "channel_block_exact"),
    },
    {
      id: "literal-keyword",
      video: video("wf-keyword", "Late-night gaming highlights", "Clip Room", "11:20"),
      preferences: preferences({ blockedKeywords: ["gaming"] }),
      expectedCold: expected("rule", "hide", "not_checked", "keyword_literal"),
      expectedWarm: expected("rule", "hide", "not_checked", "keyword_literal"),
    },
    {
      id: "literal-near-miss",
      video: video("wf-keyword-near", "How cartoon animation works", "Motion School", "14:00"),
      preferences: preferences({ blockedKeywords: ["car"] }),
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "miss", "semantic_assessment_required"),
    },
    {
      id: "verified-short",
      video: video("wf-short", "One coding tip", "Code Minute", "", { isShort: true }),
      preferences: preferences({ hideShorts: true }),
      expectedCold: expected("rule", "hide", "not_checked", "format_short"),
      expectedWarm: expected("rule", "hide", "not_checked", "format_short"),
    },
    {
      id: "filtering-disabled",
      video: video("wf-disabled", "Gaming highlights", "Moon Calls", "10:00", { isShort: true }),
      preferences: preferences({
        enabled: false,
        hideShorts: true,
        blockedKeywords: ["gaming"],
      }),
      expectedCold: expected("rule", "show", "not_checked", "extension_disabled"),
      expectedWarm: expected("rule", "show", "not_checked", "extension_disabled"),
    },
    {
      id: "missing-title-general",
      video: video("wf-no-title-general", "", "Unknown Channel", "9:00"),
      preferences: preferences(),
      expectedCold: expected("metadata", "show", "miss", "insufficient_metadata"),
      expectedWarm: expected("metadata", "show", "miss", "insufficient_metadata"),
    },
    {
      id: "missing-title-focus",
      video: video("wf-no-title-focus", "", "Unknown Channel", "9:00"),
      profile: profile({ mode: "focus" }),
      preferences: preferences(),
      expectedCold: expected("metadata", "hide", "miss", "insufficient_metadata"),
      expectedWarm: expected("metadata", "hide", "miss", "insufficient_metadata"),
    },
    {
      id: "cached-match-general",
      video: video("wf-cache-match", "LIVE Ranked Gaming Stream", "Game Clips", "15:30"),
      profile: profile({ mode: "general" }),
      preferences: preferences(),
      cacheSeed: "match",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("cache", "hide", "hit", "assessment_cache_hit"),
    },
    {
      id: "cached-match-focus",
      video: video("wf-cache-match", "LIVE Ranked Gaming Stream", "Game Clips", "15:30"),
      profile: profile({ mode: "focus" }),
      preferences: preferences(),
      cacheSeed: "match",
      expectedCold: expected("model_pending", "hide", "miss", "semantic_assessment_required"),
      expectedWarm: expected("cache", "show", "hit", "assessment_cache_hit"),
    },
    {
      id: "cached-no-match-general",
      video: video("wf-cache-no", "Database Indexing Tutorial", "Data Class", "18:00"),
      preferences: preferences(),
      cacheSeed: "no_match",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("cache", "show", "hit", "assessment_cache_hit"),
    },
    {
      id: "cached-no-match-focus",
      video: video("wf-cache-no", "Database Indexing Tutorial", "Data Class", "18:00"),
      profile: profile({ mode: "focus" }),
      preferences: preferences(),
      cacheSeed: "no_match",
      expectedCold: expected("model_pending", "hide", "miss", "semantic_assessment_required"),
      expectedWarm: expected("cache", "hide", "hit", "assessment_cache_hit"),
    },
    {
      id: "cached-uncertain-general",
      video: video("wf-cache-uncertain", "A Quick Update", "Creator", "8:00"),
      preferences: preferences(),
      cacheSeed: "uncertain",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("cache", "show", "hit", "assessment_cache_hit"),
    },
    {
      id: "cached-uncertain-focus",
      video: video("wf-cache-uncertain", "A Quick Update", "Creator", "8:00"),
      profile: profile({ mode: "focus" }),
      preferences: preferences(),
      cacheSeed: "uncertain",
      expectedCold: expected("model_pending", "hide", "miss", "semantic_assessment_required"),
      expectedWarm: expected("cache", "hide", "hit", "assessment_cache_hit"),
    },
    {
      id: "stale-objectives",
      video: video("wf-stale", "A gaming stream", "Game Clips", "18:00"),
      profile: profile({
        objectives: [{ id: "objective-1", text: "celebrity gossip", contentType: "topic" }],
      }),
      preferences: preferences(),
      cacheSeed: "incompatible",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "incompatible", "semantic_assessment_required"),
    },
    {
      id: "wrong-video-cache-entry",
      video: video("wf-wrong-cache", "Gaming stream", "Game Clips", "18:00"),
      preferences: preferences(),
      cacheSeed: "wrong_video",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "invalid", "semantic_assessment_required"),
    },
    {
      id: "malformed-cache-expiry",
      video: video("wf-bad-expiry", "Gaming stream", "Game Clips", "18:00"),
      preferences: preferences(),
      cacheSeed: "malformed_expiry",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "invalid", "semantic_assessment_required"),
    },
    {
      id: "invalid-cache-score",
      video: video("wf-bad-score", "Gaming stream", "Game Clips", "18:00"),
      preferences: preferences(),
      cacheSeed: "invalid_score",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "invalid", "semantic_assessment_required"),
    },
    {
      id: "expired-entry",
      video: video("wf-expired", "Gaming stream", "Game Clips", "18:00"),
      preferences: preferences(),
      cacheSeed: "expired",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "expired", "semantic_assessment_required"),
    },
    {
      id: "provider-change",
      video: video("wf-provider", "Gaming stream", "Game Clips", "18:00"),
      preferences: preferences(),
      cacheSeed: "provider_miss",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "miss", "semantic_assessment_required"),
    },
  ];

  function materializeCase(item) {
    var result = copy(item);
    result.profile = result.profile || profile();
    result.classifier = copy(CLASSIFIER);
    return result;
  }

  function seededAssessment(item) {
    if (item.cacheSeed === "no_match") return assessment(item.video.videoId, 0.04, 0.95);
    if (item.cacheSeed === "uncertain") return assessment(item.video.videoId, 0.52, 0.90);
    return assessment(item.video.videoId, 0.96, 0.95);
  }

  function buildCacheEntries(now, includeCompatible) {
    var entries = {};
    cases.forEach(function (sourceCase) {
      if (!sourceCase.cacheSeed) return;
      var item = materializeCase(sourceCase);
      var identity = root.FocusFeedWorkflow.buildCacheIdentity(item.video, item.profile, item.classifier);
      if (["match", "no_match", "uncertain"].indexOf(sourceCase.cacheSeed) !== -1) {
        if (!includeCompatible || entries[identity.key]) return;
        entries[identity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: identity,
          assessment: seededAssessment(item),
          createdAt: now - 1000,
          ttlMs: 60 * 60 * 1000,
          source: "workflow_replay_fixture",
        });
      } else if (sourceCase.cacheSeed === "incompatible") {
        var oldIdentity = root.FocusFeedWorkflow.buildCacheIdentity(
          item.video,
          profile(),
          item.classifier
        );
        entries[identity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: oldIdentity,
          assessment: assessment(item.video.videoId, 0.96, 0.95),
          createdAt: now - 1000,
          ttlMs: 60 * 60 * 1000,
        });
        entries[identity.key].key = identity.key;
      } else if (sourceCase.cacheSeed === "expired") {
        entries[identity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: identity,
          assessment: assessment(item.video.videoId, 0.96, 0.95),
          createdAt: now - 5000,
          ttlMs: 1000,
        });
      } else if (sourceCase.cacheSeed === "provider_miss") {
        var oldProviderIdentity = root.FocusFeedWorkflow.buildCacheIdentity(
          item.video,
          item.profile,
          {
            provider: "typesafe-jev",
            model: "jev-old",
            promptVersion: "old",
            assessmentSchemaVersion: "objective-match-v1",
          }
        );
        entries[oldProviderIdentity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: oldProviderIdentity,
          assessment: assessment(item.video.videoId, 0.96, 0.95),
          createdAt: now - 1000,
          ttlMs: 60 * 60 * 1000,
        });
      } else if (sourceCase.cacheSeed === "wrong_video") {
        entries[identity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: identity,
          assessment: assessment("another-video", 0.96, 0.95),
          createdAt: now - 1000,
          ttlMs: 60 * 60 * 1000,
        });
      } else if (sourceCase.cacheSeed === "malformed_expiry") {
        entries[identity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: identity,
          assessment: assessment(item.video.videoId, 0.96, 0.95),
          createdAt: now - 1000,
          ttlMs: 60 * 60 * 1000,
        });
        entries[identity.key].expiresAt = "not-a-timestamp";
      } else if (sourceCase.cacheSeed === "invalid_score") {
        var invalid = assessment(item.video.videoId, 0.96, 0.95);
        invalid.objectiveMatches[0].matchProbability = 2;
        entries[identity.key] = {
          key: identity.key,
          signature: identity.signature,
          assessment: invalid,
          createdAt: now - 1000,
          lastAccessedAt: now - 1000,
          expiresAt: now + 10000,
        };
      }
    });
    return entries;
  }

  function buildWarmCache(now) { return buildCacheEntries(now, true); }
  function buildInvalidationCache(now) { return buildCacheEntries(now, false); }
  function compatibleSeeds(now) {
    var seen = {};
    return cases.filter(function (item) {
      return ["match", "no_match", "uncertain"].indexOf(item.cacheSeed) !== -1;
    }).map(materializeCase).filter(function (item) {
      var identity = root.FocusFeedWorkflow.buildCacheIdentity(item.video, item.profile, item.classifier);
      if (seen[identity.key]) return false;
      seen[identity.key] = true;
      item.identity = identity;
      item.assessment = seededAssessment(item);
      item.createdAt = now - 1000;
      return true;
    });
  }

  root.FocusFeedWorkflowFixtures = {
    version: "2026-09-26.2",
    classifier: CLASSIFIER,
    cases: cases.map(materializeCase),
    buildWarmCache: buildWarmCache,
    buildInvalidationCache: buildInvalidationCache,
    compatibleSeeds: compatibleSeeds,
  };
})(globalThis);
