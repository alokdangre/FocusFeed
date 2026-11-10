"""Build a reproducible store candidate from an explicit runtime allowlist.

No uploads, deployments, account changes, or provider calls. A candidate is not
proof of live YouTube, TypeSafe, or privacy readiness.
"""

import argparse
import hashlib
import json
import re
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = """
LICENSE manifest.json background.js settings.js channel-policy.js video-model.js
request-broker.js score-cache.js learning-policy.js channel-evidence.js
channel-investigations.js channel-learning.js account-client.js job-client.js
byok-contract.js byok-client.js
page-gate.js interceptor.js auto-runtime.js home-feed.js preview-controller.js
loading-ui.js topic-picker.js preferences-controller.js display-settings.js
youtube-preferences.js youtube-display.js shorts-queue.js shorts-feed.js
youtube-ui.js content.js youtube.css youtube-preferences.css display-settings.css
youtube-display.css popup/popup.html popup/popup.js popup/popup.css
popup/topic-input.js observability/observability.html observability/observability.js
observability/observability.css icons/icon-16.png icons/icon-32.png
icons/icon-48.png icons/icon-128.png
popup/fonts/dm-sans-400.ttf popup/fonts/dm-sans-500.ttf popup/fonts/dm-sans-600.ttf
popup/fonts/instrument-serif.ttf popup/fonts/DM-Sans-OFL.txt popup/fonts/Instrument-Serif-OFL.txt
""".split()
LOCAL = "http://127.0.0.1:3000"


def replace_once(data, old, new, name):
    if data.count(old) != 1:
        raise ValueError(f"{name}: expected one release substitution for {old!r}; review the builder after source changes.")
    return data.replace(old, new)


def source_files(source):
    source = source.resolve()
    result = {}
    for name in RUNTIME:
        path = source / name
        if not path.resolve().is_relative_to(source) or path.is_symlink():
            raise ValueError(f"Refusing runtime file outside source or symlink: {name}")
        result[name] = path.read_bytes()
    manifest = json.loads(result["manifest.json"])
    references = [manifest["background"]["service_worker"], manifest["action"]["default_popup"]]
    references += list(manifest.get("icons", {}).values())
    references += list(manifest["action"].get("default_icon", {}).values())
    for group in manifest["content_scripts"]:
        references += group.get("js", []) + group.get("css", [])
    for name, data in result.items():
        if name.endswith(".js"):
            for imports in re.findall(r"importScripts\(([^)]+)\)", data.decode()):
                references += re.findall(r'["\']([^"\']+)["\']', imports)
        if name.endswith(".html"):
            for asset in re.findall(r'(?:src|href)="([^"#:]+\.(?:js|css))"', data.decode()):
                resolved = (source / name).parent.joinpath(asset).resolve()
                if not resolved.is_relative_to(source):
                    raise ValueError(f"HTML reference escapes extension: {asset}")
                references.append(resolved.relative_to(source).as_posix())
        if name.endswith(".css"):
            for asset in re.findall(r'url\(["\']?([^"\')]+)["\']?\)', data.decode()):
                if asset.startswith("data:"):
                    continue
                resolved = (source / name).parent.joinpath(asset).resolve()
                if not resolved.is_relative_to(source):
                    raise ValueError(f"CSS reference escapes extension: {asset}")
                references.append(resolved.relative_to(source).as_posix())
    for name in references:
        if name not in result:
            raise ValueError(f"Runtime dependency missing from release allowlist: {name}")
    for size in (16, 32, 48, 128):
        png = result[f"icons/icon-{size}.png"]
        if png[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", png[16:24]) != (size, size):
            raise ValueError(f"Invalid {size}px PNG icon")
    if manifest["manifest_version"] != 3 or set(manifest["permissions"]) != {"storage", "identity"}:
        raise ValueError("Review changed manifest version/permissions before packaging.")
    return result


def release_files(source):
    endpoint = "https://api.typesafe.ai"
    result = source_files(source)
    manifest = json.loads(result["manifest.json"])
    manifest["permissions"] = ["storage"]
    manifest["host_permissions"] = ["https://*.youtube.com/*", endpoint + "/*"]
    manifest["minimum_chrome_version"] = "102"
    for group in manifest["content_scripts"]:
        group["matches"] = ["https://*.youtube.com/*"]
    manifest.pop("optional_host_permissions", None)
    manifest["content_security_policy"] = {"extension_pages": "script-src 'self'; object-src 'self'"}
    result["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    for name, constant in (("background.js", "DEFAULT_CLASSIFIER_ENDPOINT"), ("popup/popup.js", "DEFAULT_ENDPOINT")):
        code = result[name].decode()
        code = replace_once(code, f'var {constant} = "{LOCAL}";', f"var {constant} = {json.dumps(endpoint)};", name)
        result[name] = code.encode()
    name = "popup/popup.html"
    html = result[name].decode()
    html = replace_once(html, f'placeholder="{LOCAL}"', f'value="{endpoint}" disabled aria-label="OwnFeed service address"', name)
    result[name] = html.encode()
    return result


def write_candidate(files, destination):
    # Fixed timestamps, ordering and permissions make identical inputs reproducible.
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            archive.writestr(info, data)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check local source completeness without building")
    parser.add_argument("--output", type=Path, help="ZIP path; defaults to dist/ownfeed-VERSION.zip")
    args = parser.parse_args()
    try:
        if args.check:
            files = release_files(ROOT / "extension")
            print(f"Local package checks passed: {len(files)} runtime files. Live release gates are still required.")
            return
        files = release_files(ROOT / "extension")
        version = json.loads(files["manifest.json"])["version"]
        destination = args.output or ROOT / "dist" / f"ownfeed-{version}.zip"
        digest = write_candidate(files, destination)
        receipt = {"status": "candidate-not-approved-for-submission", "version": version,
                   "mode": "free-typesafe-byok", "providerUrl": "https://api.typesafe.ai", "sha256": digest,
                   "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())},
                   "requiredLiveChecks": ["Live Chrome/YouTube BYOK tests", "Real TypeSafe key/model access",
                                          "Current public policies and website copy", "Real screenshots and reviewer access"]}
        destination.with_suffix(".release.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(f"Candidate: {destination}\nSHA256: {digest}\nNOT submission approval. Complete docs/STORE_RELEASE.md.")
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, f"Release check failed: {exc}\n")


if __name__ == "__main__":
    main()
