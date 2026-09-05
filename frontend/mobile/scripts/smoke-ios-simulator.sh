#!/usr/bin/env bash

set -euo pipefail

readonly app_path="${1:?Usage: smoke-ios-simulator.sh APP_PATH ARTIFACTS_DIR}"
readonly artifacts_dir="${2:?Usage: smoke-ios-simulator.sh APP_PATH ARTIFACTS_DIR}"
readonly expected_bundle_id="com.luoxixi.jojokanbao"

if [[ ! -d "$app_path" ]]; then
  echo "Simulator app not found: $app_path" >&2
  exit 1
fi

mkdir -p "$artifacts_dir"

simulator_info="$(xcrun simctl list devices available -j | node -e '
  const input = require("node:fs").readFileSync(0, "utf8");
  const runtimes = Object.entries(JSON.parse(input).devices)
    .filter(([runtime]) => runtime.includes(".SimRuntime.iOS-"))
    .sort(([left], [right]) => right.localeCompare(left, undefined, { numeric: true }));

  const iphone = runtimes
    .flatMap(([, devices]) => devices)
    .find((device) => device.isAvailable !== false && device.name.startsWith("iPhone"));
  if (iphone) {
    process.stdout.write([iphone.udid, iphone.name, iphone.state].join("\t"));
  }
')"

if [[ -z "$simulator_info" ]]; then
  echo "No available iPhone simulator was found" >&2
  exit 1
fi

IFS=$'\t' read -r simulator_id simulator_name simulator_state <<< "$simulator_info"
readonly simulator_id simulator_name
booted_here=false
launched=false

capture_diagnostics() {
  xcrun simctl io "$simulator_id" screenshot "$artifacts_dir/launch.png" >/dev/null 2>&1 || true
  xcrun simctl spawn "$simulator_id" log show \
    --last 2m \
    --style compact \
    --predicate 'process == "JOJO" OR senderImagePath CONTAINS "JOJO"' \
    > "$artifacts_dir/app.log" 2>&1 || true
}

cleanup() {
  local -r exit_code=$?
  capture_diagnostics
  if [[ "$launched" == true ]]; then
    xcrun simctl terminate "$simulator_id" "$expected_bundle_id" >/dev/null 2>&1 || true
  fi
  if [[ "$booted_here" == true ]]; then
    xcrun simctl shutdown "$simulator_id" >/dev/null 2>&1 || true
  fi
  return "$exit_code"
}
trap cleanup EXIT

if [[ "$simulator_state" != "Booted" ]]; then
  xcrun simctl boot "$simulator_id"
  booted_here=true
fi
xcrun simctl bootstatus "$simulator_id" -b

readonly actual_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Info.plist")"
readonly marketing_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Info.plist")"
if [[ "$actual_bundle_id" != "$expected_bundle_id" ]]; then
  echo "Unexpected simulator bundle identifier: $actual_bundle_id" >&2
  exit 1
fi

xcrun simctl install "$simulator_id" "$app_path"
launch_output="$(xcrun simctl launch --terminate-running-process "$simulator_id" "$actual_bundle_id")"
readonly launch_output
app_pid="${launch_output##*: }"
readonly app_pid
if [[ ! "$app_pid" =~ ^[0-9]+$ ]]; then
  echo "Could not parse the launched app PID from: $launch_output" >&2
  exit 1
fi
launched=true

for _ in {1..10}; do
  sleep 1
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "The iOS app exited during the launch smoke test" >&2
    exit 1
  fi
done

xcrun simctl io "$simulator_id" screenshot "$artifacts_dir/launch.png"
test -s "$artifacts_dir/launch.png"
sips -g pixelWidth -g pixelHeight "$artifacts_dir/launch.png" > "$artifacts_dir/screenshot.txt"
xcrun simctl spawn "$simulator_id" log show \
  --last 2m \
  --style compact \
  --predicate 'process == "JOJO" OR senderImagePath CONTAINS "JOJO"' \
  > "$artifacts_dir/app.log" 2>&1 || true

printf 'Simulator: %s (%s)\nBundle: %s\nVersion: %s\nPID: %s\nLaunch survival: 10 seconds\n' \
  "$simulator_name" "$simulator_id" "$actual_bundle_id" "$marketing_version" "$app_pid" \
  | tee "$artifacts_dir/summary.txt"
