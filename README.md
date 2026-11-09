# OwnFeed

A Chrome extension that filters YouTube recommendations using your own topics.
General removes matching content; Focus keeps matching content for an optional timed
session. Topics such as “movie reviews” stay specific instead of becoming “all movies”.

## Free BYOK store release (0.29.1)

The first store release is free and uses each user's own TypeSafe/Jev API key.
No OwnFeed account, hosted backend, or payment is required. TypeSafe bills any
provider usage to the user's account. Keys stay in Chrome's trusted session
storage and must be entered again after Chrome restarts or OwnFeed reloads/updates.

Build the store candidate with `python tools/package_extension.py`. It writes
`dist/ownfeed-0.29.1.zip`, defaults to direct TypeSafe access and narrows the
permissions. Unzip that candidate into a separate folder to test the store
configuration; the source `extension/` retains local/custom-server development.
Follow [release gates](docs/STORE_RELEASE.md) and [listing copy](docs/STORE_LISTING.md).
The later hosted account/Pro implementation described below is separate from
this free BYOK release.

## Run locally

Follow [backend setup](backend/README.md#local-setup), then start the API:

```bash
bash backend/run_local.sh --local
```

Open `chrome://extensions`, enable Developer mode and load `extension/` unpacked.
Reload existing YouTube tabs after installing or updating the extension. Select
**Test without sign-in** in the extension popup to connect to the local test server.
It shows “Local testing is active” when ready; no account or subscription is needed.
Then select
**OwnFeed** beside YouTube's header actions, add comma/Enter-separated topic tags
and save. In Focus, choose a duration and select Start Focus. The panel also provides
pause/resume, Hide Shorts, channel unblocking and review of filtered videos.
Expand **YouTube layout** in either settings panel for Home, sidebar, chat,
playlist, fundraiser, end screens, comments, Mixes, shopping, video information,
header, search clutter and navigation controls, plus autoplay and annotations.
Each switch saves immediately, works in both modes and needs no classifier.
New layout options start off; pausing filtering restores hidden sections.
Hiding the header leaves a floating OwnFeed button for changing settings.
Hosted AI requires sign-in and active server-side Pro access. Account controls are
in the extension popup; free layout controls and manual blocks work signed out.
See [Stage 1 account setup](docs/ACCOUNTS_AND_ACCESS.md) for Cognito, durable storage,
operator-only beta grants, and the live verification steps still required.
See [Stage 2 usage and jobs](docs/USAGE_AND_JOBS.md) for spending caps, dynamic
operator settings, operational analytics, and service-worker recovery.
The [Dodo billing integration](docs/DODO_BILLING.md) adds hosted Pro checkout,
customer billing management, verified webhooks and periodic reconciliation.
It stays disabled until merchant configuration and live validation are complete.
Connection & more settings opens the extension preferences for the API address,
diagnostics and advanced tools. The browser popup remains available as a fallback.

## Development

The extension uses plain JavaScript and CSS; it has no production build step.
Node dependencies are only used for DOM-based tests:

```bash
npm ci --prefix extension
npm test --prefix extension
backend/.venv/bin/pip install -r backend/requirements-dev.txt
backend/.venv/bin/python -m unittest discover -s backend/tests
```

See [architecture](docs/ARCHITECTURE.md), [topic validation and Focus discovery](docs/INTENT_AND_FOCUS.md),
the [manual YouTube checklist](docs/YOUTUBE_LIVE_TEST.md), and the [page diagnostic capture](docs/YOUTUBE_DIAGNOSTICS.md). Automated DOM tests do
not verify Chrome layout or compatibility with the current live YouTube UI.

The backend is a local development service. The [deployment notes](backend/README.md#sam-blueprint)
describe what remains before exposing it publicly.
