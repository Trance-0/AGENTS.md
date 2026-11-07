#!/usr/bin/env bash
# Task 6: PCP in the platform zone, plus new features.
# Verifies: duplicate idempotency key creates one record; a session token can't read another topic;
# a fake key is redacted; the source label survives export.
# Run on your own platform host, not on a work machine.
#
# TODO: adjust every endpoint and JSON field below. The PCP agent schema (/api/v1/agent/schema/)
# returned 404 when this was written, so these paths are placeholders.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

: "${PCP_URL:=http://127.0.0.1:8700}"
: "${PCP_SESSION_ID:?set PCP_SESSION_ID (a test session)}"
: "${PCP_SESSION_TOKEN:?set PCP_SESSION_TOKEN (token scoped to PCP_SESSION_ID)}"
: "${PCP_OTHER_TOPIC_ID:?set PCP_OTHER_TOPIC_ID (a topic the token must not read)}"

need curl jq

AUTH=(-H "Authorization: Bearer $PCP_SESSION_TOKEN" -H 'Content-Type: application/json')
MSGS="$PCP_URL/api/v1/sessions/$PCP_SESSION_ID/messages"
RUN_ID="checks-$(date +%s)-$$"

append() { # append <idempotency-key> <text>
  curl -fs "${AUTH[@]}" -H "Idempotency-Key: $1" -X POST "$MSGS" \
    -d "$(jq -n --arg t "$2" '{role:"user", content:$t, source:{channel:"checks", principal:"owner", trust:"trusted"}}')"
}

check_idempotency() {
  local n
  append "$RUN_ID-dup" "idempotency probe $RUN_ID" >/dev/null
  append "$RUN_ID-dup" "idempotency probe $RUN_ID" >/dev/null || true
  n=$(curl -fs "${AUTH[@]}" "$MSGS" | jq --arg r "idempotency probe $RUN_ID" '[.messages[] | select(.content == $r)] | length')
  if [ "$n" = "1" ]; then pass "duplicate idempotency key stored once"; else fail "found $n copies, want 1"; fi
}

check_topic_scope() {
  local code
  code=$(http_code "${AUTH[@]}" "$PCP_URL/api/v1/topics/$PCP_OTHER_TOPIC_ID/sessions")
  if [ "$code" = "403" ] || [ "$code" = "404" ]; then pass "session token cannot read other topic ($code)"
  else fail "session token got $code on another topic"; fi
}

check_redaction() {
  local key body
  key=$(fake_key)
  append "$RUN_ID-redact" "redaction probe $RUN_ID $key" >/dev/null
  body=$(curl -fs "${AUTH[@]}" "$MSGS")
  if echo "$body" | grep -q "redaction probe $RUN_ID" && ! echo "$body" | grep -q "$key"; then
    pass "fake key redacted on append"
  else fail "fake key stored verbatim, or probe message missing"; fi
}

check_source_label_in_export() {
  local ch
  ch=$(curl -fs "${AUTH[@]}" "$PCP_URL/api/v1/sessions/$PCP_SESSION_ID/export" \
    | jq -r --arg r "idempotency probe $RUN_ID" '.messages[] | select(.content == $r) | .source.channel' | head -n 1)
  if [ "$ch" = "checks" ]; then pass "source label survives export"; else fail "export source.channel = '${ch:-missing}'"; fi
}

check_idempotency
check_topic_scope
check_redaction
check_source_label_in_export
finish
