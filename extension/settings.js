// Persistent user intent, independent of tabs and filtering runs.
(function (root) {
  "use strict";
  var KEY = "focusfeedSettingsV2";
  // Shared by the popup, in-page settings and local YouTube display policy.
  var DISPLAY_OPTIONS = [
    { key: "hideHomeFeed", label: "Hide Home Feed", description: "Hide recommendations on the YouTube home page." },
    { key: "hideVideoSidebar", label: "Hide Video Sidebar", description: "Hide the entire sidebar beside the player." },
    { key: "hideRecommended", label: "Hide Recommended", parent: "hideVideoSidebar", description: "Hide related videos beside the player." },
    { key: "hideLiveChat", label: "Hide Live Chat", parent: "hideVideoSidebar", description: "Hide live chat and chat replay." },
    { key: "hidePlaylist", label: "Hide Playlist", parent: "hideVideoSidebar", description: "Hide the playlist panel beside the player." },
    { key: "hideFundraiser", label: "Hide Fundraiser", parent: "hideVideoSidebar", description: "Hide donation and fundraiser panels." },
    { key: "hideEndScreenFeed", label: "Hide End Screen Feed", description: "Hide the recommendation wall after a video ends." },
    { key: "hideEndScreenCards", label: "Hide End Screen Cards", description: "Hide clickable video and channel cards over the ending." },
    { key: "hideComments", label: "Hide Comments", description: "Hide video comments and their preview." },
    { key: "hideMixes", label: "Hide Mixes", description: "Hide automatic Mix recommendations, keeping regular playlists." },
    { key: "hideMerchTicketsOffers", label: "Hide Merch, Tickets, Offers", description: "Hide shopping shelves, tickets and promotional offers." },
    { key: "hideVideoInfo", label: "Hide Video Info", description: "Hide the title and information below the player." },
    { key: "hideButtonsBar", label: "Hide Buttons Bar", parent: "hideVideoInfo", description: "Hide like, share and other video actions." },
    { key: "hideChannel", label: "Hide Channel", parent: "hideVideoInfo", description: "Hide the channel profile and subscribe button below the player." },
    { key: "hideDescription", label: "Hide Description", parent: "hideVideoInfo", description: "Hide the video's description." },
    { key: "hideTopHeader", label: "Hide Top Header", description: "Hide YouTube's top bar. OwnFeed stays in a floating button." },
    { key: "hideNotifications", label: "Hide Notifications", parent: "hideTopHeader", description: "Hide the notification bell." },
    { key: "hideInaptSearchResults", label: "Hide Inapt Search Results", description: "Hide unrelated search shelves such as People also watched." },
    { key: "hideExploreTrending", label: "Hide Explore, Trending", description: "Hide Explore and Trending links in the navigation guide." },
    { key: "hideMoreFromYouTube", label: "Hide More from YouTube", description: "Hide the guide's YouTube services and promotions." },
    { key: "hideSubscriptions", label: "Hide Subscriptions", description: "Hide subscription links and the guide's channel list." },
    { key: "disableAutoplay", label: "Disable Autoplay", description: "Turn off YouTube's next-video autoplay switch." },
    { key: "disableAnnotations", label: "Disable Annotations", description: "Hide annotation overlays and information-card teasers." }
  ];
  function displayDefaults(state) {
    DISPLAY_OPTIONS.forEach(function (option) { state[option.key] = state[option.key] === true; });
    return state;
  }
  function empty(mode) { return { id: mode, version: 0, mode: mode, objectives: [], sessionDurationMinutes: 45 }; }
  function migrate(prefs) {
    if (prefs[KEY] && prefs[KEY].schemaVersion === 2) return displayDefaults(Object.assign({ hideShorts: false }, JSON.parse(JSON.stringify(prefs[KEY]))));
    var legacy = prefs.activeProfile;
    var state = { schemaVersion: 2, revision: 1, enabled: prefs.enabled !== false, hideShorts: prefs.hideShorts === true,
      general: empty("general"), focus: empty("focus"), focusSession: { active: false } };
    if (legacy && legacy.mode === "focus") {
      state.focus = legacy;
      state.focusSession = prefs.focusSession || { active: false };
    } else if (legacy) state.general = legacy;
    return displayDefaults(state);
  }
  function focusActive(state, now) {
    var session = state.focusSession || {};
    return session.active === true && (!session.endsAt || Date.parse(session.endsAt) > (now || Date.now()));
  }
  function effective(state, now) { return focusActive(state, now) ? state.focus : state.general; }
  function validObjective(o) {
    if (!o || typeof o.id !== "string" || !o.id || o.id.length > 80 || typeof o.text !== "string" || !o.text.trim() || o.text.length > 160 || o.contentType !== "topic") return false;
    if (o.matchScope === "intent") return o.validationVersion === "focusfeed-intent-v1" &&
      !o.taxonomyId && !o.taxonomyVersion && (o.sourceText == null || o.sourceText === o.text);
    return (!o.matchScope || o.matchScope === "taxonomy") && !!o.taxonomyId && o.taxonomyVersion === "focusfeed-topics-v1";
  }
  function valid(profile) {
    return !!(profile && profile.version > 0 && Array.isArray(profile.objectives) && profile.objectives.length &&
      profile.objectives.length <= 12 && profile.objectives.every(validObjective) &&
      new Set(profile.objectives.map(function (o) { return o.id; })).size === profile.objectives.length &&
      new Set(profile.objectives.map(function (o) { return o.text.trim().toLowerCase(); })).size === profile.objectives.length);
  }
  function update(state, action, now) {
    var next = JSON.parse(JSON.stringify(state));
    now = now || Date.now();
    if (action.type === "saveProfile") {
      if (!valid(action.profile)) throw new Error("Confirm valid content preferences before saving.");
      var mode = action.profile.mode === "focus" ? "focus" : "general";
      next[mode] = Object.assign({}, action.profile, { mode: mode, id: mode,
        version: (Number(next[mode].version) || 0) + 1, updatedAt: new Date(now).toISOString() });
    } else if (action.type === "startFocus") {
      if (!valid(next.focus)) throw new Error("Save Focus topics first.");
      var minutes = Math.min(480, Math.max(0, Number(next.focus.sessionDurationMinutes) || 0));
      next.focusSession = { active: true, startedAt: new Date(now).toISOString(),
        endsAt: minutes ? new Date(now + minutes * 60000).toISOString() : null };
    } else if (action.type === "endFocus") next.focusSession = { active: false };
    else if (action.type === "setEnabled") next.enabled = action.enabled !== false;
    else if (action.type === "setHideShorts") next.hideShorts = action.enabled === true;
    else if (action.type === "setDisplayPreference") {
      if (!DISPLAY_OPTIONS.some(function (option) { return option.key === action.key; }) || typeof action.enabled !== "boolean") {
        throw new Error("Choose a valid YouTube display preference.");
      }
      next[action.key] = action.enabled;
    }
    else throw new Error("Unknown settings action.");
    next.revision += 1;
    return next;
  }
  root.FocusFeedSettings = { KEY: KEY, DISPLAY_OPTIONS: DISPLAY_OPTIONS, migrate: migrate, effective: effective, focusActive: focusActive,
    valid: valid, validObjective: validObjective, update: update };
})(globalThis);
