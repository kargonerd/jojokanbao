#!/usr/bin/env bash
set -euo pipefail

# The runner's apt mirror can stall even when browser binaries are cached.
# Scope these options to this command; do not change the runner's apt sources.
test "$#" -gt 0
config="$(mktemp "${RUNNER_TEMP:?}/jojo-apt.XXXXXX")"
trap 'rm -f -- "$config"' EXIT
printf '%s\n' \
  'Acquire::Retries "2";' \
  'Acquire::http::Timeout "20";' \
  'Acquire::https::Timeout "20";' \
  'APT::Update::Error-Mode "any";' > "$config"
sudo env "APT_CONFIG=$config" "$@"
