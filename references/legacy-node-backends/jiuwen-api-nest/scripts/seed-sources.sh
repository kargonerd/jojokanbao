#!/usr/bin/env bash
set -euo pipefail

API_BASE=${API_BASE:-http://localhost:3001}

curl -s -X POST "$API_BASE/sources" -H "Content-Type: application/json" -d '{"name":"人民网","rssUrl":"http://www.people.com.cn/rss/politics.xml"}'
curl -s -X POST "$API_BASE/sources" -H "Content-Type: application/json" -d '{"name":"新华网","rssUrl":"http://www.xinhuanet.com/politics/news_politics.xml"}'
