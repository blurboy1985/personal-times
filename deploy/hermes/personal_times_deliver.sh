#!/usr/bin/env bash
# Hermes no-agent cron: 07:00 SGT, after the 06:35 build and Sites upload.
# Delivery verifies/retries the upload, emails the Sites link, then emits Telegram
# text on stdout. If today's edition is missing, it first builds a wire edition.
# Pass --dry-run to check the link without uploading or sending messages.
set -euo pipefail
exec "$HOME/personal-times/deploy/personal-times-run.sh" deliver "$@"
