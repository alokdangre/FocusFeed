# FocusFeed few-shot v3 development analysis

Source report: `focusfeed-evaluation-1789897231586.json`

Status: **Development passed; prompt frozen for held-out evaluation**

## Result

The stored report and an independent recomputation from its raw case records agree.

| Metric | Baseline v1 | Few-shot v3 | Change |
| --- | ---: | ---: | ---: |
| Output coverage | 100% (16/16) | 100% (16/16) | No regression |
| Exact match | 75.0% | 93.75% | +18.75 percentage points |
| Purpose accuracy | 81.25% | 100% | +18.75 percentage points |
| Relevance accuracy | 81.25% | 93.75% | +12.5 percentage points |
| Unwanted F1 | 100% | 100% | Unchanged |
| False-hide rate | 8.33% (1) | 0% (0) | One harmful decision removed |
| False-show rate | 0% (0) | 0% (0) | Unchanged |
| Abstention recall | 100% | 100% | Unchanged |
| Wall time | 4m 34.1s | 3m 17.0s | 1m 17.1s faster (28.1%) |
| Batch p50 | 55.3s | 45.9s | 9.4s faster (17.0%) |
| Batch p95 | 84.2s | 61.5s | 22.8s faster (27.1%) |

V3 returned and accepted every requested assessment. It produced no missing assessments, duplicates, or unexpected video IDs.

The inference portion fell from 254.1 seconds to 159.9 seconds. Session creation rose from 20.0 seconds to 37.1 seconds; v3's longer initial context is a likely contributor. V3's normalized outputs were also more compact: approximately 4,879 serialized characters versus 6,475 for baseline. This is consistent with, but does not by itself prove, why inference became faster.

## Only mismatch

`eval-design-figma` was labeled `supporting`, while the model returned `directly_useful`:

- Goal: improve product-design skills through interaction patterns, research methods, and accessible interfaces.
- Useful topics: UX research, interaction design, accessibility, and design systems.
- Exception: software release news for design tools.
- Video: "Figma's New Prototyping Features Explained."

The reference label treats release news as an auxiliary exception. The model treated an explanation of prototyping features as direct skill instruction. Both produce `show` in Balanced mode, so this caused no feed-decision error.

This is a real boundary ambiguity rather than a clear safety failure. The reference label remains unchanged for this report. Changing it after seeing the prediction would artificially improve the score. A future dataset version should add several independently reviewed cases around product news versus instruction and define the boundary more sharply.

## Why v3 is frozen

V3 meets the requirements to proceed to held-out evaluation:

1. 100% structural coverage with no ID integrity errors.
2. Zero false hides and zero false shows.
3. Better exact and per-field accuracy than baseline.
4. Better wall, p50, p95, and inference time than baseline on the same split.

The exact prompt is now frozen. It must not be edited after inspecting held-out cases. The next valid experiment is one run on the held-out split with one repeat. Repeat consistency remains unmeasured and should be evaluated separately if time permits.
