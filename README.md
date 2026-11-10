# OwnFeed

Your feed. Your rules.

OwnFeed is a Chrome extension for controlling YouTube recommendations and page
clutter. General mode hides recommendations matching your chosen topics; Focus
mode keeps matching recommendations, with an optional timer. Your wording stays
specific: movie reviews does not mean all movie content.

[Website](https://ownfeed.tech/) · [Privacy](https://ownfeed.tech/privacy) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Install the free BYOK extension

The current candidate is 0.29.2. No OwnFeed account, subscription or backend is
required. Layout controls and manual channel blocks work without AI. Topic
filtering uses your own TypeSafe/Jev key; TypeSafe charges provider usage to you.

1. Get the ZIP from [ownfeed.tech](https://ownfeed.tech/) or build it below.
2. Extract it to a folder you will keep on your computer.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**
   and select the extracted folder containing manifest.json.
4. Open OwnFeed from the toolbar. Enter your TypeSafe key and select
   **Save & check key**. This performs one small billable AI check.
5. Reload YouTube tabs. Choose topics in General or start a Focus session.

The key is kept in Chrome's trusted session storage and sent only to TypeSafe.
Re-enter it after Chrome restarts or OwnFeed reloads/updates. AI requests include
your topics and relevant YouTube video/channel text. Never include keys in
screenshots, reports or commits. See the privacy policy for details.

This is a manually installed release candidate. Chrome Web Store approval is
not claimed. YouTube changes can affect compatibility, and AI can make mistakes.
OwnFeed changes what is visible in your browser, not YouTube's underlying model.

## Build from source

Requires Python 3.11+; Windows can use `py -3` instead of `python`:

```sh
python tools/package_extension.py --check
python tools/package_extension.py
```

Extract `dist/ownfeed-0.29.2.zip` and load it unpacked. That package uses the
production TypeSafe endpoint and minimal permissions. The raw `extension/`
directory retains local/custom-server development defaults and extra development
permissions; use the packaged build to evaluate the release configuration.

## Development and verification

Requires Node.js 22.18+ for extension tests:

```sh
npm ci --prefix extension
npm test --prefix extension
python -m unittest discover -s tools -p 'test_*.py'
```

The November 10 audit found two full-suite process timeouts; see
[release evidence](docs/STORE_RELEASE.md). Passing DOM tests does not establish
current Chrome/YouTube compatibility. Use the [live checklist](docs/YOUTUBE_LIVE_TEST.md)
for filtering, navigation and Shorts.

The extension is plain JavaScript and CSS; Node dependencies are only for tests.
The optional [Python backend](backend/README.md) supports a separate development
and hosted-account architecture. It is not needed for the free BYOK release.
Historical account/Pro/Dodo documents describe that optional architecture; those
controls are absent from the current popup. Never deploy local guest mode publicly.

See [architecture](docs/ARCHITECTURE.md), [topic intent](docs/INTENT_AND_FOCUS.md)
and [website setup](landing/README.md). Website deployment uses the maintainer's
Cloudflare configuration; forks must configure their own domains and credentials.

## Support and contributions

Use
[GitHub Issues](https://github.com/alokdangre/FocusFeed/issues) for bugs and feature
requests. Security and private-data reports follow [SECURITY.md](SECURITY.md).
Do not post API keys or unredacted diagnostics. Contributions are welcome; read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

OwnFeed's original code and documentation are MIT licensed, copyright Alok Dangre.
See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md) for font,
photo, dependency and generated-artwork terms. No Google or YouTube affiliation
or endorsement is implied.
