#!/usr/bin/env bash
# Install the existing localhost API as a per-user Linux systemd service.
set -euo pipefail
backend_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -x "$backend_dir/.venv/bin/python" || ! -f "$backend_dir/.env" ]]; then
  echo 'Set up backend/.venv and backend/.env before installing autostart.' >&2
  exit 1
fi
if [[ "${1:-}" == "--print" ]]; then
  :
elif [[ "${1:-}" != "--install" ]]; then
  echo 'Usage: bash backend/install_autostart.sh --print | --install' >&2
  exit 1
fi
# systemd does not invoke a shell for ExecStart. Quote paths and escape percent specs.
service_path="${backend_dir//%/%%}"
service_path="${service_path//\\/\\\\}"
service_path="${service_path//\"/\\\"}"
unit="$(cat <<UNIT
[Unit]
Description=FocusFeed localhost classifier
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash "${service_path}/run_local.sh"
Restart=on-failure
RestartSec=10
UMask=0077
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
UNIT
)"
if [[ "${1}" == "--print" ]]; then
  printf '%s\n' "$unit"
  exit 0
fi
systemctl --user show-environment >/dev/null
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
printf '%s\n' "$unit" > "$unit_dir/focusfeed.service"
systemctl --user daemon-reload
systemctl --user enable --now focusfeed.service
systemctl --user status focusfeed.service --no-pager
