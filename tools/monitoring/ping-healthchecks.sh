#!/usr/bin/env bash

set -uo pipefail

ping_url="${HEALTHCHECKS_PING_URL:-}"
signal="${HEALTHCHECKS_SIGNAL:-success}"
stage="${HEALTHCHECKS_STAGE:-scheduled-job}"
status="${HEALTHCHECKS_STATUS:-unknown}"
run_url="${HEALTHCHECKS_RUN_URL:-}"

if [ -z "$ping_url" ]; then
  echo "::warning::Healthchecks ping URL is not configured for ${stage}."
  exit 0
fi

case "$signal" in
  success)
    target="${ping_url%/}"
    ;;
  start|fail|log)
    target="${ping_url%/}/${signal}"
    ;;
  *)
    echo "Unsupported Healthchecks signal: ${signal}" >&2
    exit 2
    ;;
esac

payload="stage=${stage}
status=${status}
run=${run_url}"

curl --fail --silent --show-error \
  --max-time 10 \
  --retry 5 \
  --retry-all-errors \
  --data-binary "$payload" \
  "$target"
