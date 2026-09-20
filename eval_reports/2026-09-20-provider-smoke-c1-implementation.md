# Local provider smoke C1 implementation report

Date: 2026-09-20  
Extension: 0.5.0  
Scheduler: scheduler-v1  
Smoke fixtures: 2026-09-20.1  
Dataset: 2026-09-20.2  
Prompt: few-shot-v4 / local-2026-09-20.3  
Status: controlled-provider gate passed from automated checks and Alok's browser export

## Purpose

C1 is the first bounded run through the real Chrome built-in AI provider and the production-intended scheduler contract. It uses 12 reviewed development cases split into three scenario profiles. Each scenario is one four-video batch, for an exact budget of three sequential provider calls and one request in flight.

The page does not alter YouTube cards, use the assessment cache, call Bedrock, or claim live-feed latency. It establishes real local-provider output coverage, semantic results, scheduler bounds, and stage timing on a small fixed workload.

## Visible test contract

- All video metadata, scenario goals, modes, expected labels, expected selected-mode decisions, expected Focus decisions, rationale, and tags are visible before the run.
- Gold labels and reviewer rationale are never included in provider requests; only the profile and video metadata are sent.
- Every actual assessment is compared over content purpose, goal relevance, unwanted match, and evidence sufficiency.
- The same assessment is evaluated under its selected scenario mode and again under Focus. This catches policy errors hidden by Balanced mode.
- Missing, duplicate, unexpected, or invalid assessment IDs cannot count as resolved output.
- Failures and stopped work remain visible and unresolved. The scheduler does not retry blindly.

## Promotion gate

The export contains explicit gate checks for completion, 12/12 validated coverage, three provider calls, 12 provider videos, queue peak at most four, in-flight peak at most one, 12/12 selected decision agreement, zero selected false hides, and zero Focus false hides. A run may finish while failing promotion; the page then shows **Gate failed** and lists the failed checks.

Exact-label agreement is reported but is not used alone as the safety decision. Provider p95, wall time, queue/provider/total scheduler distributions, session creation, inference, parsing, validation, diagnostics, events, and raw provider output are retained in the export.

## Previous baseline for these 12 cases

Recalculation from `focusfeed-evaluation-1789898627686.json` gives 10/12 exact four-field matches and 12/12 selected-mode decisions. The crypto-pump case differed only on content purpose. The cautionary day-trading loss story was labeled unrelated instead of supporting; Balanced still showed it, while the Focus counterfactual produced one false hide.

This is comparison evidence, not a required prediction for the next run. Local generation may vary. Reproducing the Focus false hide should block the promotion gate and provide a focused optimization target.

## Implemented observability and control

- Popup and replay-page links to a persistent extension tab, so closing the popup does not stop the run.
- Local-model readiness and preparation control.
- Reviewed fixture table and live per-video results.
- Live progress, current provider stage, Stop control, and completed-call table.
- Provider output diagnostics and timing split by availability, session, inference, parsing, and validation.
- Scheduler events, snapshot, bounds, queue/provider/total timing, classifier identity, environment, test set, and result records in `focusfeed-provider-smoke-report-v1`.
- Stop aborts and clears queued/in-flight scheduler work; unfinished cases are exported as `user_stop` failures and late results cannot be applied.

## Automated evidence

- All 11 extension test files pass, including scheduler stop/late-result behavior, fixture integrity, Focus counterfactual scoring, promotion-gate pass/fail behavior, and extension-surface dependency checks.
- All 7 backend unit tests pass. The logged Bedrock tracebacks are intentional mocked error-path tests.
- JavaScript syntax, HTML parsing, manifest JSON, and `git diff --check` pass.
- Browser Prompt API execution remains unverified until Alok completes the handoff below.

## Manual browser handoff C1

1. Reload the unpacked extension at `chrome://extensions`.
2. Open the FocusFeed popup and select **Open Local Provider Smoke**.
3. Confirm the page shows 12 cases, budget 3 calls / 12 videos, concurrency 1, and Local AI ready. If needed, select **Check local AI** once.
4. Review the three scenario goals and expected rows, then select **Run 12-video smoke**.
5. Keep the provider-smoke tab open. The popup may be closed. The run can take several minutes and shows its current model stage.
6. When it finishes, inspect output coverage, selected decisions, Focus false hides, provider calls, queue/in-flight peaks, provider p95, and the highlighted mismatch rows.
7. Export the JSON report whether the promotion gate passes or fails, and add it to `eval_reports/` for independent recomputation.

Expected structural result: 12/12 outputs, 3 calls, 12 provider videos, queue peak no more than 4, in-flight peak no more than 1, and no failed rows. The quality gate additionally requires 12/12 selected decisions and zero Focus false hides.

## Browser result received

`focusfeed-provider-smoke-1789933158535.json` passed every promotion check: 12/12 validated outputs, 10/12 exact labels, 12/12 selected-mode decisions, 12/12 Focus counterfactual decisions, zero false hides, three provider calls, 12 unique provider videos, queue peak four, and in-flight peak one. The previous cautionary-finance false hide did not recur. Wall time was 2m 56.3s and provider p95 was 59.3s, so latency remains unsuitable for immediate fresh-feed decisions. See `2026-09-20-provider-smoke-c1-analysis.md` for the independent recomputation and remaining live-integration boundary.
