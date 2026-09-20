# Few-shot v4 development review

Source: `focusfeed-evaluation-1789898627686.json`.
Prompt: `local-2026-09-20.3`; dataset: `2026-09-20.2`; one repeat; 24 development cases.

Status: development measured; not qualified for real-time feed classification. Next priority is the routing workflow and its performance evaluation.

## Verification and result

Recomputed all stored metrics using the scorer. Separately checked saved inputs, profile modes, reference labels, exact agreement, and show/hide actions against the report's test-set snapshot with an independent calculation. Both agree with the exported result. This verifies arithmetic and input integrity; it does not independently establish the correctness of subjective reference labels.

| Measurement | Result |
| --- | ---: |
| Returned / requested assessments | 24 / 24 |
| Missing / duplicate / unexpected IDs | 0 / 0 / 0 |
| Strict exact match | 20 / 24 (83.33%) |
| Purpose agreement | 21 / 24 (87.5%) |
| Goal relevance agreement | 23 / 24 (95.83%) |
| Unwanted / evidence agreement | 24 / 24 for each |
| Feed decisions matching references | 24 / 24 |
| False hides / false shows | 0 / 0 under the recorded modes |
| Full evaluation wall time | 291,929 ms (4m 51.9s) |
| Batch average / p50 / p95 | 48,653 / 48,330 / 54,606 ms |
| Inference time | 246,421 ms (84.4% of wall time) |
| Session creation time | 45,462 ms (15.6% of wall time) |

The percentile figures describe six batches, not a stable estimate of real-feed tail latency. No queue, DOM update, cache, or real-video arrival delay is included. Inference measurements are for this user's Chrome local model, not Bedrock.

## Every mismatch

| Case | Expected | Actual | Consequence |
| --- | --- | --- | --- |
| `eval-upsc-rights` | purpose=tutorial | purpose=commentary | Show in both; purpose regression versus v3 |
| `eval-run-diet` | purpose=commentary | purpose=entertainment | Hide in both; subjective purpose boundary |
| `eval-finance-pump` | purpose=commentary | purpose=entertainment | Hide in both; purpose disagreement |
| `eval-finance-loss` | relevance=supporting | relevance=unrelated | Show in recorded Balanced mode; Focus policy would hide the actual assessment |

The finance result improved unwantedMatch from yes to no, fixing the recorded Balanced-mode false hide. Its relevance remains wrong. A policy replay under Focus yields expected show versus actual hide. This counterfactual is not an additional model run; a rerun with a changed mode might produce a different assessment. Add mode-paired cases to development before promotion and keep variants of each video in the same split.

## Comparison limits

The old v3 development run had 16 cases, so comparing 83.33% against 93.75% directly is misleading. On the original 16-case subset, v4 also scores 15/16, with a different remaining error. Its four corresponding calls total 201,042 ms versus v3's 196,995 ms for those calls: no material measured speed improvement.

Combining v3's separate development and consumed held-out records gives 18/24 exact and 23/24 decisions. V4 gives 20/24 and 24/24 on those same cases. This is a descriptive regression comparison after tuning on the old failures, not an unseen generalization result. Historical reports and labels remain unchanged.

## Latency conclusion

At the observed sequential throughput, 24 / 291.929 is approximately 0.082 videos per second. A naive extrapolation for 100 fresh videos is about 20 minutes. Actual live throughput can differ, but the measured path clearly cannot keep up with a fast-scrolling feed.

Removing every session-creation millisecond would still leave about 41 seconds of inference per four-video batch. Session reuse is worthwhile but insufficient. We must avoid calls, reduce generated output, prioritize useful work, and measure provider throughput.

Rules and cache help only when applicable. Cache starts cold; explicit rules do not resolve every semantic preference. Even 90% avoidance among 100 fresh candidates leaves ten model jobs, roughly two minutes at current throughput. Do not promise seconds-scale semantic completion from a cache layer alone.

Next work is specified in `docs/WORKFLOW_AND_LATENCY_PLAN.md`. No v5 prompt or new live routing behavior is introduced in this review. The iteration panel now displays these measured findings instead of "Not evaluated yet."
