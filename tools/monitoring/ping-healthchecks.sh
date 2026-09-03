#!/usr/bin/env bash

set -uo pipefail

ping_url="${HEALTHCHECKS_PING_URL:-}"
signal="${HEALTHCHECKS_SIGNAL:-success}"
task_id="${HEALTHCHECKS_TASK_ID:-unknown}"
stage="${HEALTHCHECKS_STAGE:-scheduled-job}"
status="${HEALTHCHECKS_STATUS:-unknown}"
failure_type="${HEALTHCHECKS_FAILURE_TYPE:-}"
scheduled_at="${HEALTHCHECKS_SCHEDULED_AT:-}"
slot_id="${HEALTHCHECKS_SLOT_ID:-}"
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

payload="task=${task_id}
stage=${stage}
status=${status}
failure_type=${failure_type}
scheduled_at=${scheduled_at}
slot_id=${slot_id}
run=${run_url}"

curl --fail --silent --show-error \
  --max-time 10 \
  --retry 5 \
  --retry-all-errors \
  --data-binary "$payload" \
  "$target"
