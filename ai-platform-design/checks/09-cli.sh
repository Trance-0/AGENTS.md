#!/usr/bin/env bash
# Task 9: Claude Code over SSH and in the OpenClaw container.
# Verifies: the credential mount is read-only; the owner's personal ~/.claude is not visible in the
# container; claude -p works in the container; a scripted session lands in PCP with the secret
# redacted; the PCP MCP server's memory.search tool returns it.
# Run on your own platform host, with the PCP hooks installed. Not on a work machine.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

: "${PCP_URL:=http://127.0.0.1:8700}"
: "${PCP_ADMIN_TOKEN:?set PCP_ADMIN_TOKEN (read-only search token)}"
: "${PCP_MCP_URL:=http://127.0.0.1:8701/mcp}"
: "${OPENCLAW_CONTAINER:=openclaw}"
: "${AGENT_USER:=agent}"
: "${CRED_MOUNT:=/claude-cred}"
: "${CONFIG_DIR:=/claude}"
: "${SETTLE_S:=10}"

need curl jq npx podman sudo

PROBE="cli-probe-$(date +%s)-$$"
KEY=$(fake_key)

in_container() { sudo -n -u "$AGENT_USER" podman exec "$OPENCLAW_CONTAINER" "$@"; }

check_credential_mount_readonly() {
  expect_fail "credential mount $CRED_MOUNT is read-only" in_container touch "$CRED_MOUNT/.write-probe"
  expect_ok "$CONFIG_DIR/.credentials.json resolves into $CRED_MOUNT" \
    in_container sh -c "readlink -f '$CONFIG_DIR/.credentials.json' | grep -q '^$CRED_MOUNT/'"
}

check_personal_config_not_mounted() {
  # The read-only mount must be the dedicated credential dir, never a full ~/.claude with transcripts.
  expect_fail "no host session transcripts under $CRED_MOUNT" in_container test -d "$CRED_MOUNT/projects"
}

check_claude_runs_in_container() {
  expect_ok "claude -p works inside $OPENCLAW_CONTAINER" \
    in_container env CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude -p "Reply with the word ok."
}

check_session_recorded() {
  local body
  # Headless run; the managed SessionStart and Stop hooks should fire as in an interactive session.
  in_container env CLAUDE_CONFIG_DIR="$CONFIG_DIR" \
    claude -p "Reply with exactly this line and nothing else: $PROBE $KEY" >/dev/null || true
  sleep "$SETTLE_S"
  # TODO: adjust to PCP's search endpoint.
  body=$(curl -fs -m 10 -H "Authorization: Bearer $PCP_ADMIN_TOKEN" --get --data-urlencode "q=$PROBE" \
    "$PCP_URL/api/v1/search" || true)
  if echo "$body" | grep -q "$PROBE"; then pass "Claude Code turn recorded in PCP"
  else fail "probe $PROBE not found in PCP"; fi
  if echo "$body" | grep -q "$KEY"; then fail "fake key stored verbatim"
  else pass "fake key redacted"; fi
}

check_mcp_search() {
  local out
  # MCP Inspector CLI mode. TODO: adjust tool name/args to the PCP MCP server.
  out=$(timeout 60 npx -y @modelcontextprotocol/inspector --cli "$PCP_MCP_URL" --transport http \
    --method tools/call --tool-name memory.search --tool-arg "query=$PROBE" 2>/dev/null || true)
  if echo "$out" | grep -q "$PROBE"; then pass "MCP memory.search returns the probe"
  else fail "MCP memory.search did not return the probe"; fi
}

check_credential_mount_readonly
check_personal_config_not_mounted
check_claude_runs_in_container
check_session_recorded
check_mcp_search
finish
