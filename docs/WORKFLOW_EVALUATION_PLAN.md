# Workflow evaluation and manual test plan

Status: A1 router/cache, B1 scheduler/lifecycle, and C1 bounded real-provider qualification completed on 2026-09-20 from Alok's exported browser reports. The live YouTube format-selector check remains deferred. Version 0.6.0 implements a bounded Home-feed test with preview, opt-in reversible AI hiding, and manual Load more. Alok requested this real-feed milestone before more latency optimization; the live report is pending.

## 1. What we need to establish

The workflow must make the right display decision, avoid unnecessary inference, and remain correct when cards, preferences, storage, and provider responses change over time.

The routing replay contains 24 visible cases, including wrong-video, malformed-expiry, invalid-label, and mode-compatibility regressions. The separate Lifecycle Replay exercises queue → fake provider → validation and cancellation behavior through five visible scenarios. Neither page establishes real-provider speed, semantic quality, or DOM application behavior.

Use three separate evaluation layers:

1. **Deterministic correctness:** rules, cache compatibility, output validation, policy, and scheduling invariants. Fast, repeatable, no model calls.
2. **Semantic quality:** real local or Bedrock assessments against independently reviewed labels. Run only after the deterministic path is trustworthy.
3. **Browser behavior and usefulness:** actual YouTube cards, scrolling, navigation, delays, incorrect hiding, and user control. Alok runs this with guided steps.

Report each layer independently. A pending video that stays visible can be correct fallback behavior without being a successful semantic classification.

## 2. Faults and limitations found in the current checkpoint

The three existing workflow test files passed during this review. Additional Node probes exposed problems outside those tests. No real LLM or browser was invoked.

| Finding | Evidence and consequence | A1 status |
| --- | --- | --- |
| Cached assessments were not validated sufficiently | A probe cached an assessment for a different video ID and received `cache → hide`; a nonnumeric expiry returned `hit`. | Fixed in cache schema v2. Required decision labels, video ID, key/signature, and finite timestamps are validated. Invalid entries fail open. Three visible regressions and insertion tests cover this. |
| Concurrent cache writes lost entries | With an asynchronous storage double that copies values, two simultaneous writes left one entry. | Fixed for cooperating contexts with a Web Lock and a shared in-realm fallback chain. Tests cover two cache instances writing together and clear-after-write ordering. Cross-document Web Lock behavior remains part of browser handoff A1. |
| Warm replay could pass without persistence | Synthetic compatible entries hid a failed or absent persistent read. | Fixed. **Seed persistent cache** and **Read persisted replay** are separate actions. The read path adds only synthetic invalidation cases; compatible hits must come from storage. An empty store produces two intentional mismatches. |
| Live CSS bypassed rule precedence | Unconditional `display:none !important` could hide a card after an allow decision. | Source conflict fixed by removing global format-hide CSS and routing individual Shorts/live/premiere cards. Actual YouTube rendering and selector coverage require browser handoff A1. |
| Mode reuse was not established through the real provider flow | Both providers currently receive `profile.mode`, while the old cache identity excluded it. | Corrected conservatively: mode is in cache schema v2 compatibility. A visible mode-change case must miss. Mode-independent reuse is deferred until the provider request itself becomes mode-independent. |
| Measurement overstated what was tested | “Model calls avoided” counted rows and trace text was reconstructed by the UI. | The label now says **Resolved before model** and explicitly identifies case rows. Routes emit their own trace events, persistent-read time is separate, and the page exports a versioned JSON report. Actual request savings, queue, provider, and DOM latency remain future measurements. |

Additional review targets: cache normalization differs from the exact strings sent to the model; channel display names and handles are collapsed into one identity; the replay’s stale-profile case forces a hash-key collision rather than exercising a normal goal change; evaluation and workflow have separate policy functions; current hidden-card counters do not consistently represent the number currently hidden. These need focused tests before making stronger claims.

## 3. Freeze the behavioral contract before expanding tests

Write expected behavior in fixture data before running the implementation. Alok reviews cases where intent is subjective. Reference outcomes must not be produced by calling the router under test.

For this checkpoint, record precedence explicitly:

1. Filtering disabled → show, no inference.
2. Explicit channel allow → show, ahead of other existing channel, keyword, and format rules.
3. Repeated negative channel feedback, enabled format restrictions, duration limits, literal keyword blocks, and explicit channel blocks → hide as configured, with a recorded rule ID.
4. Compatible valid assessment → apply the current display policy.
5. Missing required input → visible and unresolved.
6. Otherwise → eligible for scheduling; visible until there is a usable result.

Per-video overrides are a future feature and must be marked unsupported until implemented. Natural-language unwanted topics are semantic preferences, not automatic literal blocks. Unknown duration or format does not establish Shorts. A title can be present but semantically vague; the model can still abstain.

Define the cache contract using the *actual semantic request*: input video metadata, semantic profile, available provider/model identity, prompt/request/schema versions, and expiry. Only normalize fields in ways that the provider contract also normalizes without losing meaning. Distinguish a stable channel ID, handle, and display-name fallback.

Use the shared production policy for actual actions. Expected actions remain independent, reviewed literals in the fixture data. This avoids both policy drift and using the same faulty function to generate its own answer key.

## 4. Deterministic test matrix

Retain the original 20 cases and the four A1 additions as regressions, then add independent cases and sequences for the remaining failure families. All authored cases, expectations, rationale, and changes must be inspectable in the frontend. Generated tests record their seed and a small reproducible failing sequence.

| Family | Required examples | Assertion |
| --- | --- | --- |
| Rule conflicts | Allow + block; allow + live/Short; disabled + every hide rule; literal keyword versus semantic exception | Documented precedence wins; no unnecessary model admission. |
| Metadata | Missing title/ID/duration; malformed duration; normal 30-second video; actual Short; title arriving later; API/DOM disagreement | Unknown values stay unknown; updated metadata gets reconsidered; API and DOM paths follow the same contract. |
| Channels and keywords | Exact name versus substring; real handle versus display name; Unicode and combining marks; regex punctuation; negation under a literal rule | Literal controls have predictable semantics and no accidental identity broadening. |
| Cache validity | Wrong ID; missing/invalid labels; stale schema/provider/prompt/profile; title change; forced hash collision; expired/future/malformed times; cached provider failure | Invalid/incompatible entries cannot produce a resolved hide. Valid uncertainty remains abstention. |
| Cache lifecycle | Fresh empty store; write/read; reopen without reseeding; TTL boundary; eviction at capacity; simultaneous writes; storage exception; clear during a write | Persistence is real, limits hold, no lost updates or resurrection after clear, and errors remain observable. |
| Policy | Useful/supporting/unrelated/unwanted/uncertain combinations under both modes; mode-only save; goal edit | Same compatible assessment is reinterpreted only under the declared contract; goal changes cannot reuse old semantics. |
| Provider output | Missing IDs; duplicates; unexpected IDs; malformed JSON; incomplete batches; timeout; late success; unsupported provider state | Only validated, current, requested results can be applied or cached; failures are not successful classifications. |
| Scheduling, once implemented | Duplicates; two subscribers to one video; out-of-order results; viewport changes; navigation; profile switch; overload | Bounds, priority, deduplication, cancellation, and stale-response protections hold across event sequences. |
| Display adapter | Allowed card with conflicting CSS; reused card now showing another video; enable/disable; restore/undo when available; hidden counter reconciliation | Actual visibility matches the latest applicable decision and counts reflect their documented meaning. |

Add relationship checks as well as hand-authored examples: unrelated cache entries cannot affect a decision; a repeated identical request keeps its identity; changing semantic input invalidates it; insufficient evidence cannot become a semantic hide. Generate permutations and interleavings with a fake clock rather than waiting real seconds.

Verify the tests can detect defects. Deliberately reverse allow precedence, skip the signature/ID check, break persistence, or remove the stale-response guard in a test-only variant. The appropriate test must fail. Do not leave those mutations in application code.

## 5. Improve the evaluation surface first

Extend Workflow Replay with distinct run types:

- **Rules and policy:** no cache or provider dependency.
- **Storage integration:** real extension storage in an isolated test namespace; seed, reopen/read, expire, and clear separately.
- **Lifecycle simulation:** fake provider and fake clock; inject bursts, failures, cancellation, and delayed results.
- **Recorded-response replay:** use saved real model outputs with their original request identity. Label these as recorded; they do not measure current model speed.
- **Real-provider evaluation:** optional, explicit local/Bedrock selection, fixed inputs, a bounded run, and a Stop control.

Every row should expose input metadata, full profile/rules, mode, reference route/state/action and rationale, actual route/state/action, cache compatibility reason, any validation error, and timing. Distinguish a semantic action from the temporary visible fallback while pending.

Both replay pages now export versioned JSON with their fixtures, configuration, expected and actual results, events, timings, and available browser identity. A future comparison view should load a prior report and show changes. Local performance and recorded/simulated performance remain labeled separately. Keep fixture data isolated from future production assessments.

Before asking Alok to run long tests, the page must show the expected work, model-call budget, how to stop, and how to export the outcome. Exports can contain user-entered goals and video metadata; show the included fields so they can be reviewed before sharing.

## 6. Measure quality, coverage, and latency separately

| Metric | Definition or interpretation |
| --- | --- |
| Contract pass rate | Cases with the correct route/state/action and required invariants. Independent of semantic accuracy. |
| False hides | Actual hide on a reviewed expected-show case; report count and rate using reviewed expected-show cases as denominator. |
| Missed hides | Reviewed expected-hide cases left visible at the declared deadline; separate model mistakes from unresolved/timeouts. |
| Semantic decision agreement | Report agreement on reviewed, resolved semantic cases together with resolution coverage. Also show all reviewed cases and deadline outcomes so abstaining on everything cannot look successful. |
| Route coverage | Unique eligible candidates resolved by rule/cache/model, and counts pending/deferred/metadata-unresolved/failed. Card appearances are a separate denominator. |
| Model work | Actual requests, unique candidate versions sent, videos per batch, duplicate requests, retries, cancellations, and provider usage when returned. Disabled filtering and missing metadata are excluded from inference-saving claims. |
| Correctness by group | Break out route, goal, mode, language, exception/negation cases, and cold/warm cache. Do not hide a Focus-mode failure inside a Balanced average. |
| Latency | Discovery → usable metadata → rule/cache result → queue admission/start → provider start/end → validation → DOM application. Show stage p50/p95, sample sizes, deadline misses, and oldest pending age. |
| Resource bounds | Queue and in-flight peaks, persistent count/bytes, cache read/write time, and storage failures. Bound the metadata and trace stores too. |

The existing router timer is only CPU time for the synchronous route function. Storage initialization, network, inference, and rendering must not be included implicitly in that number.

Provisional gates, to be measured rather than advertised as achieved:

- All authored deterministic regressions pass; zero wrong-ID hides, stale DOM applications, or allow-precedence violations.
- Zero observed lost cache writes, duplicate in-flight requests, or bound violations in the defined simulations.
- Initial scheduler experiment: queue cap 24 unique waiting candidates, one local request in flight. Report in-flight work separately from waiting depth.
- Rule/cache decision-to-application p95 below 100 ms after usable metadata on Alok's browser; show first-load storage timing separately from a hot in-memory cache. Include sample counts and repeated runs.
- No known false hides in the critical reviewed semantic regression set before live semantic hiding. Report missed-hide rate and unresolved coverage alongside that gate.
- Semantic provider latency remains an open measurement. A fast rule path cannot establish that fresh local inference finishes within seconds. If provider latency exceeds the useful waiting budget, keep the backlog bounded and decisions pending/deferred rather than weaken quality silently.

Zero observed errors on a small set is a regression gate, not evidence of zero population error.

## 7. Real-model evaluation without wasting minutes per iteration

First reuse saved development reports to test parsing, validation, routing, policy under both modes, and cache reuse. These replays must preserve the original request/prompt identity and be labeled recorded results; they cannot prove a changed prompt or current latency improved.

Then use this sequence:

1. **Targeted smoke:** 8–12 residual videos, emphasizing useful content, unwanted content, exceptions, vague titles, negation, and the finance cautionary-story regression. Check full ID coverage before a larger run. Print the actual provider-call count before starting.
2. **Development comparison:** the same fixed ordered inputs and profile snapshots through model-only and complete-workflow paths. Show cold assessment cache, warm assessment cache, and cold/warm model sessions as distinct experiments. Compare decisions and total work as well as speed.
3. **One optimization at a time:** compare output size first, session reuse separately, then their combination. For batching, use the same 12 residual videos at sizes 1, 2, and 4. Run a small pilot before paying for all 21 requests required by that sweep; stop configurations with broken coverage. Counterbalance run order and repeat promising configurations to check variability.
4. **User-reviewed examples:** accumulate about 60 real metadata examples across at least three distinct goals and difficult cases. Initially use 40 for development and reserve 20 as an untouched final check. This is a small practical pilot, not a statistical accuracy guarantee. Keep variants of the same video, including mode changes and near duplicates, in the same split.
5. **Frozen final check:** choose workflow, rules, provider contract, prompt, and scheduler settings using development data; then run held-out evaluation. If a held-out result informs a fix, move it into regression/development history and obtain fresh final-check examples.

Review expected labels before revealing predictions where practical. Show labels and rationale in the frontend for inspection, but never send gold labels or reviewer notes to a provider. Allow disputed/ambiguous references; resolve or mark them separately instead of changing the answer key to make a run pass. Keep regression cases and representative real-feed cases as separately reported sets.

The model sees only what the extension knows. Do not label a vague title confidently using information from watching the full video unless that information was supplied to the classifier too. Alok can separately record personal usefulness for product feedback.

Use measured per-call times to estimate a run's duration. Run deterministic and recorded-response checks frequently; run a short real-provider smoke after relevant provider/prompt changes; run the full development set only for a candidate release. Do not rerun the minutes-long LLM suite after an unrelated UI or deterministic-cache fix. Evaluate Bedrock against the same contract when account access works; current local results do not predict its quality, latency, or cost.

## 8. When Alok should test, and how

Manual testing happens at an observable milestone, after the corresponding automated checks pass. It is not required after every internal edit. Times below are approximate hands-on time; real model waiting time must be displayed separately.

| Handoff | When it is ready | Alok's procedure | Evidence and decision |
| --- | --- | --- | --- |
| A0: original smoke | Superseded by A1 | No repeat needed. | The prior 20-case result remains regression history, not persistence or browser proof. |
| A1: rules/cache correctness | **Core gate passed.** Alok's persisted report passed 24/24 with two real cache hits; the empty-store negative control produced only the two intended mismatches; the cold report passed 24/24. | No repeat needed for scheduler work. The real YouTube allow/format selector check remains deferred and must be completed before live semantic hiding. | Browser reports are retained in `eval_reports/`. This establishes the current synthetic router/cache fixtures, not live DOM correctness. |
| B1: scheduling and lifecycle | **Qualified from Alok's exported report.** `focusfeed-lifecycle-1789922518708.json` matches the fixed fixtures and versions. | No repeat needed for C1. | 5/5 passed, queue peak 24, in-flight peak 1, zero duplicate provider videos, zero stale applications, and three intentionally unresolved failures. Virtual timing establishes accounting only. |
| C1: real local-provider smoke | **Qualified from Alok's exported report.** The 12-case fixed smoke completed through the real local provider and bounded scheduler. | No repeat needed before D0 implementation. | 12/12 validated outputs, 10/12 exact labels, 12/12 selected and Focus decisions, zero false hides, exactly three calls, queue peak four, and in-flight peak one. Provider p95 was 59.3s; this qualifies the controlled contract but not interactive latency or live-feed quality. |
| D: real-feed shadow trial | Provider smoke and queue tests pass; proposed decisions and corrections are inspectable | Use YouTube normally for 10–15 minutes with semantic changes in shadow mode. Review 30–50 recommendations, including proposed hides, shows, and unresolved cases. Mark desired action and why; do not review only proposed hides. Existing explicit filters can remain active but their actual effects must be shown separately. | Export the reviewed samples and traces. Check real-feed route coverage, missed hides, false hides, pending age, and goal/exception interpretation. Incorporate failures into development; keep reserved final-check examples separate. |
| E: reversible live pilot | Frozen candidate passes the reviewed regressions and final check; shadow errors addressed; inspect/undo/pause controls implemented | Start in Balanced mode for one short session, inspect hidden cards and undo mistakes, then test Focus separately. Toggle pause and change goal. | Any wrong-ID hide, stale action, or overridden explicit allow stops semantic application and returns to shadow/debugging. Record usefulness as well as correctness. Broader use waits for these failures to be resolved. |

For a manual mismatch, capture: build/workflow version, run or case ID, browser version, selected provider/mode, input metadata and goal, expected versus actual behavior, rough timing, and steps to reproduce. Attach the exported report when the mismatch is in Workflow Replay. Do not ask Alok to run unavailable buttons or hidden diagnostics.

## 9. How each iteration finds and fixes a fault

1. Preserve a failing report and reduce it to the smallest reproducible input or event sequence.
2. Identify the responsible stage: extraction, rule, cache identity, storage, scheduling, provider, validation, policy, DOM/CSS, metric, or incorrect reference label.
3. Add a regression that fails on the old behavior. A semantic error does not automatically require a prompt change; a correct assessment with the wrong display action belongs to policy or application logic.
4. Make one scoped change, run the affected suite and existing critical regressions, then compare the same workload before and after.
5. Reject speed improvements that introduce false hides, invalid output acceptance, hidden unresolved work, or stale actions.
6. Show an iteration note in the frontend and a report in `eval_reports/`: fault, evidence, changed files/configuration, prior/new results, latency impact, remaining failures, and next manual handoff.

Next step: Alok runs the bounded YouTube Home test in [YOUTUBE_LIVE_TEST.md](YOUTUBE_LIVE_TEST.md), beginning with 12 admitted recommendations. Verify rule/cache avoidance, the model-call budget, continuation gating, and card identity in preview before using the opt-in AI hide control. Export the real-feed report to guide latency and classification improvements. The larger review and production qualification remain future work.
