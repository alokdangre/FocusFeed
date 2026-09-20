# FocusFeed Implementation Plan

## 1. Product Vision

FocusFeed is a browser extension that helps people shape YouTube around their current goals. A user describes what they want to achieve, what kinds of videos help, and what they want to avoid. The extension then classifies recommendations and hides videos that are clearly unwanted or irrelevant to the active goal.

The hackathon version is AWS-first. Amazon Bedrock provides the semantic classification, while the extension handles feed discovery, deterministic filters, caching, display changes, explanations, and corrections.

The first product promise is:

> Make YouTube fit what I want to do right now.

For example, a user may create this session:

- Goal: Prepare for coding interviews.
- Useful content: DSA explanations, practice problems, and mock interviews.
- Unwanted content: Gaming, creator drama, and generic motivational videos.
- Exception: Allow background music.
- Mode: Focus.

The same cricket, gaming, or finance video may be useful for one goal and distracting for another. Therefore, FocusFeed must classify both the video's content and its relationship to the active goal.

## 2. Hackathon Scope

The hackathon implementation will prioritize:

1. A complete goal-to-filtering flow powered by Amazon Bedrock.
2. High-quality, explainable classifications.
3. Conservative and reversible filtering.
4. Bounded processing of continuously arriving YouTube videos.
5. Measurable classification quality, latency, cache use, and failures.
6. A user-facing dashboard and a deployed AWS-backed demonstration.

Bedrock remains the primary hackathon provider and AWS demonstration path. While Bedrock invocation is blocked by account verification, Chrome's Prompt API is implemented in parallel so classification, policy, caching, metrics, and browser UX can continue to be built and evaluated. Both providers use the same assessment contract.

Initial supported surfaces:

- YouTube Home feed.
- Watch-page recommendations after the Home flow is reliable.
- Search filtering remains optional because an intentional search has different meaning from passive feed browsing.

## 3. User Experience

### 3.1 Extension popup

The popup provides quick controls:

- Enable or pause FocusFeed.
- Select the active goal.
- Choose Balanced or Focus mode.
- Start or end a focus session.
- View processed, hidden, pending, and uncertain counts.
- Open the full dashboard.

The popup remains small. Detailed configuration and analytics belong in the full dashboard.

### 3.2 Goal setup

The user enters a goal in natural language. FocusFeed converts it into an editable profile containing:

- Primary goal.
- Useful topics and content types.
- Unwanted topics and content types.
- Explicit exceptions.
- Preferred languages.
- Filtering mode.
- Optional session duration.

The user reviews this interpretation before activating it. Each material change creates a new profile version so that results from an older goal cannot affect the current feed.

### 3.3 YouTube feed behavior

FocusFeed will provide:

- A filtering status indicator.
- A count of hidden videos.
- A way to inspect hidden videos.
- A short explanation for each decision.
- Undo for individual videos.
- Pause and resume controls.

Ambiguous videos remain visible. Model errors and timeouts also leave unresolved videos visible. Explicit local rules can still apply when semantic classification is unavailable.

### 3.4 Filtering modes

Balanced mode hides content that clearly matches an unwanted preference or explicit block.

Focus mode also hides videos that are clearly unrelated to the active goal. It remains conservative when the evidence is weak.

## 4. Classification Model

### 4.1 Classification questions

The classifier must answer separate questions rather than produce one vague distraction score:

| Question | Example output |
| --- | --- |
| What is the video about? | Dynamic programming |
| What is its purpose? | Tutorial, walkthrough, news, reaction, entertainment |
| How does it relate to the goal? | Directly useful, supporting, unrelated, unclear |
| Does it match an unwanted preference? | Yes, no, unclear |
| Is the evidence sufficient? | Sufficient or insufficient |
| What supports the assessment? | Specific supplied title or metadata evidence |

Observable format information, such as Shorts or livestream status, remains separate from semantic judgments such as tutorial or entertainment.

### 4.2 Classification input

The first version uses only metadata available reliably and quickly:

- Video ID.
- Title.
- Channel name and stable channel ID when available.
- Duration when available.
- Shorts, live, and premiere indicators.
- Description snippet when legitimately available.
- Active goal and preferences.

Missing values remain unknown. The system must not invent a duration, topic, channel, or content format.

Transcripts are not a dependency for the hackathon version. Thumbnail analysis and selective metadata enrichment may be evaluated later for ambiguous cases.

### 4.3 Structured assessment

Every model result must follow a validated schema. A conceptual assessment contains:

- `videoId`
- `topics`
- `contentPurpose`
- `goalRelevance`
- `unwantedMatch`
- `evidenceSufficiency`
- `evidence`
- `reason`

The backend additionally verifies that:

- Every returned video ID was requested.
- No video ID appears more than once.
- Labels come from permitted enumerations.
- Missing results are treated as uncertain.
- Unexpected results cannot change the feed.

A structurally valid response is not automatically a correct judgment. Classification correctness is measured by the evaluation system.

### 4.4 Decision policy

The language model produces assessments. Deterministic application logic decides what to display.

| Assessment or rule | Balanced mode | Focus mode |
| --- | --- | --- |
| User explicitly allows the video | Show | Show |
| Explicit blocked video or channel | Hide | Hide |
| Directly useful | Show | Show |
| Supporting or allowed exception | Show | Show |
| Clearly matches an unwanted preference | Hide | Hide |
| Clearly unrelated | Show | Hide |
| Ambiguous or insufficient evidence | Show | Show |
| Model failure or timeout | Show | Show |

The exact precedence of video overrides, channel rules, keywords, format rules, and semantic decisions will be documented and kept deterministic.

### 4.5 Explainability and corrections

Explanations describe the active goal, the matched rule or assessment, and the supporting metadata. They should say:

> Hidden during Interview Prep: the title indicates a gaming livestream.

They should not make moral judgments about the user or creator.

User actions include:

- Show this video.
- Hide this video.
- Always allow this channel.
- Block this channel.
- Classification was wrong.

An explicit override changes the display immediately. A classification correction is recorded separately for evaluation. Restoring one video must not silently block or allow every video from its channel.

## 5. Cached Assessments

A cached assessment is a previously saved semantic classification that can be reused when the same video appears under the same relevant conditions.

Example:

1. The active goal is "Prepare for DSA interviews."
2. YouTube shows "I Quit Coding to Become a Travel Vlogger."
3. Bedrock assesses the video as a personal story unrelated to DSA preparation.
4. Focus mode hides the video.
5. The same recommendation appears again later.
6. FocusFeed reuses the saved assessment and applies the decision immediately without another Bedrock call.

The cache key must account for:

- Video ID.
- Relevant metadata fingerprint.
- Goal/profile version.
- Classifier provider and model version.
- Prompt/schema version.
- Policy version where necessary.

The intended contract keeps assessment labels independent of filtering mode so that current policy can reinterpret a cached assessment. The current cache excludes mode, but this reuse is not yet qualified: the actual provider requests still include mode, and a popup mode change increments the profile version used in the key. Establish a mode-independent semantic request and profile identity, or include every relevant model input in compatibility checks, before enabling this reuse in the live feed.

The assessment is reusable when those inputs remain compatible. It must be refreshed when the title or other relevant metadata changes, the goal changes, the classifier changes, or the entry expires.

Cache reuse never overrides an explicit user choice. The system stores the assessment and reapplies current policy and overrides to it.

This is different from caching model files. Model-file caching avoids downloading model weights again; assessment caching avoids repeating inference.

## 6. End-to-End Classification Flow

1. Detect a visible or nearby YouTube card.
2. Extract and normalize its available metadata.
3. Read the active goal, filtering mode, and profile version.
4. Apply deterministic video, channel, keyword, duration, and format rules.
5. Look for a compatible cached assessment.
6. If there is no cache hit, add the video to the priority queue.
7. Batch compatible queued videos within the request and token limits.
8. Send the batch to the backend.
9. Validate the request and enforce user and system usage limits.
10. Use Strands Agents SDK with Amazon Bedrock to produce structured assessments.
11. Validate the returned schema and video IDs.
12. Apply the deterministic filtering policy.
13. Confirm that each DOM card still represents the same video before changing it.
14. Save assessments and decision events.
15. Update feed controls and dashboard metrics.
16. Apply corrections immediately and retain them as separate events.

If the active profile changes while a request is running, the response may be stored under its original context but cannot modify the current feed.

## 7. Agent and Workflow Strategy

Live filtering will use a bounded workflow:

> Rules -> cache -> one structured Bedrock classification -> validation -> policy

Priority update after the v4 development run: implement and evaluate this combined workflow before another prompt-only iteration. See [WORKFLOW_AND_LATENCY_PLAN.md](WORKFLOW_AND_LATENCY_PLAN.md) for the measured bottleneck, routing stages, fast-path constraints, acceptance targets, and manual handoff sequence. Existing live filters are deterministic; semantic inference currently runs in controlled tests rather than the YouTube feed.

Checkpoint 1 is implemented as a prototype. The YouTube feed and the workflow replay page share the deterministic rule evaluator. Channel controls use exact normalized identity, missing duration is no longer treated as proof of a Short, and the replay applies Balanced/Focus policy to cached assessments. The popup opens visible cold/warm cases with fixed expected results and route summaries. The persistent cache has an entry limit and expiry checks, with correctness gaps listed below. Semantic cache decisions remain disconnected from live hiding pending qualification.

Qualification update: the follow-up review exposed untested cache validation/concurrency faults, a live CSS precedence conflict, and evaluation blind spots. The mode-reuse claim also needs validation through the actual popup/provider contract. Follow [WORKFLOW_EVALUATION_PLAN.md](WORKFLOW_EVALUATION_PLAN.md) to correct and evaluate this checkpoint before extending it, with distinct automated, semantic, and manual browser gates.

An open-ended agent loop is not needed in the critical path. It would introduce unpredictable model calls, latency, and cost. A second model pass over the same vague title may only repeat the same mistake with stronger wording.

A bounded escalation can be evaluated later:

- Invalid structure: one repair attempt within a fixed budget.
- Insufficient metadata: obtain one permitted enrichment source or abstain.
- Difficult but sufficiently evidenced case: optionally use a stronger model.
- Unsupported language: route to a supported configured provider or abstain.

No escalation is added until evaluation demonstrates that its quality improvement justifies its latency and cost.

Agentic workflows are more useful during development. They may inspect failed evaluation cases, group recurring errors, propose prompt changes, and run controlled experiments. Any proposed configuration must pass the fixed evaluation suite before release.

## 8. Processing Many Videos

YouTube can load hundreds of cards during a session. FocusFeed will process videos according to user visibility rather than classifying everything immediately.

### 8.1 Priority queue

| Priority | Videos |
| --- | --- |
| Highest | Currently visible cards |
| High | Cards approximately one screen below the viewport |
| Deferred | Farther cards already loaded in the document |
| Removed | Cards no longer relevant to the current page or profile |

New cards are detected through DOM observation. Viewport proximity determines priority. Background tabs pause speculative work.

### 8.2 Batching and concurrency

Initial settings to evaluate:

- A short batching window around 150-250 ms.
- Approximately 8-12 metadata-only videos per Bedrock request, also limited by token size.
- No more than two simultaneous cloud classification requests per extension installation.
- A bounded pending queue.
- Deduplication of identical pending assessments across tabs.

These are initial experiment values, not guaranteed final settings. Evaluation will determine the best balance between first-result latency, throughput, quality, and cost.

### 8.3 Backpressure

When cards arrive faster than the classifier can process them:

- Visible work takes priority.
- Distant speculative work is evicted or deferred.
- The queue never grows without a fixed bound.
- Rate-limited work uses bounded exponential backoff with jitter.
- Repeated failures result in an unavailable state rather than endless retries.
- Unresolved cards remain visible after their waiting deadline.

## 9. Latency Strategy

Latency is measured from the moment a card becomes eligible for processing until the decision is applied. This includes queueing, network time, Bedrock processing, validation, and rendering.

Initial targets to validate:

| Path | Target |
| --- | --- |
| Explicit rule or compatible local cache | Under 50 ms after metadata is available |
| Batch collection delay | Around 150-250 ms |
| Fresh Bedrock assessment | Aim for 1-3 seconds under normal conditions |
| Waiting deadline | Initially around 5 seconds |

Balanced mode leaves cards visible while classification is pending. Focus mode may use a brief neutral placeholder, but must restore the card if the deadline expires.

Optimization methods:

- Process visible and nearby cards first.
- Apply explicit rules before AI.
- Reuse assessments.
- Keep prompts and outputs compact.
- Deduplicate repeated videos and in-flight work.
- Measure batch sizes instead of assuming larger batches are faster.
- Discard stale UI updates after navigation or goal changes.

Cached and fresh decision latency will be reported separately.

## 10. Metrics and Dashboard

### 10.1 Product surfaces

| Surface | Purpose |
| --- | --- |
| Popup | Quick controls and current-session summary |
| YouTube controls | Filtering status, hidden count, explanations, and undo |
| Extension dashboard | Goals, metrics, history, quality, and settings |
| Public website | Product explanation, installation, AWS architecture, and sample-feed demo |
| Cloud account dashboard | Optional later synchronization across devices |

For the hackathon, the full dashboard is an extension page opened in a normal tab. It can read extension-local data without requiring analytics upload.

### 10.2 User-facing metrics

| Metric | Definition |
| --- | --- |
| Videos processed | Unique videos processed for the selected session and profile |
| Videos hidden | Unique videos currently hidden by FocusFeed |
| Pending | Eligible videos awaiting a decision |
| Uncertain | Videos intentionally left unresolved due to insufficient evidence |
| Restored | Hidden videos explicitly restored by the user |
| Rule decisions | Decisions resolved without semantic inference |
| AI decisions | Decisions based on a model assessment |
| Cache hits | Assessments reused without a fresh model invocation |
| Fresh classifications | Assessments requiring a Bedrock invocation |

Do not calculate "time saved" by adding video durations. A hidden recommendation does not prove that the user would have watched it.

### 10.3 Classification-quality metrics

The dashboard and hackathon report will distinguish:

- Per-video explanations.
- Agreement on decisions the user actually reviewed.
- Accuracy measured on a separately labeled evaluation set.

Evaluation metrics include:

- Hide precision.
- Unwanted-content recall.
- Useful videos incorrectly hidden.
- Uncertainty rate.
- Classification coverage.
- Results by goal, language, and difficulty.

A model's self-reported confidence is not presented as measured accuracy.

### 10.4 Decision records

Each decision event records:

- Video ID and metadata fingerprint.
- Session and profile version.
- Assessment and applied action.
- Decision source: explicit rule, AI, or user override.
- Cache-hit status.
- Provider/model and classifier version.
- Explanation and timestamps.
- Queue, inference, and end-to-end duration.
- Later correction or restoration events.

Repeated DOM appearances of the same video within the same relevant context do not inflate classification counts.

## 11. Evaluation Plan

Evaluation begins as soon as the first Bedrock classifier works.

### 11.1 Dataset

Start with a small smoke-test dataset during the first implementation phase. Expand it to approximately 100-150 distinct videos across several goals.

Cases should include:

- Clearly useful tutorials and practice content.
- Clearly unwanted entertainment.
- Videos that mention a topic without helping the goal.
- Vague or clickbait titles where uncertainty is correct.
- Mixed-purpose and multi-topic content.
- Explicit exceptions.
- English, Hindi, and Hinglish titles.
- The same video evaluated under different goals.
- Titles containing instruction-like or adversarial text.

Labels must be based on the information available to the classifier. If a human cannot decide from the supplied evidence, uncertainty is an acceptable expected result.

All variants of the same video remain in the same dataset split to reduce leakage.

### 11.2 Experiments

Compare:

1. Existing deterministic rules.
2. One-pass Bedrock classification.
3. Alternative Bedrock models or prompt configurations.
4. Bounded enrichment or escalation only when justified by observed failures.

Change one factor per experiment. Use development data to improve the configuration and retain an untouched held-out set for the final report.

### 11.3 Operational evaluation

In addition to classification quality, measure:

- Structured-output failure rate.
- Consistency across repeated runs and batch orderings.
- Median and 95th-percentile end-to-end latency.
- Queue depth and timeout rate.
- Cache-hit rate.
- Input and output token usage.
- Estimated cost per 1,000 fresh assessments.
- Overall cost per 1,000 decisions after cache reuse.

Automated workflow tests cover stale responses, expired caches, duplicate cards, timeouts, goal changes, and user overrides.

## 12. AWS Architecture

### 12.1 Hackathon architecture

| Component | Responsibility |
| --- | --- |
| Browser extension | Extract metadata, prioritize work, apply decisions, and store local state |
| API Gateway | Expose protected classification and supporting APIs |
| Lambda | Validate requests, enforce limits, orchestrate classification, and validate results |
| Strands Agents SDK | Provide the structured model interaction and evaluation integration |
| Amazon Bedrock | Perform semantic video classification |
| DynamoDB | Store server-side usage counters and optional user-scoped synchronized records |
| Cognito | Authenticate users for deployed cloud classification |
| CloudWatch | Track errors, latency, throttling, token usage, and operational health |
| Amplify Hosting | Host the public product and demonstration website |

During early development, the backend may run locally while invoking Bedrock. AWS credentials stay in the backend and are never placed in the extension.

### 12.2 Usage and cost controls

The deployed backend enforces:

- Authentication.
- Request and batch-size validation.
- Per-user usage allowances.
- Bounded global concurrency.
- Token and payload limits.
- API throttling plus application-level admission checks.
- Controlled retries and explicit busy responses.
- Monitoring and budget alerts.

A request canceled by the extension may already be running in Bedrock, so cancellation does not imply zero cost.

## 13. Failure Handling

| Situation | Behavior |
| --- | --- |
| Internet unavailable | Continue explicit rules and compatible cached decisions |
| Bedrock timeout | Leave unresolved videos visible |
| Invalid structured output | Reject it; perform only a bounded repair if configured |
| Rate limit reached | Pause and retry with bounded backoff |
| Goal changes during inference | Prevent the old result from changing the current feed |
| Card is recycled for another video | Recheck video ID before applying a result |
| Metadata is missing | Preserve unknown fields and avoid guessing |
| Everything is hidden | Explain active filters and offer to relax the profile |
| YouTube layout changes | Report reduced coverage and preserve basic page usability |
| Extension worker restarts | Reload persistent state and rebuild work from live tabs |

Titles and descriptions are untrusted data. The model may classify them but cannot use them to execute commands or choose arbitrary tools.

## 14. Privacy and User Control

The extension dashboard works from local records. Cloud classification sends only the goal and video metadata required for assessment.

Users will be able to:

- Pause all filtering.
- Inspect and restore hidden videos.
- Clear decision history.
- Reset learned preferences and overrides.
- Export their data.
- Disable optional analytics synchronization.
- Delete synchronized cloud data when that feature exists.

Disabling analytics synchronization does not make Bedrock inference local. The product must state this clearly.

Raw titles, goals, and browsing history will not be included in routine operational logs. Cloud records are user-scoped and access-controlled.

## 15. Phase-by-Phase Delivery Plan

Current unblock sequence while AWS reviews Bedrock access:

1. **Complete:** Add provider selection and start Chrome's built-in model download from a user-activated extension page. Chrome owns the download after it starts; reopening the popup reads the current browser-level status.
2. **Complete:** Add a controlled Classifier Lab with editable fixtures, full assessments, raw local output, stage timings, validation diagnostics, and locally retained run history.
3. **Complete initial dataset:** Create a versioned 24-case reference dataset with 16 development cases and 8 held-out cases. It covers clear positives and negatives, explicit exceptions, vague metadata, keyword traps, purpose-versus-topic cases, and hard negatives. The first browser run is also a manual review point for correcting any disputed reference label before prompt tuning.
4. **Iteration v3 needs revision:** Few-shot v3 passed development with 100% output coverage, 93.75% exact match, zero feed-decision errors, and 3m 17.0s wall time. Its frozen held-out run retained 100% coverage but scored 37.5% strict exact match and 87.5% decision accuracy, including one false hide on cautionary day-trading content. Three other strict failures were subjective content-purpose boundaries with correct feed decisions. V3 is retained for audit but is not production-qualified. The next iteration must distinguish promotion from critical or cautionary mentions and use a newly versioned held-out set. The frontend exposes every selected test case and expected label, the scoring rubric, iteration changelog, output coverage, decision accuracy, wall time, stage totals, inference share, per-scenario timing, quality metrics, and case-level mismatches. Gold labels never enter classifier requests.
5. **Iteration v4 measured, workflow now takes priority:** Dataset `2026-09-20.2` contains 24 development cases and eight new held-out cases. V4 returned 24/24 results, scored 20/24 exact matches and 24/24 feed decisions, but took 4m 51.9s (48.7s average per four-video batch). The cautionary finance case still has incorrect relevance, which Balanced mode masks. Applying Focus policy to the same assessment produces a false hide. This is not sufficient evidence for real-time operation or promotion. The new held-out split remains unevaluated.
6. Build the shared rule/cache/router workflow and a replay evaluator before connecting live semantic hiding. Implement bounded viewport scheduling, in-flight deduplication, stale-result protection, and truthful per-route timing/coverage; see [WORKFLOW_AND_LATENCY_PLAN.md](WORKFLOW_AND_LATENCY_PLAN.md).
7. Benchmark compact local classification output and base-session cloning as separate experiments. Keep full v4 as a reference. Then integrate the evaluated workflow with live YouTube batches and hand browser verification to Alok.
8. Re-enable and benchmark Bedrock on the same workflow and inputs as soon as AWS removes the account restriction. Local timings do not establish Bedrock latency.

### Phase 1: Complete the Bedrock filtering flow

Build:

- Goal and unwanted-preference input.
- Editable structured goal profile.
- Focus and Balanced modes.
- Home-feed video extraction.
- Deterministic rules and precedence.
- Small visible-video batches.
- Backend validation.
- Strands with one Bedrock model.
- Structured assessment validation.
- Show/hide policy, explanations, hidden-items view, and undo.
- Basic request caps.

Exit criteria:

- A user can enter a goal and receive real Bedrock classifications.
- Relevant and unwanted cards are handled according to mode.
- Uncertain and failed assessments remain visible.
- The user can inspect a reason and restore a hidden video.

### Phase 2: Establish classification quality

Build:

- Versioned prompts and assessment schema.
- Labeled development and held-out evaluation data.
- Repeatable evaluation runner and report.
- Error analysis by goal, language, and difficulty.
- Comparison of selected Bedrock models and configurations.

Exit criteria:

- Classification metrics are reproducible.
- Known failure categories are documented.
- The selected classifier is supported by measured quality, latency, and usage data.

### Phase 3: Handle continuous feeds and latency

Build:

- Viewport-based prioritization.
- Bounded batching and concurrency.
- Assessment cache and invalidation.
- In-flight deduplication.
- Stale-response protection.
- Timeouts, backoff, and worker-restart recovery.
- Watch-page recommendation support after Home is reliable.

Exit criteria:

- Rapid incoming cards do not cause unbounded requests or queue growth.
- Duplicate videos reuse work.
- Old results cannot change a new session.
- Cached and fresh latency are reported separately.

### Phase 4: Build the user dashboard

Build:

- Overview metrics.
- Saved goals and session history.
- Decision history and explanations.
- Cache and performance metrics.
- Classification-quality report.
- Data retention, export, deletion, and reset controls.

Exit criteria:

- Dashboard counts reconcile with recorded decisions and corrections.
- Repeated DOM renders do not inflate totals.
- Measured evaluation quality is visibly separated from user-review agreement.

### Phase 5: Deploy and control AWS usage

Build:

- API Gateway and Lambda deployment.
- Cognito authentication.
- DynamoDB usage accounting where required.
- CloudWatch metrics and alarms.
- Server-enforced allowances and concurrency limits.
- Amplify-hosted public website.

Exit criteria:

- The deployed extension calls authenticated APIs successfully.
- Usage and failure behavior are observable.
- Cost and traffic controls work before public access.

### Phase 6: Prepare the hackathon demonstration

Build:

- Reliable demo profiles and example feed.
- Public explanation and architecture page.
- Installation and setup instructions.
- Final evaluation and performance report.
- Demo flow covering goal changes, explanations, corrections, scrolling, and dashboard updates.

Exit criteria:

- The demo has a hosted URL and reproducible setup.
- The presentation distinguishes measured results from targets.
- Known limitations and unsupported flows are documented.

### Phase 7: Harden local inference for free users

Evaluate and add:

- Chrome Prompt API, beginning with the interim implementation above.
- WebLLM with a suitable multilingual model.
- Optional Ollama companion for technical users.
- Local-only, cloud, and explicitly enabled hybrid modes.
- Provider capability and language detection.
- Model download, readiness, and resource controls.
- Separate quality and performance evaluation for every provider.
- Rules-only behavior when no semantic provider is available.

Exit criteria:

- Supported users can classify locally without Bedrock inference charges.
- Local-only mode makes zero cloud inference calls.
- Device, language, download, and quality limitations are clearly shown.

## 16. Verification Responsibilities

Automated and non-browser verification will cover:

- Request and response schemas.
- Filtering policy and rule precedence.
- Cache keys, expiration, and invalidation.
- Queue bounds, deduplication, and stale-response handling.
- Backend authentication and usage controls.
- Evaluation metrics and report generation.
- Deployment and static checks.

Alok will perform browser testing. For each implementation phase, the handoff will include:

- What changed.
- Automated checks and their results.
- Exact browser test steps.
- Expected outcomes.
- Any logs or screenshots worth collecting when a step fails.

Browser behavior remains marked unverified until those manual checks are completed.

## 17. Hackathon Demonstration Story

The final demonstration should show:

1. A user creates an Interview Prep goal.
2. FocusFeed interprets the goal and the user confirms it.
3. The Home feed is classified with Bedrock.
4. Useful DSA content remains visible while unrelated entertainment is hidden.
5. The user opens an explanation and corrects one decision.
6. New recommendations are processed while scrolling.
7. The user switches to a different goal and the feed decisions change.
8. The dashboard shows processed, hidden, uncertain, restored, cache, latency, and evaluation metrics.
9. The architecture view explains how the extension, Strands, Bedrock, Lambda, and other AWS services work together.

The central result is not simply that videos can be hidden. It is that users can define what relevance means for their current situation, inspect how FocusFeed applied that intent, and reverse any decision.
