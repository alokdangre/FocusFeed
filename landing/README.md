# OwnFeed website

Static HTML, CSS and JavaScript for https://ownfeed.tech. Install links point to
the official Chrome Web Store listing. The interactive feed is an illustrative
demo; it does not access a visitor's YouTube account.

## Preview

```sh
python -m http.server 4174 --bind 127.0.0.1 --directory landing
```

Open http://localhost:4174. Runtime images and fonts are local.

## Build and test

From this directory, using Node.js 22.18+:

```sh
npm ci
npm run build
python -m unittest discover -s tests
```

The build copies an explicit static-file allowlist into .site-public/ and creates
Cloudflare Build Output. It does not publish extension ZIPs or repository files.
Discovery tests check structured data, canonical URLs, store availability and
crawler files. They also work against the built output via OWNFEED_SITE_DIR.

## Deploy

```sh
npm run deploy
```

This uses Cloudflare's cf CLI and the existing cloudflare.config.ts. Authentication
and permission to deploy the configured Worker are required. Forks must configure
their own Worker and domains. For Workers Builds, use landing as the root,
`npm run build` as the build command and `npm run deploy` as the deploy command.

Image/font provenance is recorded in assets/sources.json; retain the font licenses.
