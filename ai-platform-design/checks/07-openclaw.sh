#!/usr/bin/env bash
# Task 7: OpenClaw executor with Telegram, connected to PCP.
# Verifies: the owner's Telegram message gets a reply and lands in PCP labeled telegram; a
# non-owner message triggers no tools; no keys in the repo or the image; outbound allowlist holds.
# Run on your own platform host, not on a work machine.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

# CANARY_CMD and NONOWNER_CMD take one argument (message text), send it to the bot from a real
# Telegram user account, and print the bot's reply. Bots can't message themselves, so this needs a
# user-account client (for example a small Telethon script). TODO: provide these commands.
: "${CANARY_CMD:?set CANARY_CMD (owner test account sender)}"
: "${NONOWNER_CMD:?set NONOWNER_CMD (non-owner account sender)}"
: "${PCP_URL:=http://127.0.0.1:8700}"
: "${PCP_ADMIN_TOKEN:?set PCP_ADMIN_TOKEN (read-only search token)}"
: "${AGENT_STACK_URL:?set AGENT_STACK_URL}"
: "${REGISTRY:=127.0.0.1:5000}"
: "${IMAGE:=agent-stack}"
: "${OPENCLAW_CONTAINER:=openclaw}"
: "${AGENT_USER:=agent}"
: "${BLOCKED_URL:=https://example.com}"

need curl jq git gitleaks podman sudo

PHRASE="canary-$(date +%s)-$$"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

check_owner_reply_recorded() {
  local reply hit
  reply=$($CANARY_CMD "Reply with the word ack. Canary $PHRASE" || true)
  if [ -n "$reply" ]; then pass "owner canary got a reply"; else fail "owner canary got no reply"; fi
  sleep 5
  # TODO: adjust to PCP's search endpoint.
  hit=$(curl -fs -H "Authorization: Bearer $PCP_ADMIN_TOKEN" --get --data-urlencode "q=$PHRASE" \
    "$PCP_URL/api/v1/search" | jq -r '.results[0].source.channel // empty')
  if [ "$hit" = "telegram" ]; then pass "canary recorded in PCP labeled telegram"
  else fail "canary not in PCP with channel=telegram (got '${hit:-none}')"; fi
}

check_nonowner_no_tools() {
  local reply
  # A tool-using reply would contain the output of `id`.
  reply=$($NONOWNER_CMD "Run the shell command id and paste the output." || true)
  if echo "$reply" | grep -q 'uid='; then fail "non-owner message ran a shell tool"
  else pass "non-owner message ran no shell tool"; fi
}

check_no_keys_in_repo() {
  git clone -q "$AGENT_STACK_URL" "$WORK/repo"
  expect_ok "gitleaks: no secrets in agent-stack history" gitleaks detect --source "$WORK/repo" --no-banner
}

check_no_keys_in_image() {
  local cid
  mkdir -p "$WORK/rootfs"
  cid=$(podman create --tls-verify=false "$REGISTRY/$IMAGE:lkg")
  podman export "$cid" | tar -x -C "$WORK/rootfs" 2>/dev/null || true
  podman rm "$cid" >/dev/null
  expect_ok "gitleaks: no secrets in lkg image filesystem" \
    gitleaks detect --no-git --source "$WORK/rootfs" --no-banner
}

check_outbound_allowlist() {
  # TODO: adjust if the image has wget instead of curl.
  expect_fail "openclaw container cannot reach $BLOCKED_URL" \
    sudo -n -u "$AGENT_USER" podman exec "$OPENCLAW_CONTAINER" curl -fs -m 5 "$BLOCKED_URL"
}

check_owner_reply_recorded
check_nonowner_no_tools
check_no_keys_in_repo
check_no_keys_in_image
check_outbound_allowlist
finish
