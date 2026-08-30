#!/usr/bin/env bash
set -euo pipefail

# Scheduled workflows only execute from the repository's default branch.  A
# completed batch may still have started on a now-merged research branch, so
# every idempotent wake-up is routed to the default branch.  The watchdog's
# repository-wide active-run inventory keeps those draining branch jobs from
# being dispatched a second time.
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"

dispatch_ref="$(
  gh repo view "$GITHUB_REPOSITORY" \
    --json defaultBranchRef \
    --jq '.defaultBranchRef.name' \
    2>/dev/null || true
)"
if [ -z "$dispatch_ref" ]; then
  dispatch_ref="$GITHUB_REF_NAME"
  echo "::warning::Could not resolve the default branch; falling back to $dispatch_ref."
fi

active_watchdogs="$(
  gh run list \
    --repo "$GITHUB_REPOSITORY" \
    --workflow parser-validation-watchdog.yml \
    --branch "$dispatch_ref" \
    --limit 20 \
    --json status,createdAt \
    --jq '[
      .[]
      | select(
          .status == "in_progress"
          or (
            (.status == "queued"
              or .status == "waiting"
              or .status == "pending"
              or .status == "requested")
            and ((try (.createdAt | fromdateiso8601) catch 0)
              >= (now - 1800))
          )
        )
    ] | length' \
    2>/dev/null || true
)"

if [[ "${active_watchdogs:-}" =~ ^[0-9]+$ ]] && [ "$active_watchdogs" -gt 0 ]; then
  echo "Parser validation watchdog already queued/running; skip wake-up."
  exit 0
fi

for attempt in 1 2 3; do
  if gh workflow run parser-validation-watchdog.yml \
      --repo "$GITHUB_REPOSITORY" \
      --ref "$dispatch_ref"; then
    echo "Woke parser validation watchdog on $dispatch_ref."
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then
    sleep $((attempt * 5))
  fi
done

# A wake-up is best effort.  The completed archive checkpoint is durable and
# a later batch or manual watchdog invocation can recover from a transient API
# failure without turning a successful capture into a failed workflow.
echo "::warning::Could not wake parser validation watchdog after 3 attempts."
exit 0
