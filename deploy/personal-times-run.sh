#!/usr/bin/env bash
# Scheduled Sites workflow. stdout is reserved for Hermes delivery text.
set -euo pipefail
case "${1:-}" in
  build|deliver) ;;
  *) echo 'Usage: personal-times-run.sh {build|deliver} [options]' >&2; exit 2 ;;
esac
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
./.venv/bin/python - <<'PY'
from dailytimes.sites import configuration
cfg = configuration()
if not cfg or not all(isinstance(cfg.get(key), str) and cfg[key].strip() for key in ('bypass_token', 'upload_key')):
    raise SystemExit('Sites publishing is not configured; scheduled delivery stopped. Check the private sites.json configuration.')
PY
exec ./.venv/bin/python -m dailytimes "$@"
