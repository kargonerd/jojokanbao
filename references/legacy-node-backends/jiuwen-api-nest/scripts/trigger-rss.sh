#!/usr/bin/env bash
set -euo pipefail

API_BASE=${API_BASE:-http://localhost:3001}

curl -s -X POST "$API_BASE/jobs/fetch-rss"
