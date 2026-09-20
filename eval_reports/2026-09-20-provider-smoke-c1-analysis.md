# Local provider smoke C1 analysis

Date: 2026-09-20  
Source: `focusfeed-provider-smoke-1789933158535.json`  
Schema: focusfeed-provider-smoke-report-v1  
Fixture: 2026-09-20.1  
Dataset: 2026-09-20.2  
Scheduler: scheduler-v1  
Workflow: workflow-v1.1  
Classifier: chrome-gemini-nano / few-shot-v4 / local-2026-09-20.3  
Conclusion: C1 controlled-provider gate passed; live YouTube semantic integration remains disconnected

## Independent verification

The report was recomputed from its test-set snapshot and records rather than trusting its displayed summary. The report versions match the current fixtures. Its 12 record IDs, 12 provider video IDs, and three ordered scenario batches exactly match the fixed smoke set, with no duplicate or unexpected ID.

All three raw structured outputs parse successfully. Each contains exactly the four requested IDs in input order. Every call reports four requested, four returned, four accepted, zero missing, zero duplicate, and zero unexpected assessments.

Policy decisions, exact-label flags, false-hide flags, report summary, promotion checks, event counts, and timestamps were recomputed independently and match the export.

## Quality result

| Metric | Result |
| --- | ---: |
| Validated output coverage | 12/12 (100%) |
| Exact four-field agreement | 10/12 (83.3%) |
| Selected-mode decision agreement | 12/12 (100%) |
| Focus counterfactual agreement | 12/12 (100%) |
| Selected-mode false hides / false shows | 0 / 0 |
| Focus false hides / false shows | 0 / 0 |
| Failed or unresolved cases | 0 |

The previous finance-loss false hide did not recur. The model labeled the cautionary day-trading story as `supporting` and `unwantedMatch=no`, matching the reference under both Balanced and Focus.

Two non-decision label mismatches remain:

1. `eval-design-figma`: goal relevance was `directly_useful`; the reference is `supporting`. Both policies show it.
2. `eval-finance-pump`: content purpose was `entertainment`; the reference is `commentary`. Goal relevance and unwanted match still produce the expected hide.

These are useful taxonomy-review cases but are not current feed-action failures. Do not tune the prompt only to raise strict exact agreement without first deciding whether the reference boundaries are sufficiently objective.

## Workflow integrity

The scheduler event sequence contains 12 `queued`, three `batch_started`, 12 `result_applied`, three `batch_completed`, and two `context_changed` events. It contains no item/provider failure, deferral, abort, stale-result, or validation-rejection event.

The run used exactly three provider requests and 12 unique provider videos. Peak waiting depth was four and peak in-flight requests was one. Every promotion check is true.

## Latency result

| Measurement | Result |
| --- | ---: |
| Wall clock | 176.3 s (2m 56.3s) |
| Provider call totals | 57.7 s, 59.3 s, 59.3 s |
| Provider p95 | 59.3 s |
| Average call | 58.8 s per four videos |
| Session creation | 14.9 s, 6.2 s, 6.4 s |
| Inference | 42.8 s, 53.1 s, 52.8 s |
| Effective throughput | 0.068 videos/s, or 14.7 s/video in four-video batches |

Inference consumed 148.7 s, about 84.3% of wall time. Session creation consumed 27.6 s, about 15.6%. The first session had an additional cold-start cost, but inference is still the main bottleneck.

For the same three scenarios in the earlier v4 evaluation, provider calls totaled 148.3 s; this run totaled 176.3 s, 18.9% slower. Session time was nearly unchanged while inference time was 23.5% higher. A single comparison does not establish a regression, but it demonstrates runtime variability and rules out a seconds-scale fresh semantic decision claim.

Queue wait was zero because each fixed group was enqueued and flushed immediately after the previous group completed. It does not predict queue delay during scrolling.

## What this qualifies

C1 establishes that the real local provider can satisfy the fixed batch-output contract through the bounded scheduler, produce safe decisions on this 12-case development smoke, expose full diagnostics, and finish without lifecycle or output-integrity faults.

It does not establish current quality on a real YouTube feed, selector/card identity correctness, provider ownership across page lifecycle, assessment-cache use, scroll-burst queue age, DOM application safety, broad held-out quality, or useful interactive latency. Automatic semantic hiding remains blocked until a real-feed shadow path is implemented and reviewed.

## Next checkpoint

Implement a shadow-only YouTube integration using the shared router, persistent cache, bounded scheduler, and selected-provider bridge. It must keep semantic decisions visible as proposals, revalidate card/video/profile identity before recording a result, expose pending/failure/latency metrics, and export user-reviewed real-feed samples. The first handoff should classify only 8-12 visible recommendations. Compact-output and reusable-session experiments should then use this C1 run as their controlled baseline before a larger 30-50 recommendation shadow trial.
