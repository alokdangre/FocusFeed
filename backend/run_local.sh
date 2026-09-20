#!/usr/bin/env bash
set -euo pipefail

backend_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "${backend_dir}/.." && pwd)"
env_file="${backend_dir}/.env"
python_bin="${backend_dir}/.venv/bin/python"

if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

if [[ ! -x "${python_bin}" ]]; then
  echo "Missing backend virtual environment. Run:" >&2
  echo "  python3 -m venv backend/.venv" >&2
  echo "  backend/.venv/bin/pip install -r backend/requirements.txt" >&2
  exit 1
fi

cd "${project_dir}"
exec "${python_bin}" -m backend.dev_server

