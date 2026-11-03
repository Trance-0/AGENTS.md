#!/usr/bin/env bash
# Task 11: dashboard host and manager panels.
# Verifies: loopback-only listener; mutating calls need a token; a config change becomes a commit on
# an agent-stack branch instead of a live edit; a disabled panel stops answering without a restart;
# the snapshot leaks no resolver code or secret values; invalid JSON is rejected; no owner token in
# the dashboard environment.
# Run on your own platform host, not on a work machine.
#
# TODO: adjust every endpoint below. They follow the plugin-manager API shape (/api/plugins/...)
# and are placeholders until the dashboard exists.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

: "${DASH_URL:=http://127.0.0.1:14100}"
: "${DASH_PORT:=14100}"
: "${DASH_TOKEN:?set DASH_TOKEN (dashboard mutation token)}"
: "${DASH_CONTAINER:=dashboard}"
: "${OPENCLAW_CONTAINER:=openclaw}"
: "${AGENT_USER:=agent}"
: "${AGENT_STACK_URL:?set AGENT_STACK_URL (read access)}"
: "${PROBE_PANEL:=build-status}"
: "${LIVE_CONFIG:=/home/node/.openclaw/openclaw.json}"
# Space-separated env var names whose values must never appear in a snapshot.
: "${SECRET_ENV_NAMES:=OPENCLAW_GATEWAY_TOKEN TELEGRAM_BOT_TOKEN}"
# Env var names that mean an owner credential reached the dashboard.
: "${OWNER_ENV_NAMES:=PCP_OWNER_TOKEN OPENCLAW_GATEWAY_TOKEN JENKINS_ADMIN_TOKEN}"

need curl jq git ss sudo podman sha256sum

AUTH=(-H "Authorization: Bearer $DASH_TOKEN" -H 'Content-Type: application/json')
in_ctr() { sudo -n -u "$AGENT_USER" podman exec "$1" "${@:2}"; }

check_loopback_only() {
  local bad
  bad=$(ss -ltnH "sport = :$DASH_PORT" | awk '{print $4}' | grep -Ev '^(127\.[0-9.]+|\[::1\]):' || true)
  if [ -z "$bad" ]; then pass "dashboard port $DASH_PORT bound to loopback only"
  else fail "dashboard listening on: $bad"; fi
}

check_mutation_needs_token() {
  local code
  code=$(http_code -m 10 -X POST -H 'Content-Type: application/json' -d '{"enabled":false}' \
    "$DASH_URL/api/plugins/$PROBE_PANEL/toggle")
  if [ "$code" = "401" ] || [ "$code" = "403" ]; then pass "mutation without token rejected ($code)"
  else fail "mutation without token returned $code"; fi
}

check_config_change_is_commit() {
  local before after live_before live_after
  before=$(git ls-remote "$AGENT_STACK_URL" 'refs/heads/dashboard/*' | sha256sum)
  live_before=$(in_ctr "$OPENCLAW_CONTAINER" sha256sum "$LIVE_CONFIG" | awk '{print $1}')
  curl -fs -m 20 "${AUTH[@]}" -X POST \
    -d "{\"path\":\"agents.defaults.description\",\"value\":\"checks $(date +%s)\"}" \
    "$DASH_URL/api/plugins/openclaw-config/set" >/dev/null || true
  sleep 5
  after=$(git ls-remote "$AGENT_STACK_URL" 'refs/heads/dashboard/*' | sha256sum)
  live_after=$(in_ctr "$OPENCLAW_CONTAINER" sha256sum "$LIVE_CONFIG" | awk '{print $1}')
  if [ "$before" != "$after" ]; then pass "config change produced a commit on a dashboard/* branch"
  else fail "no new commit on agent-stack dashboard/* branches"; fi
  if [ "$live_before" = "$live_after" ]; then pass "live OpenClaw config untouched"
  else fail "dashboard edited the live OpenClaw config"; fi
}

check_panel_hot_toggle() {
  local code
  curl -fs -m 10 "${AUTH[@]}" -X POST -d '{"enabled":false}' "$DASH_URL/api/plugins/$PROBE_PANEL/toggle" >/dev/null
  code=$(http_code -m 10 "${AUTH[@]}" "$DASH_URL/api/plugins/$PROBE_PANEL/panel")
  curl -fs -m 10 "${AUTH[@]}" -X POST -d '{"enabled":true}' "$DASH_URL/api/plugins/$PROBE_PANEL/toggle" >/dev/null
  if [ "${code:0:1}" != "2" ]; then pass "disabled panel stopped answering ($code) without restart"
  else fail "disabled panel still answered $code"; fi
}

check_snapshot_clean() {
  local snap name value leaked=""
  snap=$(curl -fs -m 10 "${AUTH[@]}" "$DASH_URL/api/plugins")
  if echo "$snap" | jq -e '[.. | objects | has("run") or has("children")] | any' >/dev/null; then
    fail "snapshot contains run/children resolvers"
  else pass "snapshot strips server-side resolvers"; fi
  for name in $SECRET_ENV_NAMES; do
    value=$(in_ctr "$OPENCLAW_CONTAINER" printenv "$name" 2>/dev/null || true)
    [ -n "$value" ] && echo "$snap" | grep -qF "$value" && leaked="$leaked $name"
  done
  if [ -z "$leaked" ]; then pass "snapshot contains no secret values"; else fail "snapshot leaks:$leaked"; fi
}

check_invalid_json_rejected() {
  local code
  code=$(http_code -m 10 "${AUTH[@]}" -X PUT --data-binary '{"broken": ' "$DASH_URL/api/config/openclaw.json")
  if [ "${code:0:1}" = "4" ]; then pass "invalid JSON save rejected ($code)"
  else fail "invalid JSON save returned $code"; fi
}

check_no_owner_credentials() {
  local name found=""
  for name in $OWNER_ENV_NAMES; do
    in_ctr "$DASH_CONTAINER" printenv "$name" >/dev/null 2>&1 && found="$found $name"
  done
  if [ -z "$found" ]; then pass "no owner credential in dashboard environment"
  else fail "dashboard environment holds:$found"; fi
}

check_loopback_only
check_mutation_needs_token
check_config_change_is_commit
check_panel_hot_toggle
check_snapshot_clean
check_invalid_json_rejected
check_no_owner_credentials
finish
