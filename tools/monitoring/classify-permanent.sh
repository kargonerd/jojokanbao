#!/usr/bin/env bash
# Source only inside deterministic input/configuration validation steps, never
# around network or business work. Preserve the original command's exit status.
trap 'monitor_validation_status=$?; if [ "$monitor_validation_status" -ne 0 ]; then printf "%s\n" "HEALTHCHECKS_FAILURE_CLASS=permanent" >> "$GITHUB_ENV"; fi' EXIT
