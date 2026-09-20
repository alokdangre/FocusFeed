# Workflow A1 implementation report

Date: 2026-09-20  
Extension: 0.3.1  
Workflow: workflow-v1.1  
Cache: assessment-cache-v2 / `focusFeedAssessmentCacheV2`  
Status: automated checks passed; browser handoff pending

## Scope

This iteration strengthens deterministic rules, assessment-cache safety, and the Workflow Replay evaluator. It does not connect semantic cache/model decisions to live YouTube hiding, add a model queue, or measure provider latency.

## Reproduced failures before the fix

- An assessment carrying another `videoId` could resolve a compatible cache entry and hide the current video.
- A nonnumeric expiry could be treated as a cache hit.
- Two concurrent whole-store writes could leave only one assessment.
- Warm replay could report compatible hits when the persistent store was empty because synthetic entries supplied them.
- Global format CSS could hide a live/Short/premiere card despite the router choosing an exact channel allow.
- Mode was sent to provider prompts but omitted from cache compatibility.

## Changes

- Cache retrieval validates key/signature, exact video ID, required policy labels, and finite ordered timestamps. Cache insertion rejects invalid assessments and timestamps.
- Cache mutations use a Web Lock where available and a shared in-realm promise chain otherwise. Regression coverage uses two cache instances and verifies concurrent writes and clear-after-write ordering.
- Cache schema/storage moved to v2. Mode is part of compatibility while it remains a provider input.
- Global format-hide CSS was removed. Individual Shorts/live/premiere cards flow through the shared rule evaluator, preserving explicit allow precedence.
- Replay now has distinct **Seed persistent cache** and **Read persisted replay** actions. Compatible cache fixtures never come from the synthetic invalidation map.
- Replay increased from 20 to 24 visible cases with wrong-video, malformed-expiry, invalid-label, and mode-change regressions.
- Route traces come from the router's executed stages. Persistent-read timing is reported separately from synchronous routing time.
- The metric is labeled **Resolved before model** rather than claiming measured model calls avoided.
- JSON report export records fixture/workflow versions, configuration, inputs, expected and actual results, traces, timings, and browser user agent.
- Model evaluation and workflow routing use the same policy function.
- Hidden-card counts decrement when a hidden card is restored.

## Automated evidence

- Extension: 8 test files passed.
- Workflow core: 24 visible fixtures passed under cold and fully seeded persisted-cache inputs.
- Empty persistent-store negative control: 22/24 pass; the two compatible-hit cases correctly fail until seeded.
- Cache regressions cover invalid insertion, wrong assessment ID, malformed expiry, concurrent writes through two cache instances, eviction, expiry, clear ordering, and reopen-compatible storage behavior.
- Backend: 7 unit tests passed. The two logged Bedrock tracebacks are intentional mocked error-path tests.
- JavaScript syntax and manifest JSON checks passed.

Deterministic expected counts:

| Run | Pass | Rule | Cache | Pending | Metadata unresolved | False hides |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold | 24/24 | 10 | 0 | 13 | 1 | 0 |
| Persisted after seed | 24/24 | 10 | 2 | 11 | 1 | 0 |
| Empty persisted negative control | 22/24 | 10 | 0 | 13 | 1 | 0 |

These counts describe fixture rows. They are not production model-request savings or semantic accuracy.

## Browser evidence still required

- Chrome storage survives closing and reopening the replay page without reseeding.
- Web Locks and storage behavior match the automated storage double.
- A whitelisted exact live/Short channel remains visible when the relevant format filter is enabled.
- Non-whitelisted matching cards still hide, individual Shorts selectors cover the current YouTube DOM, and hidden counts restore correctly.
- Export downloads successfully and reflects the displayed run.

Use handoff A1 in `docs/WORKFLOW_EVALUATION_PLAN.md`. Do not start scheduler/provider integration until browser mismatches are fixed.
