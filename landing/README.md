# OwnFeed — Cloudbreak landing page

A self-contained landing page based on the selected Cloudbreak artwork. This directory contains the source for `https://ownfeed.tech/`.

## Preview

Open `index.html` directly in a browser. All runtime images and fonts are local, and no installation or build is required. For HTTP preview, run from the repository root:

```sh
python -m http.server 4174 --bind 127.0.0.1 --directory landing
```

Then visit http://localhost:4174.

## Structure and behavior

1. Full-width Cloudbreak hero with editorial typography and the first action leading to the demo.
2. Interactive before/after feed: enable or disable two example hidden topics. “Movie reviews” does not remove the science video about Interstellar.
3. Three short explanation steps.
4. General and Focus panels with a working 25-minute local timer, pause/resume/end, and an example feed that follows the selected mode.
5. Local preview controls for hiding Shorts, comments, and recommendations.
6. Free and planned Pro pricing, followed by a disclosure FAQ.
7. Last Light ocean sunset closing section with the footer blended into the image.
8. Accessible coming-soon dialog; public extension downloads are not available.

The feed, video titles, durations, and timer are illustrative. This site does not read a visitor's YouTube feed, run the classifier, or change extension settings. The $4.99/month Pro figure is marked as planned, taken from the older local landing page; the billing product and actual price are not yet configured. Checkout is not available.

## Files

- `index.html`, `styles.css`, `script.js`: semantic, buildless page.
- `privacy.html`, `terms.html`, `legal.css`: linked policy pages for the developer preview. They use the owner's personal email temporarily; the account deletion process, cancellation and refund terms need to be finalized before public launch.
- `assets/cloudbreak.webp` and `assets/last-light.webp`: the selected generated hero and footer images, copied without regenerating them.
- `assets/fonts/`: locally hosted Instrument Serif and DM Sans, with OFL licenses.
- `assets/sources.json`: provenance for fonts, imagery, and the illustrative thumbnail photos.
- Extension ZIP archives are excluded from the website source assets and deployment. Installation availability is described in the FAQ without a public download.
- `DESIGN.md`: design tokens, structure, and intentional adjustments to the generated concepts.
- `design/`: four generated section concepts, kept locally as visual references. Do not stage, commit, or publish them without an explicit request.
- `VERIFICATION.md`: functional and visual verification notes.
- `robots.txt`, `sitemap.xml`, `llms.txt`, `about.md`, `_headers`: crawler discovery, product facts, and content-type rules. See `SEO.md` for verification and launch steps.

## Verification boundary

The initial website was tested locally in headless Chromium at desktop, tablet, and phone sizes on 2026-11-02. The 2026-11-04 footer, pricing, and motion updates have DOM interaction checks but still need visual browser review. Neither check verifies the extension on live YouTube, authenticated provider calls, or payments. On 2026-11-05, the SEO changes and removal of public extension downloads were deployed and checked over HTTP on both public domains. See `SEO.md` for evidence and remaining search-console steps.

## Cloudflare Workers build

Run `npm ci` and `npm run build` with Node.js 24.22.2. The build copies an explicit list of website assets into `.site-public/`, then generates Cloudflare Build Output, including the crawler files. `npm run deploy` deploys that output to the existing `old-credit-48dd` Worker. This Worker serves `ownfeed.tech` and `www.ownfeed.tech`; the configuration retains both custom domains.

For Workers Builds, use `landing` as the root directory, `npm run build` as the build command, `npm run deploy` as the deploy command, and set `NODE_VERSION` to `24.22.2`. Only connect production builds after this directory and its runtime assets are present in the selected GitHub branch.
