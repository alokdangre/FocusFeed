# FocusFeed TypeSafe Jev backend

The backend exposes a small server-side adapter for TypeSafe System One. It maps user intent to a versioned topic taxonomy, then classifies YouTube metadata against the user-confirmed topics. `TYPESAFE_API_KEY` stays on the server and is never stored in the extension.

## Current Jev design

Intent mapping uses one independent `Noul` per taxonomy topic plus one understood `Noul` per entry:

- multiple topics can be suggested for the same entry and no topic is forced;
- topics at or above `0.60` are preselected suggestions;
- the popup shows all topic scores and requires the user to confirm or edit the mapping before saving;
- the taxonomy ID and `focusfeed-topics-v1` version are stored in the profile.

Video classification uses one diagnostic evidence Noul per video and one direct match Noul per video/topic pair. The match question explicitly compares title, description, and channel with the canonical topic definition, inclusions, and exclusions. Application code computes:

- match: any direct topic match >= 0.50;
- no match: all direct topic matches <= 0.20;
- uncertain: otherwise.

The evidence Noul remains observable but is not a decision gate.

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

The request accepts 1-8 unique entries of 1-160 characters. The response includes the full taxonomy, taxonomy version, every topic Noul, suggested topics, understood probability, reason, thresholds, raw judgments, model, prompt version, timing, and usage.

The response never silently saves a model choice. The extension renders editable topic checkboxes and saves only the user's confirmed selection.

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
        "id": "topic.gaming",
        "text": "Gaming",
        "contentType": "topic",
        "taxonomyId": "topic.gaming",
        "taxonomyVersion": "focusfeed-topics-v1",
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

A batch accepts 1-12 unique videos. The response contains one assessment per video with the diagnostic `evidenceProbability`, every `objectiveMatches[].matchProbability`, the computed outcome, metadata evidence, and a reason. Diagnostics retain thresholds, raw judgments, missing IDs, unexpected question IDs, timing, and TypeSafe usage.

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

`template.yaml` defines API Gateway routes for health, objective validation, and video classification plus one Python 3.12 Lambda. It deploys nothing until `sam deploy` runs.

```bash
sam build --template-file backend/template.yaml
sam deploy --guided
```

The guided deployment asks for `TypeSafeApiKey` and `TypeSafeModel`. `NoEcho` masks the key in normal CloudFormation output. Before public deployment, use managed secrets, authenticated clients, per-user quotas, restricted CORS, logs with redaction, and a retention policy.

## Start automatically at login (Linux)

`bash backend/install_autostart.sh --print` previews a per-user systemd unit.
After stopping any manual process on port 3000, run
`bash backend/install_autostart.sh --install` to enable it at login and start it.
See `../docs/ALWAYS_ON_ARCHITECTURE.md` for status, logs, removal, and limitations.
This is separate from the extension's automatic activation on YouTube.
