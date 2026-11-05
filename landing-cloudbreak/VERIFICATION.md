# Cloudbreak landing verification

Verified locally on 2026-11-02. Browser/IAB tools were unavailable, so verification used Playwright with an already installed Chromium headless shell. No browser installation was necessary.

## Functional checks

Passed at viewport widths 1536, 1440, 768, 390, and 320 pixels:

- All images loaded, all local assets resolved, no horizontal overflow, no page errors, and no external runtime network requests.
- Before/after changes six illustrative videos to four; individual topic buttons correctly restore or hide matching cards.
- Hiding movie reviews preserves the Interstellar science video.
- Focus start shows only the guitar video; countdown advances using elapsed time; pause/resume/end update both the timer and demo.
- Each of the three layout switches changes its associated preview region.
- FAQ disclosures open; desktop and mobile installation dialogs open and close; closing the mobile dialog restores focus to the visible Menu control.
- The developer ZIP downloads under the expected filename. Its manifest entrypoints resolve inside the archive.
- Reduced-motion preference disables smooth scrolling and transition motion.

The original landing and hero gallery were checked with SHA-256 snapshots: all 18 files are unchanged.

## Visual comparison ledger

The four concepts in `design/` and the corresponding latest Chromium screenshots were opened with `view_image`. Native concept dimensions: hero 1536 × 1024, demo 1422 × 1106, modes 1435 × 1096, FAQ/closing 1073 × 1466. Mobile views were additionally inspected at 390 and 320 pixels wide.

| Comparison | Result / adjustment |
| --- | --- |
| Hero wording and hierarchy | Main headline, supporting copy, navigation, primary/secondary actions, and final line match the specified copy list. No extra hero eyebrow. |
| Typography | Local Instrument Serif regular/italic and DM Sans preserve the display/UI relationship; increased feed title and control sizes after screenshot review. |
| Palette and background | Preserved blue-grey ink, cool off-white sections, pale blue Focus panel, and warm light within the original photo. Adjusted the top white wash to better match the hero concept. |
| Image framing and transitions | Original Cloudbreak image reused for opening/closing with CSS fades. Fixed a Focus preview image retaining its HTML height; it now uses an explicit 128px crop. |
| Layout and section order | Hero → feed/process → modes/layout controls → FAQ → closing/footer. A consistent 1120px content container interprets the concept's intended desktop margins. |
| Interaction/accessibility | Fixed a decorative switch layer intercepting checkbox input. Fixed mobile dialog focus restoration to the visible Menu summary. |
| Mobile continuation | Stacked mode/FAQ layouts and two-column video thumbnails fit 320px; adjusted the closing headline to retain its two-line composition. |
| Honest product details | Replaced invented generated metrics and creators with illustrative categories; used local stock thumbnails in the same photographic roles. Get FocusFeed opens developer-preview instructions instead of an unverified store listing. |

The implementation was visually verified against the Cloudbreak direction and section concepts. It is a responsive implementation, not a claim of pixel identity to generated mockups. Intentional deviations are listed above and in `DESIGN.md`; no unresolved layout or interaction defects were found in the checked states.

The local QA runner and screenshots are temporary artifacts outside this project. Automated website checks do not establish live YouTube compatibility or deployment readiness.
