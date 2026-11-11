# Contributing

Open an issue before substantial changes. Keep pull requests focused: describe
the problem, resulting behavior and relevant verification. Include light/dark
screenshots for UI changes, with keys and personal information removed.

## Setup and checks

Use Node.js 22.18+ and Python 3.11+:

```sh
npm ci --prefix extension
npm test --prefix extension
python -m unittest discover -s tools -p 'test_*.py'
python tools/package_extension.py --check
```

If a test process times out, report it rather than treating it as a pass.
The previous suite run had timeouts in auto-runtime.test.js and
shorts-filtering.test.js; include results from affected tests in your PR.

For AI question changes, use the backend setup and tools/export_byok_contract.py
to regenerate extension/byok-contract.js. Automated tests use mocks; live provider
checks are opt-in and consume credits.

## Manual verification

Load the generated ZIP unpacked in Chrome. Check General and Focus topics,
start/end the Focus timer, edit topics while browsing, and test Home, Watch,
Search, Shorts and back navigation. Verify Shorts remain filtered when scrolling
both directions. Check pausing, key removal and provider failures. Local DOM
tests do not establish compatibility with current YouTube.

Preserve exact topic intent: movie reviews does not mean all movie content.
Layout controls and manual channel blocking must remain usable without AI.

Do not commit credentials, dependency trees, generated packages, browsing data,
internal notes or design references. Follow SECURITY.md for vulnerabilities.
Contributions use the project's MIT license, with third-party exceptions listed
in THIRD_PARTY_NOTICES.md.
