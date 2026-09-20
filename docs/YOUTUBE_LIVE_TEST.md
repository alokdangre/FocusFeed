# YouTube Home test — version 0.6.2

This checkpoint connects real YouTube recommendations to the existing rule/cache/model workflow. The session starts in preview. **Apply AI hides** enables reversible semantic hiding during your manual test; this is an experimental local trial, not a claim of production accuracy.

## Start the test

1. Reload FocusFeed at `chrome://extensions`, then open **YouTube Home**. Start can repair a missing content-script receiver in that tab once; refreshing YouTube remains useful after changing extension files during development.
2. In the popup, save your goal, useful topics, unwanted topics, exceptions, and Focus or Balanced mode. Choose **Local — Chrome built-in AI** for the current local test.
3. While the active tab is YouTube Home, click **Open YouTube session** in the popup.
4. Wait for provider readiness. Use **Check / prepare provider** if needed, then click **Start preview on YouTube**.
5. Click **Back to YouTube**. Keep the session tab open; the popup can close.

The session owns local inference in an extension document, using [Chrome's Prompt API](https://developer.chrome.com/docs/ai/prompt-api). It exchanges card snapshots and results over a [Chrome extension port](https://developer.chrome.com/docs/extensions/develop/concepts/messaging).

## Expected behavior

- At most **12 distinct supported video IDs** are admitted initially, including rule/cache results. Additional cards are held outside the allowance. Hidden recommendations do not free slots.
- Explicit channel, keyword, format, duration, and feedback rules resolve immediately. Compatible successful cached assessments also skip inference. Natural-language unwanted topics are not silently converted into literal keyword blocks.
- Only remaining candidates enter the scheduler: batches up to four, one request at a time, queue cap 24.
- The first allowance permits at most **3 provider calls and 12 provider videos**. A failed, timed-out, canceled, or metadata-changed attempt consumes its dispatched allowance. No automatic retry or paid-provider fallback occurs.
- Local calls currently take roughly a minute per four-video batch on the measured device. Pending or failed semantic results stay visible. A full set can take several minutes; a mostly cached/rule-resolved set may make few or zero calls.
- YouTube cards show their route and proposed decision. The Home toolbar and session page show route counts, pending work, actual call allowance, and held pagination requests.
- Review the table, then select **Apply AI hides** on YouTube or in the session tab. Use **Preview only**, **Restore AI hides**, or a row's **Restore on YouTube** to reverse AI decisions. Current explicit allow rules remain authoritative.

## Load more without automatic extra model work

**Load 12 more** adds 12 candidate slots, up to 3 more provider calls, and up to 12 more provider videos. Already-loaded deferred cards are used first. If there are too few, the adapter exposes YouTube's continuation trigger and permits at most one further Home browse continuation request for that click. Remaining continuation requests wait.

Both `fetch` and asynchronous XHR Home `browse` continuations are gated. Initial Home loads, search, watch, and unrelated network calls are not intercepted by this gate. A request already in flight when the session starts may still complete; its extra cards cannot exceed the independent classification allowance. The pagination adapter relies on YouTube's current request/DOM shapes and requires this manual check. The inference budget remains enforced even if a new YouTube pagination variant bypasses the gate.

Maximum per run: **120 admitted videos, 120 dispatched provider videos, and 30 provider calls**, unlocked only by explicit Load more clicks. Load more is temporarily disabled when another allowance would overfill the queue. Stopping or closing the session returns normal pagination and restores AI hides. Explicit filters keep their normal behavior.

## First manual checks

1. Confirm rules/cache rows do not appear in provider batches. Export shows the actual dispatch events and budget totals.
2. Wait for the initial results, enable AI hiding, then scroll. Calls must stop at the current allowance; hiding cards must not silently admit replacements.
3. On YouTube, click **Load 12 more** in the FocusFeed toolbar once. Admission rises to at most 24 and call allowance to 6; the actual calls can be lower because rules/cache still run first. The session tab intentionally has no Load more control.
4. Restore an AI-hidden video. It stays restored for this session, without another model call.
5. Stop the session, then start again on the same goal/cards. Successful compatible assessments should use the live cache. Replay fixtures have a separate cache namespace and cannot supply live results.
6. While a call is pending, change your goal or navigate away from Home. The run must stop; late results must not hide the new cards. Closing the session tab should have the same effect.
7. Include the previously deferred selector check: verify a channel explicitly allowed remains visible despite a conflicting format rule. Unknown duration must not imply Shorts.
8. Mark desired show/hide decisions in the session table and **Export session**. Save `focusfeed-live-*.json` to `eval_reports/`.

The export includes saved goal/preferences, real video metadata, classifications, route records, scheduler/call timings, bounded events, display state, and your reviews. It contains no automatic accuracy claim: desired actions must come from your review.

## Bedrock later

The same session can use the saved Bedrock selection. Restart the updated backend first: it now reports missing, duplicate, and unexpected model output before normalization, so fallbacks cannot count as valid live results. Health checks make no inference call; Start/Load more can incur the displayed bounded work. Client cancellation stops waiting and future dispatch, but cannot undo charges for an invocation already accepted by AWS.

## Verification boundary

Node tests exercise routing, actual fake-provider dispatch counts, budgets, persistence, metadata invalidation, failure/no-retry behavior, cancellation, raw-output validation, the fetch/Request/XHR gate, and a card-adapter test double. No browser automation or real inference was run by Codex. YouTube's actual rendering, continuation behavior, and Chrome local inference lifecycle are the manual checks above.
