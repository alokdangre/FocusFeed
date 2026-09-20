# Workflow B1 implementation report

Date: 2026-09-20  
Extension: 0.4.0  
Scheduler: scheduler-v1  
Lifecycle fixtures: 2026-09-20.1  
Status: qualified from automated checks and Alok's browser lifecycle export

## A1 reports reviewed

- Persisted replay: 24/24, 10 rule, 2 cache, 11 model-pending, 1 metadata-unresolved, 0 false hides, 12.8 ms persistent read.
- Empty-store negative control: 22/24; only `cached-balanced` and `cached-focus` missed as intended.
- Cold replay: 24/24, 10 rule, 0 cache, 13 model-pending, 1 metadata-unresolved, 0 false hides.

The real YouTube format-selector check is deferred at Alok's request. It remains required before enabling semantic hiding on live cards.

## Implemented scheduler contract

- Queue cap of 24 unique waiting candidates with priority replacement and visible deferral.
- One in-flight request by default, configurable batch size, and a batching window for automatic dispatch.
- One semantic request shared by repeated card subscribers.
- Existing work is promoted when a visible higher-priority subscriber joins.
- Subscriber removal without canceling work still needed by another current card.
- Goal-context changes abort and invalidate old queued/in-flight work.
- Pause aborts current provider work and requeues current subscribers; resume continues them.
- Per-request timeout with no automatic retry.
- Exact requested-ID coverage checks; missing, duplicate, unexpected, and custom-invalid assessments cannot become successful results.
- Queue, provider, and total timing samples reported separately.
- Observable state events and bounded snapshot metrics.

## Visible lifecycle scenarios

1. A 100-card burst with 70 duplicate appearances and six overload decisions.
2. Shared work plus scroll-away cancellation across two bounded batches.
3. Goal change while a provider response is pending, followed by a current-context success.
4. Pause during provider work, late-response rejection, and successful resume.
5. Timeout, provider rejection, and missing assessment; all remain unresolved and visible without retries.

The expected values and rationale are visible before running. Export uses `focusfeed-lifecycle-report-v1` and includes scenario events, expected/actual values, versions, settings, timestamp, and browser user agent.

## Automated evidence

- Scheduler behavior test passes deduplication, priority bounds/promotion, request-ID integrity, goal invalidation, subscriber cancellation, timeout, response validation, pause/resume, and timing assertions.
- Lifecycle test passes all five fixed scenarios and report-summary assertions.
- Extension surface test verifies the popup link, lifecycle page controls, and dependency order.
- All 10 extension test files passed.
- All 7 backend unit tests passed. The two Bedrock tracebacks are intentional mocked error-path tests.
- JavaScript syntax, manifest JSON, HTML parsing, and `git diff --check` passed.

## Browser handoff B1

1. Reload the unpacked extension.
2. Open the popup and select **Open Lifecycle Replay**.
3. Review the five visible scenario expectations.
4. Select **Run lifecycle suite**.
5. Expect 5/5 passed, queue peak 24/24, in-flight peak 1/1, zero stale applications, three visible failures, and virtual p95 `60 / 40 / 80 ms`.
6. Export the JSON report and add it to `eval_reports/`.

This run is fast and invokes no LLM. Its virtual latency validates timing accounting, not real local or Bedrock performance.

## Browser result received

`focusfeed-lifecycle-1789922518708.json` matches report schema `focusfeed-lifecycle-report-v1`, lifecycle fixture `2026-09-20.1`, and `scheduler-v1`. All five expected scenario IDs occur exactly once and pass. The summary reports queue peak 24, in-flight peak 1, zero duplicate provider videos, zero stale applications, and three intentionally unresolved provider/output failures. This qualifies B1 and unlocks the bounded real-provider smoke; it does not establish real-model or live-YouTube latency.
