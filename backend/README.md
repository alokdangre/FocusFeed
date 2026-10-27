# FocusFeed TypeSafe Jev backend

The backend validates user-defined content preferences, then classifies YouTube metadata against their exact wording. `TYPESAFE_API_KEY` stays on the server and is never stored in the extension. See [specific preferences and Focus discovery](../docs/INTENT_AND_FOCUS.md) for the current flow and browser checks.

## Current Jev design

Validation asks two independent `Noul` questions per entry: is the content preference recognizable, and is it concrete enough to match against video metadata in the selected mode? Both must reach `0.70` before an entry is accepted. Niche subjects do not need to fit a fixed taxonomy. Unclear entries return a clarification reason without a saveable objective.

Accepted entries retain the user's text with `matchScope: intent` and `validationVersion: focusfeed-intent-v1`. Video classification uses one direct match Noul per video/preference pair, respecting the subject, format, purpose and exceptions together. Previously confirmed category profiles retain their canonical definitions until the user validates and saves them again.

Application code computes:

- match: any direct topic match >= 0.50;
- no match: all direct topic matches <= 0.20;
- uncertain: otherwise.

There is no separate evidence-sufficiency question. A batch with N videos and K confirmed topics asks N × K questions.

The backend returns raw probabilities and diagnostics. The extension owns the final General/Focus action.

## Local setup

From the repository root:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```text
TYPESAFE_API_KEY=...
TYPESAFE_MODEL=jev-1.13.0
TYPESAFE_TIMEOUT_SECONDS=20
```

Start the API:

```bash
bash backend/run_local.sh
```

The default base URL is `http://127.0.0.1:3000`.

## Endpoints

### `GET /health`

Returns the provider, configured model, video prompt version, objective prompt version, taxonomy version, and whether a key is present. It does not call TypeSafe, so `configured: true` proves only that a value is set.

### `POST /objectives/classify`

Request:

```json
{
  "requestId": "objective-1720000000000",
  "mode": "general",
  "objectives": ["gaming streams", "celebrity gossip"]
}
```

The request accepts 1-8 unique entries of 1-160 characters. Each result contains understood and matchable probabilities, a status, a clarification reason, and a `validatedObjective` only when accepted. Copy that objective into the profile without changing its text. The response also includes thresholds, raw judgments, model, prompt version, timing and usage.

The popup saves after an explicit Save preferences, Save topics, or Start Focus action, only if every entry passes and the draft still matches the response.

### `POST /classify`

Request:

```json
{
  "requestId": "run-1-batch-1",
  "profile": {
    "id": "profile-1",
    "version": 1,
    "mode": "general",
    "objectives": [
      {
        "id": "intent-gaming-streams",
        "text": "gaming streams",
        "contentType": "topic",
        "matchScope": "intent",
        "validationVersion": "focusfeed-intent-v1",
        "sourceText": "gaming streams"
      }
    ]
  },
  "videos": [
    {
      "videoId": "abc123",
      "title": "Ranked game stream highlights",
      "channel": "Example Channel",
      "channelId": "@examplechannel",
      "duration": "12:30",
      "isShort": false,
      "isLive": false,
      "isPremiere": false,
      "descriptionSnippet": "Highlights from last night's ranked stream."
    }
  ]
}
```

A batch accepts 1-12 unique videos. The response contains one assessment per video with every `objectiveMatches[].matchProbability`, the computed outcome, metadata evidence, and a reason. Diagnostics retain thresholds, raw judgments, missing IDs, unexpected question IDs, timing, and TypeSafe usage.

## Batching and cache

Automatic filtering now batches up to 12 videos / 96 video-topic questions. The
backend sends only missing video/topic pairs to Jev and compacts the shared state.
It splits calls at 96 questions, 48,000 serialized UTF-8 JSON bytes per request, or
24,000 bytes for state plus one question. These are conservative byte budgets, not
exact token accounting. Jev remains responsible for enforcing its token limits.

Validated raw probabilities are cached in SQLite, keyed by video ID, exact metadata,
individual topic/source text, question, pinned model, prompt/taxonomy version, and
provider endpoint. Scores can be reused across tabs, reloads, and mode switches;
show/hide policy is recomputed. Changed metadata or category definitions miss the
cache. New categories require only their missing questions. Moving model aliases,
invalid/missing scores, and failed requests do not create persistent entries.

TTL: 5 minutes for live/premiere videos or scores between 0.1 and 0.7; otherwise
1 hour for sparse metadata and 24 hours for complete metadata. Reads never extend
expiry. The cache holds at most 10,000 score pairs, storing hashes/probabilities/
timestamps, without raw video metadata. It defaults to
`backend/.cache/judgments.sqlite3`; see `.env.example` for overrides or disabling it.
Local cache persistence is across restarts; Lambda `/tmp` is per environment only.

`POST /cache/clear` clears this database. The extension's **Refresh video decisions**
button clears it together with local decisions and validation diagnostics and preserves preferences
and blocks. Old in-flight requests cannot refill a cleared generation. Cache
storage failure falls back to a provider call; clear failure is reported explicitly.
Diagnostics includes hits, shared in-flight scores, provider calls/questions, and
actual token usage. A full cache hit makes zero Jev calls and reports zero provider tokens.

## Safety and failure behavior

- Video metadata is explicitly treated as untrusted data, never instructions.
- Only the active typed objectives and current batch metadata are sent.
- Strict request and response validation rejects unknown fields and malformed probabilities.
- Missing or invalid video judgments become uncertain.
- Authentication, validation, rate-limit, overload, network, and malformed-response failures return stable error codes.
- There is no automatic provider fallback or automatic retry.
- Noul probabilities are uncertainty signals, not measured accuracy.

## Tests

Tests use fake TypeSafe responses and make no network calls:

```bash
python3 -m unittest discover -s backend/tests -v
```

## SAM blueprint

`template.yaml` defines API Gateway routes for health, objective validation, video classification, and cache clearing plus one Python 3.12 Lambda. It deploys nothing until `sam deploy` runs.

```bash
sam build --template-file backend/template.yaml
sam deploy --guided
```

The guided deployment asks for `TypeSafeApiKey` and `TypeSafeModel`. `NoEcho` masks the key in normal CloudFormation output. Before public deployment, use managed secrets, authenticated clients, per-user quotas, restricted CORS, logs with redaction, and a retention policy.

## Start automatically at login (Linux)

`bash backend/install_autostart.sh --print` previews a per-user systemd unit.
After stopping any manual process on port 3000, run
`bash backend/install_autostart.sh --install` to enable it at login and start it.
See [architecture and autostart](../docs/ARCHITECTURE.md) for status, logs, removal, and limitations.
This is separate from the extension's automatic activation on YouTube.
