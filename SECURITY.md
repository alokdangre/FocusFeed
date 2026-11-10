# Security

## Scope

Report issues involving API-key exposure, sender validation, unexpected data
transfers, request amplification, or execution of untrusted content. Use the
latest candidate; older snapshots may not receive patches.

## Report privately

Do not post secrets, exploit details or private browsing data in public issues.
If this repository's Security tab offers **Report a vulnerability**, use that
private form. Include the affected version, impact, minimal reproduction and
redacted evidence. Do not include a working API key.

If that private form is unavailable, open an issue saying only that you need a
private security contact route, without disclosing the vulnerability or personal
information. Wait for a maintainer to arrange a private channel. Private reporting
must be enabled in GitHub settings before the repository's public launch; adding
this file does not enable the feature. No response-time guarantee is offered.

## Credential handling

TypeSafe keys belong in the extension's session-only key setup or a gitignored
backend/.env for local backend development. Never embed them in code or a release
ZIP. The released extension sends the key only to api.typesafe.ai over HTTPS.
If a credential is disclosed, revoke/rotate it first; deleting a file does not
remove Git history, forks or copies. Never run live-provider tests with contributor
code unless you have reviewed it and accept the usage charges.
