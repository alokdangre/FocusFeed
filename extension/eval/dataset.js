(function (root) {
  "use strict";

  function profile(goal, usefulTopics, unwantedTopics, exceptions, mode) {
    return {
      id: "focusfeed-eval",
      version: 1,
      goal: goal,
      usefulTopics: usefulTopics,
      unwantedTopics: unwantedTopics,
      exceptions: exceptions,
      languages: ["English"],
      mode: mode,
    };
  }

  function candidate(videoId, title, channel, duration, extra) {
    return Object.assign({
      videoId: videoId,
      title: title,
      channel: channel,
      duration: duration,
      isShort: false,
      isLive: false,
      isPremiere: false,
    }, extra || {});
  }

  function labeled(video, contentPurpose, goalRelevance, unwantedMatch, evidenceSufficiency, note, tags) {
    return {
      video: video,
      expected: {
        contentPurpose: contentPurpose,
        goalRelevance: goalRelevance,
        unwantedMatch: unwantedMatch,
        evidenceSufficiency: evidenceSufficiency,
      },
      labelNote: note,
      tags: tags || [],
    };
  }

  var scenarios = [
    {
      id: "dev-interview-focus",
      split: "development",
      name: "Coding interview focus",
      profile: profile(
        "Prepare for software engineering coding interviews over the next two weeks.",
        ["data structures", "algorithms", "system design", "mock interviews"],
        ["gaming", "celebrity news", "creator drama"],
        ["background music"],
        "focus"
      ),
      cases: [
        labeled(candidate("eval-interview-dsa", "Sliding Window: Solve These 5 Interview Problems", "Algorithm Academy", "12:30"), "tutorial", "directly_useful", "no", "sufficient", "The title explicitly describes interview problem instruction.", ["clear-positive"]),
        labeled(candidate("eval-interview-gta", "I Played GTA 6 Early — Here's What Happened", "Game Drop", "18:42"), "entertainment", "unrelated", "yes", "sufficient", "The title clearly identifies gaming entertainment, which the profile rejects.", ["clear-negative"]),
        labeled(candidate("eval-interview-music", "Deep Focus Music for Coding — 90 Minutes", "Quiet Keys", "1:30:00"), "music", "supporting", "no", "sufficient", "Background music is an explicit exception and can support the session.", ["exception"]),
        labeled(candidate("eval-interview-vague", "We Need to Talk", "Daily Notes", "8:05"), "unclear", "unclear", "unclear", "insufficient", "The supplied metadata does not identify a subject or relationship to the goal.", ["abstention", "vague-title"]),
      ],
    },
    {
      id: "dev-upsc-focus",
      split: "development",
      name: "UPSC study session",
      profile: profile(
        "Prepare for the UPSC civil services examination with conceptual lessons and current affairs analysis.",
        ["Indian polity", "history", "geography", "economics", "current affairs"],
        ["film gossip", "gaming", "prank videos"],
        ["instrumental study music"],
        "focus"
      ),
      cases: [
        labeled(candidate("eval-upsc-rights", "Fundamental Rights Explained for UPSC", "Civil Service Classroom", "22:10"), "tutorial", "directly_useful", "no", "sufficient", "Both the topic and intended exam are explicit.", ["clear-positive"]),
        labeled(candidate("eval-upsc-energy", "India's New Energy Policy: Context and Analysis", "Policy Desk", "16:20"), "news", "directly_useful", "no", "sufficient", "Policy analysis directly matches the requested current affairs preparation.", ["current-affairs"]),
        labeled(candidate("eval-upsc-gossip", "Biggest Bollywood Breakups This Year", "Star Flash", "9:11"), "entertainment", "unrelated", "yes", "sufficient", "The title is clearly film gossip, an explicit unwanted topic.", ["clear-negative"]),
        labeled(candidate("eval-upsc-music", "Instrumental Music for a Two-Hour Study Session", "Study Sound", "2:00:00"), "music", "supporting", "no", "sufficient", "Instrumental study music is explicitly allowed.", ["exception"]),
      ],
    },
    {
      id: "dev-product-design",
      split: "development",
      name: "Product design learning",
      profile: profile(
        "Improve product design skills through interaction patterns, research methods, and accessible interfaces.",
        ["UX research", "interaction design", "accessibility", "design systems"],
        ["AI art compilations", "celebrity content", "gaming streams"],
        ["software release news for design tools"],
        "balanced"
      ),
      cases: [
        labeled(candidate("eval-design-research", "How to Plan a Usability Study", "Research Practice", "15:12"), "tutorial", "directly_useful", "no", "sufficient", "The title directly teaches a requested research method.", ["clear-positive"]),
        labeled(candidate("eval-design-figma", "Figma's New Prototyping Features Explained", "Design Tool News", "10:33"), "news", "supporting", "no", "sufficient", "Design-tool release news is an explicit exception and supports the broader goal.", ["exception"]),
        labeled(candidate("eval-design-stream", "Late Night Ranked Gaming Stream", "Level Up Live", "2:04:10", { isLive: true }), "entertainment", "unrelated", "yes", "sufficient", "A gaming livestream explicitly matches the unwanted preference.", ["clear-negative", "live"]),
        labeled(candidate("eval-design-hud", "Design a Readable Game HUD: Accessibility and Layout", "Interface Workshop", "17:40"), "tutorial", "directly_useful", "no", "sufficient", "The purpose is interface and accessibility instruction despite the gaming context.", ["keyword-trap", "purpose-vs-topic"]),
      ],
    },
    {
      id: "dev-english-learning",
      split: "development",
      name: "English learning session",
      profile: profile(
        "Improve spoken English vocabulary and listening comprehension.",
        ["English lessons", "conversation practice", "pronunciation", "vocabulary"],
        ["cricket highlights", "celebrity gossip", "gaming"],
        ["rain sounds during vocabulary review"],
        "focus"
      ),
      cases: [
        labeled(candidate("eval-english-verbs", "20 Phrasal Verbs for Everyday English", "Speak Clearly", "14:06"), "tutorial", "directly_useful", "no", "sufficient", "The title explicitly promises English vocabulary instruction.", ["clear-positive"]),
        labeled(candidate("eval-english-practice", "Beginner English Conversation Practice at a Restaurant", "Everyday English", "11:48"), "practice", "directly_useful", "no", "sufficient", "The title is explicit conversation practice.", ["clear-positive"]),
        labeled(candidate("eval-english-cricket", "India vs Australia Final — Match Highlights", "Cricket Central", "12:01"), "entertainment", "unrelated", "yes", "sufficient", "Cricket highlights are explicitly unwanted.", ["clear-negative"]),
        labeled(candidate("eval-english-rain", "Gentle Rain Sounds for Studying", "Calm Room", "1:00:00"), "music", "supporting", "no", "sufficient", "Rain sounds are an explicit exception for this study activity.", ["exception"]),
      ],
    },
    {
      id: "heldout-marathon",
      split: "development",
      name: "Marathon training",
      profile: profile(
        "Train safely for my first marathon with workouts, recovery, and injury-prevention guidance.",
        ["running workouts", "marathon plans", "recovery", "injury prevention"],
        ["crash diets", "celebrity fitness gossip", "extreme challenges"],
        [],
        "focus"
      ),
      cases: [
        labeled(candidate("eval-run-intervals", "10K Interval Workout for Marathon Runners", "Run Strong", "18:00"), "tutorial", "directly_useful", "no", "sufficient", "The workout explicitly targets marathon runners.", ["clear-positive"]),
        labeled(candidate("eval-run-injury", "Runner's Knee: Strength Exercises and Prevention", "Sports Physio", "13:24"), "tutorial", "directly_useful", "no", "sufficient", "The title directly addresses injury prevention and recovery.", ["clear-positive"]),
        labeled(candidate("eval-run-diet", "Celebrity Crash Diet Secrets Revealed", "Fame Fitness", "9:32"), "commentary", "unrelated", "yes", "sufficient", "Both celebrity gossip and crash diets are explicitly unwanted.", ["clear-negative"]),
        labeled(candidate("eval-run-vague", "A Big Announcement Tomorrow", "Life Update", "4:18"), "unclear", "unclear", "unclear", "insufficient", "No supplied metadata establishes the subject or relevance.", ["abstention", "vague-title"]),
      ],
    },
    {
      id: "heldout-finance",
      split: "development",
      name: "Personal finance fundamentals",
      profile: profile(
        "Learn long-term personal finance fundamentals without speculative get-rich-quick content.",
        ["budgeting", "index funds", "tax basics", "emergency funds"],
        ["crypto pumps", "day-trading signals", "get-rich-quick schemes"],
        [],
        "balanced"
      ),
      cases: [
        labeled(candidate("eval-finance-index", "Index Funds Explained for Complete Beginners", "Steady Money", "15:50"), "tutorial", "directly_useful", "no", "sufficient", "The title explicitly teaches a requested long-term finance topic.", ["clear-positive"]),
        labeled(candidate("eval-finance-budget", "Why Most Budget Advice Fails — A Practical Framework", "Money Methods", "12:16"), "commentary", "directly_useful", "no", "sufficient", "The title signals substantive budgeting guidance despite its commentary format.", ["purpose-vs-topic"]),
        labeled(candidate("eval-finance-pump", "LIVE: This Crypto Can 100X Tonight — Buy Signal", "Moon Calls", null, { isLive: true }), "commentary", "unrelated", "yes", "sufficient", "The title explicitly promotes a crypto pump and trading signal.", ["clear-negative", "live"]),
        labeled(candidate("eval-finance-loss", "How I Lost Everything Day Trading", "Market Lessons", "19:05"), "commentary", "supporting", "no", "sufficient", "The cautionary title can support risk awareness and does not promote a signal or quick-profit scheme.", ["hard-negative", "purpose-vs-topic"]),
      ],
    },
    {
      id: "heldout-medical-evidence",
      split: "heldout",
      name: "Medical exam with evidence review",
      profile: profile(
        "Prepare for medical examinations using anatomy, physiology, and evidence-based clinical explanations.",
        ["anatomy", "physiology", "clinical reasoning", "evidence-based medicine"],
        ["medical misinformation", "celebrity wellness gossip", "gaming"],
        ["instrumental study music"],
        "focus"
      ),
      cases: [
        labeled(candidate("eval-medical-cardiac", "Cardiac Cycle Explained Step by Step for Medical Students", "Med Concepts", "18:20"), "tutorial", "directly_useful", "no", "sufficient", "The title explicitly provides step-by-step physiology instruction for medical students.", ["clear-positive"]),
        labeled(candidate("eval-medical-gossip", "Celebrity Wellness Gossip: Who Is Taking the New Detox", "Fame Health", "9:14"), "entertainment", "unrelated", "yes", "sufficient", "The title explicitly provides celebrity wellness gossip, an unwanted format.", ["clear-negative"]),
        labeled(candidate("eval-medical-debunk", "Doctor Debunks Viral Detox Misinformation — Evidence Review", "Evidence Clinic", "13:40"), "commentary", "supporting", "no", "sufficient", "The video criticizes misinformation through an evidence review instead of promoting it.", ["hard-negative", "purpose-vs-topic"]),
        labeled(candidate("eval-medical-music", "Calm Instrumental Music for Medical Study", "Study Tones", "1:20:00"), "music", "supporting", "no", "sufficient", "Instrumental study music is an explicit exception.", ["exception"]),
      ],
    },
    {
      id: "heldout-sustainable-cooking",
      split: "heldout",
      name: "Sustainable cooking habits",
      profile: profile(
        "Build affordable and nutritious cooking habits through practical recipes and reliable food guidance.",
        ["budget meal prep", "cooking techniques", "nutrition basics", "food safety"],
        ["extreme diet challenges", "food waste pranks", "restaurant gossip"],
        ["food safety recall news"],
        "balanced"
      ),
      cases: [
        labeled(candidate("eval-cooking-prep", "Five Budget Meal-Prep Recipes — Step by Step", "Everyday Kitchen", "21:05"), "tutorial", "directly_useful", "no", "sufficient", "The title explicitly teaches budget meal preparation through recipes.", ["clear-positive"]),
        labeled(candidate("eval-cooking-recall", "Food Safety Recall News: Products to Check This Week", "Safe Kitchen News", "7:31"), "news", "supporting", "no", "sufficient", "Food-safety recall news is an explicit exception and supports safe cooking.", ["exception", "news"]),
        labeled(candidate("eval-cooking-challenge", "LIVE: I Ate Only Raw Eggs for 30 Days — Extreme Diet Challenge", "Shock Meals", null, { isLive: true }), "entertainment", "unrelated", "yes", "sufficient", "The video explicitly performs an unwanted extreme diet challenge.", ["clear-negative", "live"]),
        labeled(candidate("eval-cooking-critique", "Dietitian Explains Why Extreme Diet Challenges Fail", "Nutrition Evidence", "12:44"), "commentary", "supporting", "no", "sufficient", "The title criticizes extreme diet challenges and provides relevant nutrition guidance.", ["hard-negative", "purpose-vs-topic"]),
      ],
    },
  ];

  root.FocusFeedEvalDataset = {
    version: "2026-09-20.2",
    scenarios: scenarios,
  };
})(globalThis);
