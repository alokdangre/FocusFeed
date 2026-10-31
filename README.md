# FocusFeed

A Chrome extension that filters YouTube recommendations using your own topics.
General removes matching content; Focus keeps matching content for an optional timed
session. Topics such as “movie reviews” stay specific instead of becoming “all movies”.

## Run locally

Follow [backend setup](backend/README.md#local-setup), then start the API:

```bash
bash backend/run_local.sh
```

Open `chrome://extensions`, enable Developer mode and load `extension/` unpacked.
Reload existing YouTube tabs after installing or updating the extension. Select
**FocusFeed** beside YouTube's header actions, add comma/Enter-separated topic tags
and save. In Focus, choose a duration and select Start Focus. The panel also provides
pause/resume, Hide Shorts, channel unblocking and review of filtered videos.
Connection & more settings opens the extension preferences for the API address,
diagnostics and advanced tools. The browser popup remains available as a fallback.

## Development

The extension uses plain JavaScript and CSS; it has no production build step.
Node dependencies are only used for DOM-based tests:

```bash
npm ci --prefix extension
npm test --prefix extension
backend/.venv/bin/python -m unittest discover -s backend/tests
```

See [architecture](docs/ARCHITECTURE.md), [topic validation and Focus discovery](docs/INTENT_AND_FOCUS.md),
the [manual YouTube checklist](docs/YOUTUBE_LIVE_TEST.md), and the [page diagnostic capture](docs/YOUTUBE_DIAGNOSTICS.md). Automated DOM tests do
not verify Chrome layout or compatibility with the current live YouTube UI.

The backend is a local development service. The [deployment notes](backend/README.md#sam-blueprint)
describe what remains before exposing it publicly.
