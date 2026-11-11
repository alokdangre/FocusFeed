# OwnFeed

Choose what appears on YouTube. Hide topics in General mode, keep selected
interests in Focus mode, block channels, and turn off distracting page elements.
A topic like “movie reviews” stays specific instead of becoming “all movies”.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/ownfeed/hibmnchhhcdgajolcmodedpmfcjjbmbg) ·
[Website](https://ownfeed.tech/) · [Privacy](https://ownfeed.tech/privacy)

## Get started

Install OwnFeed, open its toolbar popup, and choose your settings. Layout controls
and manual channel blocks work immediately. For AI topic filtering, enter your
own TypeSafe/Jev API key and select **Save & check key**, then refresh YouTube.

OwnFeed is free. TypeSafe bills AI usage to your provider account; the key check
also makes one small billable request. No OwnFeed account or backend is required.
The key stays in Chrome's trusted session storage and must be re-entered after
Chrome restarts or the extension reloads/updates. Relevant topic and video/channel
text goes directly to TypeSafe. See the privacy policy for details.

## Build from source

Requires Python 3.11+ (`py -3` on Windows):

```sh
python tools/package_extension.py --check
python tools/package_extension.py
```

Extract the ZIP in `dist/`, open `chrome://extensions`, enable Developer mode,
and load the extracted folder. Use this package to test the release configuration;
the raw `extension/` directory retains local-server development defaults.

## Development

The extension is plain JavaScript and CSS. Node.js 22.18+ is used for DOM tests:

```sh
npm ci --prefix extension
npm test --prefix extension
python -m unittest discover -s tools -p 'test_*.py'
```

- `extension/` — extension source and tests.
- `landing/` — ownfeed.tech website; see its [README](landing/README.md).
- `backend/` — optional development API and canonical AI prompts; see its [README](backend/README.md).
- `tools/` — packaging, icon generation, diagnostics and prompt export.

The store extension calls TypeSafe directly. The optional backend is only needed
for backend development or regenerating the shared AI prompt contract.

## Contributing and support

Open an [issue](https://github.com/alokdangre/FocusFeed/issues) for bugs or feature
requests. Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes and
[SECURITY.md](SECURITY.md) for private vulnerability reports. Never post API keys
or unredacted diagnostics.

## License

[MIT](LICENSE). Fonts, photos and other third-party materials retain their own
terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

OwnFeed is independent of Google and YouTube. AI filtering can make mistakes,
and YouTube changes can affect compatibility.
