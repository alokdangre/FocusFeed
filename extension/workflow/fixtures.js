(function (root) {
  "use strict";

  var CLASSIFIER = {
    provider: "local",
    model: "chrome-gemini-nano",
    promptVersion: "local-2026-09-20.3",
    assessmentSchemaVersion: "assessment-v1",
  };

  var BASE_PROFILE = {
    id: "workflow-replay",
    version: 3,
    goal: "Prepare for software engineering interviews",
    usefulTopics: ["algorithms", "system design", "mock interviews"],
    unwantedTopics: ["gaming", "celebrity gossip"],
    exceptions: ["background music"],
    languages: ["English"],
    mode: "focus",
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

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function profile(overrides) {
    return Object.assign(copy(BASE_PROFILE), overrides || {});
  }

  function preferences(overrides) {
    return Object.assign(copy(BASE_PREFERENCES), overrides || {});
  }

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

  var cases = [
    {
      id: "allow-exact-precedence",
      name: "Exact allow overrides other rules",
      note: "The same exact channel is allowed and blocked; allow wins before the keyword rule.",
      video: video("wf-allow", "Gaming interview with a developer", "Study Hub", "12:10"),
      preferences: preferences({
        whitelistedChannels: ["@Study Hub"],
        blockedChannels: ["Study Hub"],
        blockedKeywords: ["gaming"],
      }),
      expectedCold: expected("rule", "show", "not_checked", "channel_allow_exact"),
      expectedWarm: expected("rule", "show", "not_checked", "channel_allow_exact"),
    },
    {
      id: "allow-substring-safe",
      name: "Channel substring does not allow",
      note: "Study Hub must not silently allow Study Hub Clips.",
      video: video("wf-allow-substring", "Weekly creator update", "Study Hub Clips", "8:40"),
      preferences: preferences({ whitelistedChannels: ["Study Hub"] }),
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "miss", "semantic_assessment_required"),
    },
    {
      id: "block-exact",
      name: "Exact channel block",
      note: "Case and leading @ are normalized, but the identity must otherwise be exact.",
      video: video("wf-block", "A daily upload", "MOON CALLS", "10:00"),
      preferences: preferences({ blockedChannels: ["@Moon Calls"] }),
      expectedCold: expected("rule", "hide", "not_checked", "channel_block_exact"),
      expectedWarm: expected("rule", "hide", "not_checked", "channel_block_exact"),
    },
    {
      id: "block-substring-safe",
      name: "Channel substring does not block",
      note: "Moon Calls Archive is not the exact Moon Calls identity.",
      video: video("wf-block-substring", "A daily upload", "Moon Calls Archive", "10:00"),
      preferences: preferences({ blockedChannels: ["Moon Calls"] }),
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "miss", "semantic_assessment_required"),
    },
    {
      id: "literal-keyword",
      name: "Literal keyword boundary",
      note: "gaming is a whole word in the title and resolves without a model.",
      video: video("wf-keyword", "Late-night gaming highlights", "Clip Room", "11:20"),
      preferences: preferences({ blockedKeywords: ["gaming"] }),
      expectedCold: expected("rule", "hide", "not_checked", "keyword_literal"),
      expectedWarm: expected("rule", "hide", "not_checked", "keyword_literal"),
    },
    {
      id: "literal-near-miss",
      name: "Keyword near-miss stays unresolved",
      note: "car must not match cartoon.",
      video: video("wf-keyword-near", "How cartoon animation works", "Motion School", "14:00"),
      preferences: preferences({ blockedKeywords: ["car"] }),
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "miss", "semantic_assessment_required"),
    },
    {
      id: "unknown-duration-not-short",
      name: "Missing duration is not a Short",
      note: "No format flag means unknown metadata, so the card stays pending and visible.",
      video: video("wf-unknown-duration", "System design office hours", "Architecture Lab", ""),
      preferences: preferences({ hideShorts: true }),
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "miss", "semantic_assessment_required"),
    },
    {
      id: "verified-short",
      name: "Verified Short rule",
      note: "The explicit isShort flag is trustworthy enough for the selected format preference.",
      video: video("wf-short", "One coding tip", "Code Minute", "", { isShort: true }),
      preferences: preferences({ hideShorts: true }),
      expectedCold: expected("rule", "hide", "not_checked", "format_short"),
      expectedWarm: expected("rule", "hide", "not_checked", "format_short"),
    },
    {
      id: "verified-live",
      name: "Verified live stream rule",
      note: "A live flag resolves the selected format rule even when duration is unavailable.",
      video: video("wf-live", "Live coding office hours", "Code Together", "", { isLive: true }),
      preferences: preferences({ hideLiveStreams: true }),
      expectedCold: expected("rule", "hide", "not_checked", "format_live"),
      expectedWarm: expected("rule", "hide", "not_checked", "format_live"),
    },
    {
      id: "verified-premiere",
      name: "Verified premiere rule",
      note: "Premiere and live controls retain separate provenance.",
      video: video("wf-premiere", "New course announcement", "Learning Desk", "", { isPremiere: true }),
      preferences: preferences({ hidePremieres: true }),
      expectedCold: expected("rule", "hide", "not_checked", "format_premiere"),
      expectedWarm: expected("rule", "hide", "not_checked", "format_premiere"),
    },
    {
      id: "duration-minimum",
      name: "Duration below minimum",
      note: "A parseable duration outside the explicit limit resolves immediately.",
      video: video("wf-duration", "Fast interview recap", "Career Notes", "2:30"),
      preferences: preferences({ minDurationSec: 300 }),
      expectedCold: expected("rule", "hide", "not_checked", "duration_below_min"),
      expectedWarm: expected("rule", "hide", "not_checked", "duration_below_min"),
    },
    {
      id: "duration-maximum",
      name: "Duration above maximum",
      note: "The maximum duration rule uses the same validated duration parser.",
      video: video("wf-duration-max", "Complete interview preparation course", "Career School", "2:10:00"),
      preferences: preferences({ maxDurationSec: 3600 }),
      expectedCold: expected("rule", "hide", "not_checked", "duration_above_max"),
      expectedWarm: expected("rule", "hide", "not_checked", "duration_above_max"),
    },
    {
      id: "channel-feedback",
      name: "Repeated channel feedback",
      note: "Two negative signals on the exact normalized channel activate the explicit feedback rule.",
      video: video("wf-feedback", "Another recommendation", "Daily Upload", "10:00"),
      preferences: preferences({ channelSignals: { "@daily upload": -2 } }),
      expectedCold: expected("rule", "hide", "not_checked", "channel_feedback_hide"),
      expectedWarm: expected("rule", "hide", "not_checked", "channel_feedback_hide"),
    },
    {
      id: "filtering-disabled",
      name: "Disabled extension shows content",
      note: "The master switch resolves before every hide rule.",
      video: video("wf-disabled", "Gaming highlights", "Moon Calls", "10:00", { isShort: true }),
      preferences: preferences({ enabled: false, hideShorts: true, blockedKeywords: ["gaming"], blockedChannels: ["Moon Calls"] }),
      expectedCold: expected("rule", "show", "not_checked", "extension_disabled"),
      expectedWarm: expected("rule", "show", "not_checked", "extension_disabled"),
    },
    {
      id: "missing-title",
      name: "Missing title abstains",
      note: "The router does not invoke a model without a meaningful title.",
      video: video("wf-no-title", "", "Unknown Channel", "9:00"),
      preferences: preferences(),
      expectedCold: expected("metadata", "show", "miss", "insufficient_metadata"),
      expectedWarm: expected("metadata", "show", "miss", "insufficient_metadata"),
    },
    {
      id: "cached-balanced",
      name: "Cached assessment under Balanced policy",
      note: "The assessment is unrelated but not explicitly unwanted, so Balanced mode shows it.",
      video: video("wf-cache-shared", "A tour of a mechanical keyboard collection", "Desk Gear", "15:30"),
      profile: profile({ mode: "balanced" }),
      preferences: preferences(),
      cacheSeed: "compatible",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("cache", "show", "hit", "assessment_cache_hit"),
    },
    {
      id: "cached-focus",
      name: "Same assessment under Focus policy",
      note: "Mode is not cached in the final action; Focus reapplies policy and hides unrelated content.",
      video: video("wf-cache-shared", "A tour of a mechanical keyboard collection", "Desk Gear", "15:30"),
      profile: profile({ mode: "focus" }),
      preferences: preferences(),
      cacheSeed: "compatible",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("cache", "hide", "hit", "assessment_cache_hit"),
    },
    {
      id: "stale-profile",
      name: "Changed profile rejects stale entry",
      note: "A colliding key with a different profile signature is treated as incompatible.",
      video: video("wf-stale-profile", "Graph traversal walkthrough", "CS Class", "18:00"),
      profile: profile({ version: 4, goal: "Prepare for database interviews" }),
      preferences: preferences(),
      cacheSeed: "incompatible",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "incompatible", "semantic_assessment_required"),
    },
    {
      id: "expired-entry",
      name: "Expired assessment is not reused",
      note: "TTL expiry returns the video to the semantic queue while keeping it visible.",
      video: video("wf-expired", "Binary search patterns", "Algorithm Class", "16:20"),
      preferences: preferences(),
      cacheSeed: "expired",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "expired", "semantic_assessment_required"),
    },
    {
      id: "provider-change",
      name: "Provider identity invalidates cache",
      note: "A local assessment cannot be reused as though it came from a different model contract.",
      video: video("wf-provider", "Mock interview with feedback", "Career Practice", "24:00"),
      preferences: preferences(),
      cacheSeed: "provider_miss",
      expectedCold: expected("model_pending", "show", "miss", "semantic_assessment_required"),
      expectedWarm: expected("model_pending", "show", "miss", "semantic_assessment_required"),
    },
  ];

  var unrelatedAssessment = {
    videoId: "wf-cache-shared",
    topics: ["mechanical keyboards"],
    contentPurpose: "entertainment",
    goalRelevance: "unrelated",
    unwantedMatch: "no",
    evidenceSufficiency: "sufficient",
    evidence: ["mechanical keyboard collection"],
    reason: "The collection tour is unrelated to interview preparation.",
  };

  function materializeCase(item) {
    var result = copy(item);
    result.profile = result.profile || profile();
    result.classifier = copy(CLASSIFIER);
    return result;
  }

  function buildWarmCache(now) {
    var entries = {};
    cases.forEach(function (sourceCase) {
      if (!sourceCase.cacheSeed) return;
      var item = materializeCase(sourceCase);
      var identity = root.FocusFeedWorkflow.buildCacheIdentity(item.video, item.profile, item.classifier);
      if (sourceCase.cacheSeed === "compatible") {
        entries[identity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: identity,
          assessment: unrelatedAssessment,
          createdAt: now - 1000,
          ttlMs: 60 * 60 * 1000,
          source: "workflow_replay_fixture",
        });
      } else if (sourceCase.cacheSeed === "incompatible") {
        var oldIdentity = root.FocusFeedWorkflow.buildCacheIdentity(
          item.video,
          profile({ version: 3, goal: "Prepare for software engineering interviews" }),
          item.classifier
        );
        entries[identity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: oldIdentity,
          assessment: unrelatedAssessment,
          createdAt: now - 1000,
          ttlMs: 60 * 60 * 1000,
          source: "workflow_replay_fixture",
        });
        entries[identity.key].key = identity.key;
      } else if (sourceCase.cacheSeed === "expired") {
        entries[identity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: identity,
          assessment: unrelatedAssessment,
          createdAt: now - 5000,
          ttlMs: 1000,
          source: "workflow_replay_fixture",
        });
      } else if (sourceCase.cacheSeed === "provider_miss") {
        var bedrockIdentity = root.FocusFeedWorkflow.buildCacheIdentity(item.video, item.profile, {
          provider: "bedrock",
          model: "amazon.nova-micro-v1:0",
          promptVersion: "bedrock-v1",
          assessmentSchemaVersion: "assessment-v1",
        });
        entries[bedrockIdentity.key] = root.FocusFeedWorkflow.createCacheEntry({
          identity: bedrockIdentity,
          assessment: unrelatedAssessment,
          createdAt: now - 1000,
          ttlMs: 60 * 60 * 1000,
          source: "workflow_replay_fixture",
        });
      }
    });
    return entries;
  }

  function compatibleSeeds(now) {
    var seen = {};
    return cases.filter(function (item) {
      return item.cacheSeed === "compatible";
    }).map(materializeCase).filter(function (item) {
      var identity = root.FocusFeedWorkflow.buildCacheIdentity(item.video, item.profile, item.classifier);
      if (seen[identity.key]) return false;
      seen[identity.key] = true;
      item.identity = identity;
      item.assessment = copy(unrelatedAssessment);
      item.createdAt = now - 1000;
      return true;
    });
  }

  root.FocusFeedWorkflowFixtures = {
    version: "2026-09-20.1",
    classifier: CLASSIFIER,
    cases: cases.map(materializeCase),
    buildWarmCache: buildWarmCache,
    compatibleSeeds: compatibleSeeds,
  };
})(globalThis);
