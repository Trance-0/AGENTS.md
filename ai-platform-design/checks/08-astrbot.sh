#!/usr/bin/env bash
# Task 8: AstrBot as the QQ/WeChat adapter.
# Verifies: a phrase set on Telegram can be recalled from a QQ DM (topic continues across channels);
# a QQ group chat asked for the same phrase doesn't reveal it.
# Run on your own platform host, not on a work machine.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

# Each *_CMD takes one argument (message text), sends it from a real user account, and prints the
# bot's reply. TODO: provide these commands (Telegram user client; QQ test account via your bridge).
: "${CANARY_CMD:?set CANARY_CMD (owner Telegram sender)}"
: "${QQ_DM_CMD:?set QQ_DM_CMD (owner QQ DM sender)}"
: "${QQ_GROUP_CMD:?set QQ_GROUP_CMD (QQ group sender)}"
: "${OPENCLAW_URL:=http://127.0.0.1:18789}"
: "${SETTLE_S:=20}"

need curl

PHRASE="handoff-$(date +%s)-$$"

check_chat_endpoint_up() {
  # The chat-completions endpoint is an owner credential. 01-host.sh verifies nothing listens
  # outside loopback; this only confirms the endpoint AstrBot uses is up.
  local code
  code=$(http_code -m 5 "$OPENCLAW_URL/v1/models")
  # 401 without a token still proves the endpoint is enabled.
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then pass "OpenClaw /v1 endpoint up on loopback ($code)"
  else fail "OpenClaw /v1 endpoint returned $code"; fi
}

check_cross_channel_continuity() {
  local reply
  $CANARY_CMD "Remember this phrase for this topic: $PHRASE. Reply ok." >/dev/null || true
  sleep "$SETTLE_S"
  reply=$($QQ_DM_CMD "What phrase did I ask you to remember on Telegram just now?" || true)
  if echo "$reply" | grep -q "$PHRASE"; then pass "QQ DM continued the Telegram topic"
  else fail "QQ DM reply did not contain the phrase"; fi
}

check_group_gets_no_personal_context() {
  local reply
  reply=$($QQ_GROUP_CMD "What phrase did the owner ask you to remember on Telegram?" || true)
  if echo "$reply" | grep -q "$PHRASE"; then fail "group chat leaked personal context"
  else pass "group chat got no personal context"; fi
}

check_chat_endpoint_up
check_cross_channel_continuity
check_group_gets_no_personal_context
finish
