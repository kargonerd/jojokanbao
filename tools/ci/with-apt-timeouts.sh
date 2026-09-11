#!/usr/bin/env bash
set -euo pipefail

# The runner's apt mirror can stall even when browser binaries are cached.
# Times needs only Ubuntu packages. Unrelated runner repositories (for example
# Chrome) must not block installation when their indexes are inconsistent.
# Scope these options to this command; preserve the runner's source files and
# Ubuntu mirror failover, signing keys, and package integrity checks.
test "$#" -gt 0
if ! test -s /etc/apt/sources.list.d/ubuntu.sources; then
  echo "Expected the hosted Ubuntu runner's ubuntu.sources file" >&2
  exit 1
fi
config="$(mktemp "${RUNNER_TEMP:?}/jojo-apt.XXXXXX")"
trap 'rm -f -- "$config"' EXIT
printf '%s\n' \
  'Dir::Etc::sourcelist "/etc/apt/sources.list.d/ubuntu.sources";' \
  'Dir::Etc::sourceparts "-";' \
  'Acquire::Retries "2";' \
  'Acquire::http::Timeout "20";' \
  'Acquire::https::Timeout "20";' \
  'APT::Update::Error-Mode "any";' > "$config"
sudo env "APT_CONFIG=$config" "$@"
