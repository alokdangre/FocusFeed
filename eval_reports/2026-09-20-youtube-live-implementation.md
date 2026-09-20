# Bounded YouTube integration — 0.6.0

Status: implemented; Alok's real YouTube report pending.

This iteration prioritizes testing the existing workflow on real recommendations, following Alok's request. It adds a popup entry for a session tab attached to YouTube Home, rules and exact compatible live-cache routing, residual classification through the bounded scheduler, preview and opt-in reversible AI hides, per-row review/export, and explicit Load more.

The session admits 12 distinct video IDs initially. Hiding a card never refunds admission. Provider work has its own budget of three calls and 12 videos, consumed before dispatch and never refunded on failures or cancellation. Each Load more increases both limits by one allowance; the run ceiling is 120 videos and 30 calls. Existing deferred cards are admitted before another Home page is requested.

Home browse continuations are held in the MAIN-world fetch/XHR adapter. An explicit Load more releases at most one continuation when needed. The independent model budget still bounds work if a response was already in flight or YouTube introduces another pagination transport.

Live cache entries use a separate storage namespace from replay fixtures and compare exact request strings in addition to the existing compatibility signature. Only validated current provider results are stored. Cloud responses now retain pre-normalization coverage diagnostics as well.

Current explicit rules win over AI output. Reused-card metadata and run identities are checked before applying responses. Stop, navigation, settings changes, disconnect, and closing the session invalidate pending work and restore AI hides. A shared extension lock permits only one live session at once.

The prompt and local output size remain unchanged for this integration baseline. Fast rules/cache hits skip model calls; fresh semantic inference is still slow. Compact output and session reuse are subsequent experiments informed by the actual YouTube report.

Manual handoff and exact limits: [YOUTUBE_LIVE_TEST.md](../docs/YOUTUBE_LIVE_TEST.md).

Verification: all 15 extension test files and all seven backend unit tests pass. JavaScript syntax, HTML IDs and asset paths, manifest references, and `git diff --check` pass. Node doubles exercise the Home pagination transport and card adapter; actual YouTube rendering and local inference remain for Alok's manual test.
