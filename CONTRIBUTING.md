# Contributing to OwnFeed

OwnFeed is a plain JavaScript Manifest V3 extension. The current release is free
and calls TypeSafe directly using the user's own key. No OwnFeed backend or
subscription is needed. Start with the [README](README.md).

## Before changing code

Search existing issues. For a substantial behavior or design change, open an
issue explaining the problem and proposed behavior before implementing it.
Keep changes focused. Preserve exact topic intent: movie reviews does not mean
all movie content. Filtering should remain reversible and usable without AI
for layout controls and manual channel blocks.

Never include API keys, .env files, personal browsing data, reviewer credentials,
Cloudflare/AWS credentials or unredacted diagnostic exports in issues or PRs.
Report vulnerabilities using [SECURITY.md](SECURITY.md).

## Local checks

Requires Node.js 22.18+ and Python 3.11+:

```sh
npm ci --prefix extension
npm test --prefix extension
python -m unittest discover -s tools -p 'test_*.py'
python tools/package_extension.py --check
```

The full extension suite currently has unresolved process timeouts in
`auto-runtime.test.js` and `shorts-filtering.test.js` (November 10, 2026 audit).
Do not describe an interrupted or timed-out run as passing. Run affected files
individually while investigating; see docs/STORE_RELEASE.md for current evidence.

If changing AI questions, follow tools/export_byok_contract.py and the backend
setup to regenerate byok-contract.js; check it matches before proposing a PR.
Live provider checks cost credits and are opt-in; automated tests must use mocks.

For UI changes, include light/dark screenshots with private data removed. For
filtering changes, include appropriate tests and results from the
[live checklist](docs/YOUTUBE_LIVE_TEST.md). DOM fixtures do not establish
compatibility with current YouTube. Load the generated ZIP unpacked to test
store permissions, rather than the development extension directory.

## Pull requests

Describe the trigger, before/after behavior, relevant tests, and remaining limits.
Do not include node_modules, generated packages, private reports, or generated
design-reference images. Contributions are licensed under the project's MIT
license, except separately licensed third-party content; see THIRD_PARTY_NOTICES.md.
