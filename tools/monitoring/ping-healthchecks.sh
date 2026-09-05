#!/usr/bin/env bash

set -uo pipefail

ping_url="${HEALTHCHECKS_PING_URL:-}"
ping_key="${HEALTHCHECKS_PING_KEY:-}"
signal="${HEALTHCHECKS_SIGNAL:-success}"
task_id="${HEALTHCHECKS_TASK_ID:-unknown}"
stage="${HEALTHCHECKS_STAGE:-scheduled-job}"
status="${HEALTHCHECKS_STATUS:-unknown}"
failure_type="${HEALTHCHECKS_FAILURE_TYPE:-}"
scheduled_at="${HEALTHCHECKS_SCHEDULED_AT:-}"
slot_id="${HEALTHCHECKS_SLOT_ID:-}"
run_url="${HEALTHCHECKS_RUN_URL:-}"

if [ -n "$ping_key" ]; then
  if ! [[ "$task_id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "Invalid Healthchecks task id for project ping key: ${task_id}" >&2
    exit 2
  fi
  ping_url="https://hc-ping.com/${ping_key}/${task_id}"
fi

if [ -z "$ping_url" ]; then
  echo "::warning::Healthchecks project ping key or legacy ping URL is not configured for ${stage}."
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

# CF consumes outcomes and is the only up/down writer in buffered mode. Curl
# retries reuse the execution identity and timestamp; log/no-op is not success.
if [ "${HEALTHCHECKS_REPORT_MODE:-direct}" = 'buffered' ] && { [ "$signal" = 'success' ] || [ "$signal" = 'fail' ]; }; then
  if ! [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] || ! [[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]]; then
    echo 'Buffered monitoring requires a GitHub run id and attempt' >&2
    exit 2
  fi
  failure_class="${HEALTHCHECKS_FAILURE_CLASS:-unknown}"
  case "$failure_class" in unknown|retryable|permanent) ;; *) echo 'Invalid monitoring failure class' >&2; exit 2 ;; esac
  outcome='failure'
  [ "$signal" != 'success' ] || outcome='success'
  payload="monitor_event=v1
event_time=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
run_id=${GITHUB_RUN_ID}
run_attempt=${GITHUB_RUN_ATTEMPT}
outcome=${outcome}
failure_class=${failure_class}
${payload}"
  target="${ping_url%/}/log"
fi

curl --fail --silent --show-error \
  --max-time 10 \
  --retry 5 \
  --retry-all-errors \
  --data-binary "$payload" \
  "$target"
