# FocusFeed few-shot v3 held-out analysis

Source report: `focusfeed-evaluation-1789897743605.json`

Status: **Needs revision; not production-qualified**

## Verified result

The stored metrics exactly match an independent recomputation from all eight raw records.

| Metric | Held-out result | Interpretation |
| --- | ---: | --- |
| Output coverage | 100% (8/8) | Structurally reliable |
| Strict exact match | 37.5% (3/8) | Five cases differ on at least one label |
| Decision accuracy | 87.5% (7/8) | One show/hide decision is wrong |
| Purpose accuracy | 50% | Four purpose disagreements |
| Relevance accuracy | 87.5% | One supporting/unrelated error |
| Unwanted accuracy | 87.5% | One false unwanted match |
| Unwanted F1 | 80% | Recall 100%, precision 66.7% |
| False-hide rate | 16.7% (1/6 expected shows) | Safety failure |
| False-show rate | 0% (0/2 expected hides) | No unwanted case escaped |
| Abstention recall | 100% | The vague case remained visible |
| Wall time | 1m 41.9s | Two four-video calls |
| Batch p50 / p95 | 44.7s / 57.2s | Local inference remains slow |

All eight assessments were returned and accepted. There were no missing, duplicate, or unexpected IDs.

## Case audit

### Real feed-decision failure

`eval-finance-loss`, "How I Lost Everything Day Trading":

- Expected: `commentary`, `supporting`, `unwanted=no`, resulting in **show**.
- Actual: `commentary`, `unrelated`, `unwanted=yes`, resulting in **hide**.

The profile rejects "day-trading signals," not every mention of day trading. The title describes a loss and does not promote a signal or quick-profit scheme. The model broadened a targeted unwanted preference into a keyword block. This is a genuine false hide and the main reason v3 does not qualify.

### Clear rubric inconsistency without a decision error

`eval-run-vague`, "A Big Announcement Tomorrow": the model correctly returned unclear relevance, unclear unwanted match, and insufficient evidence, but used `contentPurpose=other`. The prompt requires all four uncertainty labels together when metadata cannot establish the subject or purpose, so `contentPurpose=unclear` was expected. It still resulted in **show**.

### Ambiguous purpose boundaries

Three mismatches do not establish a clear semantic failure from title-only metadata:

- `eval-run-diet`: expected commentary; actual entertainment.
- `eval-finance-budget`: expected commentary; actual tutorial.
- `eval-finance-pump`: expected commentary; actual entertainment.

These categories overlap for the supplied titles, and `contentPurpose` does not control the current show/hide policy. Strict exact match therefore understates the operational result. The labels remain unchanged in this completed report to preserve the held-out audit.

## Evaluation changes required

Future reports should present decision accuracy beside strict exact match. Before another final evaluation, the purpose taxonomy needs mutually exclusive definitions or pre-declared acceptable alternatives for genuinely ambiguous cases.

V3 must not be tuned and rerun against this same held-out set as if it were unseen. For v4, these cases become development evidence, and a new held-out set must be labeled and frozen before running the new prompt.
