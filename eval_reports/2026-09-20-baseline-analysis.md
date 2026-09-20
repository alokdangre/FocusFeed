# FocusFeed local classifier baseline analysis

Source report: `focusfeed-evaluation-1789893371682.json`

Follow-up: few-shot v2 was rejected after its separate report showed 25% output coverage. Few-shot v3 passed development but failed held-out safety with one false hide. See `2026-09-20-few-shot-v2-analysis.md` and `2026-09-20-few-shot-v3-heldout-analysis.md`. The current candidate is few-shot v4 (`local-2026-09-20.3`) on dataset `2026-09-20.2`.

## What the evaluator measures

Each scenario contains one goal profile and four video candidates. The classifier receives only the profile and candidate metadata. Reference labels, notes, tags, and expected feed decisions remain in the evaluator.

Every prediction is compared across four fields:

1. `contentPurpose`: what kind of content it is.
2. `goalRelevance`: whether the content directly advances, supports, or is unrelated to the current goal.
3. `unwantedMatch`: whether metadata positively matches an unwanted topic.
4. `evidenceSufficiency`: whether the supplied metadata is enough to decide.

Exact match requires all four fields to match. The deterministic feed policy is scored separately because a label mismatch does not always produce a harmful display decision:

- Insufficient evidence remains visible.
- Explicit unwanted content is hidden.
- In Focus mode, sufficiently evidenced unrelated content is hidden.
- Other content remains visible.

False hides are the primary safety metric because they remove content the reference policy would show. False shows measure distractions the policy should hide. Unwanted-topic precision, recall, and F1 isolate preference matching from broader goal relevance.

Development data is used for prompt changes. Held-out data is reserved until a prompt candidate has been chosen. A candidate is compared only against a run with the same dataset version, split, and repeat count.

## Baseline result

The baseline used `local-2026-09-18.1` with Chrome's built-in Gemini Nano model.

| Metric | Baseline |
| --- | ---: |
| Exact match | 75.0% (12/16) |
| Content-purpose accuracy | 81.25% |
| Goal-relevance accuracy | 81.25% |
| Unwanted accuracy | 93.75% |
| Unwanted precision / recall / F1 | 100% / 100% / 100% |
| Evidence-sufficiency accuracy | 100% |
| False-hide rate | 8.33% (1/12 expected-visible predictions) |
| False-show rate | 0% |
| Abstention recall | 100% |
| Unnecessary-abstention rate | 6.67% |

The four mismatched cases were:

| Case | Failure |
| --- | --- |
| `eval-interview-vague` | Correctly marked evidence insufficient, but returned `other` and `no` instead of making all uncertain fields `unclear`. |
| `eval-upsc-music` | Recognized the instrumental-music exception in its reason but returned relevance `unclear` instead of `supporting`. |
| `eval-design-figma` | Interpreted a product-feature update as a directly useful tutorial instead of release news allowed as a supporting exception. This is the most taxonomy-sensitive reference label and should be reviewed when inspecting future disagreements. |
| `eval-english-rain` | Failed to apply the explicit rain-sounds exception, classified the soundscape as `other`, and produced the only false hide. |

Three of four failures involve exception semantics. The vague-title failure is an internal consistency issue: the explanation says there is not enough information, while two categorical fields still make decisive claims.

## Timing result

| Timing | Baseline |
| --- | ---: |
| Evaluation wall time | 274,135 ms (4m 34.1s) |
| Sum of classifier calls | 274,122 ms |
| Inference | 254,076 ms (92.7% of wall time) |
| Session creation | 20,023 ms (7.3% of wall time) |
| Availability checks | 17 ms |
| Parsing and validation | 1 ms |
| Batch p50 | 55,289 ms |
| Batch p95 | 84,246 ms |

The first session creation took 15,451 ms; later sessions took 1,349–1,851 ms. Model inference is the main bottleneck, ranging from 50,213 to 82,890 ms per four-video scenario. Parser, validator, UI, and evaluator overhead are negligible.

## First candidate change (v2, later rejected)

The first candidate `local-2026-09-20.1` kept one model call per scenario and added three compact few-shot examples:

- A vague title that must use all `unclear` labels with insufficient evidence.
- An explicit ambient-audio exception that must be `supporting` and not unwanted.
- A design-tool feature update treated as release news and a supporting exception.

The rubric now defines exceptions, vague metadata, soundscapes, release news, and directly-useful versus supporting content explicitly. Candidate output is constrained to at most three topics and one evidence phrase, while the prompt asks for a one-sentence reason. It also keeps the response schema out of the model input because the few-shot examples already demonstrate the output shape. This targets context and output-generation latency without removing the explanation needed by users.

## Acceptance rules

Use the development split for the candidate run. Accept the candidate for held-out verification only if:

- False hides decrease from 8.33%, preferably to zero.
- Unwanted F1 remains at 100%.
- Exact match improves without reducing evidence-sufficiency accuracy or abstention recall.
- No new high-risk failure category appears.
- Added few-shot context does not cause a large latency regression. A latency increase above 10% needs a clear quality gain to be acceptable.

If the candidate misses these gates, revise the prompt from the new failure groups and run Development again. Do not inspect Held-out during this loop.

## Workflow decision

A multi-agent or unconditional second-model-pass workflow is not justified by this baseline. Inference already consumes 92.7% of evaluation time, so another complete pass would add roughly 50–84 seconds per scenario.

The current workflow is intentionally bounded:

1. Construct a request without reference-label leakage.
2. Run one schema-constrained local-model classification.
3. Normalize IDs and fill missing results conservatively.
4. Apply deterministic display policy.
5. Score labels, user-impact decisions, consistency, and latency.

A selective adjudication pass should be considered only if the few-shot candidate leaves a small number of uncertain or internally inconsistent predictions. It must run only on those cases and must demonstrate a measured quality gain larger than its latency cost.
