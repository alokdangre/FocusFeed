# Cloudbreak landing direction

The user selected the original Cloudbreak artwork and requested a full landing page in the same theme. This implementation stays in a separate folder and does not alter `landing/` or `hero-explorations/`.

## Design system

- Background: cool off-white `#f8fbfc`; panels: white; Focus surface: pale blue `#e9f3fc`.
- Ink: deep blue-grey `#203f55`; muted text `#5a7083`; borders `#d9e5ee`; accent `#799cc2`.
- Type: locally hosted Instrument Serif regular/italic for display and DM Sans 400/500/600/700 for UI.
- Desktop container: 1120px, generous 24px minimum gutters. Display sizes: 112px hero, 68px section titles, 42px mode titles. Mobile: 60px hero, 46px section titles.
- Hero: exact Cloudbreak WebP, full bleed, centered crop, subtle top white wash and cool-white bottom fade. Closing section uses the selected Last Light ocean sunset with a top fade.
- Components: pill buttons, small topic chips, a single browser-style demo frame, two editorial mode panels, native disclosure FAQ, accessible native installation dialog.
- Motion: short hover/state transitions only; respect reduced motion. Content is visible without scroll-animation dependencies.

## Page structure and copy

1. `design/01-hero.png`: simple navigation and centered cloud hero. H1: A little less noise. / A little more you. Links: How it works, Your feed, Questions, Get OwnFeed. Actions: Try a calmer feed, See how it works. Supporting copy: Keep the good part of YouTube. Clear the distractions. Follow your curiosity. Leave the rabbit holes behind. Closing line: Your time is better spent on what matters.
2. `design/02-demo.png`: Same YouTube. / A different feeling. A before/after feed demo and three open process columns.
3. `design/03-modes.png`: For every kind / of attention. General and Focus panels, then local layout-control preview.
4. Pricing: Free and planned Pro access, using the existing $4.99/month figure from the older local landing page as an unconfirmed planned price.
5. `design/04-questions-close.png`: FAQ, closing CTA and simple footer, with the user-selected sunset replacing the original cloud artwork.

## Deliberate adjustments to generated concepts

- The modes image invented a second site navigation and an Add to Chrome button. Omit those to preserve the specified single navigation and honest installation flow.
- Omit invented view counts and creator claims from generated demo artwork. Use explicitly illustrative cards, descriptive categories, and local stock thumbnails. The space video explains the science behind a movie so that hiding movie reviews visibly preserves other movie-related content.
- General and Focus controls operate the illustrative feed. A running focus session has pause/resume and end controls. Layout switches change a compact local page preview, not the visitor's real YouTube.
- The hero prompt's extra small 'Made for YouTube' line was absent in the generated composition; follow the composition and omit it.
- Get OwnFeed opens local-install instructions and a current extension-source ZIP; no store listing, launched subscription, user count, or launch date is invented.
- Native mobile navigation and dialog controls are necessary responsive/accessibility continuations of the chosen design.

Generated concept images are local design references. Do not stage, commit, or publish the `design/` folder without an explicit request.
