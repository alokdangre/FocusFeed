# FocusFeed few-shot v2 analysis

Source report: `focusfeed-evaluation-1789894516881.json`

Status: **Rejected**

## Result

| Metric | Baseline v1 | Few-shot v2 | Interpretation |
| --- | ---: | ---: | --- |
| Output coverage | 100% (16/16) | 25% (4/16) | Structural regression |
| Exact match | 75.0% | 0% corrected | Invalid candidate |
| Unwanted F1 | 100% | Not defined | No positive unwanted predictions |
| False-hide rate | 8.33% | 0% | Misleading because missing outputs default visible |
| False-show rate | 0% | 100% | All four expected-hidden cases were shown |
| Wall time | 4m 34.1s | 1m 23.3s | Faster mainly because 12 outputs were missing |
| Batch p50 | 55.3s | 17.2s | Not a valid quality-equivalent speed comparison |

V2 returned exactly one assessment from every four-video request. The validator accepted that assessment and conservatively generated unknown/insufficient fallbacks for the other three videos. Across four scenarios, this produced four returned assessments and twelve missing assessments.

The original exported report displayed 6.25% exact match because one missing-output fallback happened to equal the reference labels for a vague abstention case. The scorer has been corrected: missing model output can no longer earn exact-match, field-accuracy, consistency, or abstention credit. V2's corrected exact score is 0%.

## Root cause

V2 introduced three few-shot examples, but every example contained one video and one assessment. It also set `omitResponseConstraintInput=true`, so the model did not see the full response schema in its input context. Although the system instruction requested one result per video, the worked examples repeatedly demonstrated an output array of length one.

The model copied the demonstrated structure. The faster timing therefore reflects incomplete generation, not a successful optimization.

## What v3 changes

`local-2026-09-20.2` is the next candidate:

1. One few-shot interaction now contains four input videos and four corresponding assessments.
2. The batch demonstrates a clear useful tutorial, explicit unwanted entertainment, an allowed soundscape exception, and a vague case requiring abstention.
3. The system instruction explicitly requires `assessments.length` to equal `videos.length` while preserving input order.
4. The full response schema is restored to model context.
5. Output coverage is now a first-class metric. A run below 100% coverage is marked incomplete and cannot qualify on accuracy or speed.

## Qualification order for future iterations

Evaluate every candidate in this order:

1. **Structural validity:** 100% output coverage, no unexpected IDs, and no duplicates.
2. **User safety:** false hides, false shows, and abstention behavior.
3. **Classification quality:** exact match and per-field accuracy.
4. **Performance:** wall time, batch latency, inference time, session setup, and context usage.

This prevents an incomplete but fast response from appearing to be an optimization.
