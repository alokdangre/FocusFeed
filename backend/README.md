# Development API

The Chrome Web Store extension calls TypeSafe directly and does not require this
server. The backend supports local API development and holds the canonical topic,
video and channel prompts exported into the extension.

## Local setup

Requires Python 3.11+:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt
cp backend/.env.example backend/.env
```

Set TYPESAFE_API_KEY in backend/.env, then start the loopback-only server:

```sh
bash backend/run_local.sh --local
```

The launcher loads backend/.env. Never commit that file or expose local guest
mode through a public server. Live classification consumes provider credits.

## Shared prompts

After changing classifier, channel_classifier or taxonomy:

```sh
backend/.venv/bin/python tools/export_byok_contract.py
backend/.venv/bin/python tools/export_byok_contract.py --check
```

The committed extension/byok-contract.js lets users run the extension without
Python or a backend. Keep its generated model and question versions aligned with
the source prompts; changed questions invalidate the corresponding cache identity.

## Tests

```sh
backend/.venv/bin/python -m unittest discover -s backend/tests
```

Tests use mock providers and storage. They do not verify a live TypeSafe account,
AWS deployment or payment-provider integration.

## Source layout

- classifier.py, channel_classifier.py, taxonomy.py: prompts and judgments.
- models.py: validated request and response contracts.
- dev_server.py, handler.py: local HTTP and Lambda entry points.
- auth.py, accounts.py, controls.py: hosted authentication and access controls.
- jobs.py, billing.py, dodo.py: optional hosted job and billing infrastructure.
- template.yaml: AWS SAM deployment configuration.

Hosted infrastructure is separate from the free BYOK release. Deploying it
requires its own authentication, storage, billing configuration and verification;
it is not needed to build or install the store extension.
