#!/bin/bash
# Issue helper — reads the GitHub PAT from the GH_PAT env var ONLY.
# (Push-protection incident 2026-11-28: an earlier local revision embedded
# the literal token; GitHub push protection rejected the push and the
# commit never reached the remote. No token may ever appear in a file.)
set -euo pipefail
: "${GH_PAT:?GH_PAT env var required}"
REPO='Hugs-4-Bugs/linkedin-mcp-server'
curl -s -H "Authorization: Bearer $GH_PAT" \
  "https://api.github.com/repos/$REPO/issues?state=open&per_page=5" |
python3 -c "import json,sys; [print(f\"#{i['number']} {i['title'][:60]}\") for i in json.load(sys.stdin)]"
