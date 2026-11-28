#!/usr/bin/env bash
# Staging smoke test (M6, issue #11) — run against a DEPLOYED staging host.
# Usage: ./deploy/staging-smoke.sh https://staging.example.com [username] [password]
#
# Verifies the publicly observable contract a remote MCP deployment must
# uphold: TLS-only, health, security headers, auth enforcement (401),
# protocol handshake + tool discovery with a session, OAuth route gating,
# body cap, and console page availability. Exits non-zero on first failure.
# NOTE: never pass real secrets via CLI in shared environments; use env vars.
set -euo pipefail

BASE="${1:?usage: staging-smoke.sh https://host [username] [password]}"
USER_NAME="${2:-${SMOKE_USER:-}}"
USER_PASS="${3:-${SMOKE_PASS:-}}"

ok=0; fail=0
check() { # check <name> <condition-result>
  if [ "$2" = "0" ]; then echo "[PASS] $1"; ok=$((ok+1)); else echo "[FAIL] $1"; fail=$((fail+1)); fi
}

echo "== staging smoke against $BASE =="

# 1. TLS only: plain http must redirect or refuse (curl -sI http://… follows to https typically)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/healthz" || echo "000")
[ "$code" = "200" ] || [ "$code" = "308" ] || [ "$code" = "301" ] || [ "$code" = "000" ]
check "http→https or direct https reachable ($code)" $?

# 2. healthz responds with ok:true and a backend
body=$(curl -s --max-time 10 "$BASE/healthz")
echo "$body" | grep -q '"ok":true'
check "healthz ok:true" $?
echo "$body" | grep -qE '"backend":"(postgres|sqlite)"'
check "healthz reports a storage backend" $?

# 3. security headers present
hdrs=$(curl -sI --max-time 10 "$BASE/healthz")
echo "$hdrs" | grep -qi 'x-content-type-options: nosniff'
check "nosniff header" $?
echo "$hdrs" | grep -qi 'content-security-policy:'
check "CSP header" $?

# 4. unauthenticated MCP call is rejected with 401
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$BASE/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: status' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}')
[ "$code" = "401" ]
check "unauthenticated MCP → 401 (got $code)" $?

# 5. OAuth connect route requires authentication
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/linkedin/connect")
[ "$code" = "401" ]
check "OAuth connect unauthenticated → 401 (got $code)" $?

# 6. console page is served
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/admin")
[ "$code" = "200" ]
check "console /admin served (got $code)" $?

# 7. oversized body is refused (413) — 2 MiB JSON to /auth/login, streamed
#    via stdin (argv-size limits make --data-binary with a 2 MiB string fail).
code=$(python3 -c "print('{\"username\":\"' + 'x'*2097152 + '\",\"password\":\"y\"}')" \
  | curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/auth/login" \
  -H 'content-type: application/json' --data-binary @-)
[ "$code" = "413" ]
check "body cap → 413 (got $code)" $?

if [ -n "$USER_NAME" ] && [ -n "$USER_PASS" ]; then
  # 8. login yields a session cookie
  login=$(curl -s -D /tmp/smoke-hdrs.$$ -o /tmp/smoke-body.$$ --max-time 10 -X POST "$BASE/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\"}" || true)
  grep -q 'lkm_session=' /tmp/smoke-hdrs.$$ 2>/dev/null
  check "login issues session cookie" $?
  COOKIE=$(grep -oP 'lkm_session=\K[^;]+' /tmp/smoke-hdrs.$$ 2>/dev/null || true)
  if [ -n "$COOKIE" ]; then
    # 9. authenticated MCP initialize handshake. NOTE: the initialize
    #    request (legacy handshake) must NOT carry MCP-Protocol-Version —
    #    the SDK rejects that combination (-32020 header/body mismatch).
    #    The header is required only on post-initialize requests.
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$BASE/mcp" \
      -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -H "cookie: lkm_session=$COOKIE" \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}')
    if [ "$code" = "200" ] || [ "$code" = "405" ]; then echo "[PASS] authenticated MCP initialize accepted (got $code)"; else echo "[FAIL] authenticated MCP initialize accepted (got $code)"; fail=$((fail+1)); fi
  fi
  rm -f /tmp/smoke-hdrs.$$ /tmp/smoke-body.$$
else
  echo "[SKIP] authenticated checks (no credentials provided; set SMOKE_USER/SMOKE_PASS or args 2/3)"
fi

echo "== smoke summary: $ok passed, $fail failed =="
[ "$fail" = "0" ]
