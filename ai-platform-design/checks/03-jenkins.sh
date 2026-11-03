#!/usr/bin/env bash
# Task 3: Jenkins controller and webhook.
# Verifies: a push to scratch triggers a build; the agent token gets 403 on /script, /configure and
# platform jobs; an unsigned webhook is rejected; the controller has 0 executors.
# Run on your own platform host, not on a work machine.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

: "${JENKINS_URL:=http://127.0.0.1:8080}"
: "${AGENT_JENKINS_USER:=agent}"
: "${AGENT_JENKINS_TOKEN:?set AGENT_JENKINS_TOKEN}"
: "${AGENT_STACK_URL:?set AGENT_STACK_URL (agent credentials)}"
# Multibranch job path for the agent folder; adjust to your job layout.
: "${AGENT_JOB_PATH:=job/agent/job/agent-stack}"
: "${PLATFORM_JOB_PATH:=job/platform/job/deploy}"
# TODO: adjust to the webhook endpoint of the Jenkins plugin you use for Forgejo.
: "${WEBHOOK_PATH:=gitea-webhook/post}"
: "${BUILD_TIMEOUT_S:=300}"

need curl jq git

AUTH=(-u "$AGENT_JENKINS_USER:$AGENT_JENKINS_TOKEN")

last_build_number() {
  curl -s "${AUTH[@]}" "$JENKINS_URL/$AGENT_JOB_PATH/job/scratch/lastBuild/api/json" | jq -r '.number // 0'
}

check_push_triggers_build() {
  local before after waited=0 work
  before=$(last_build_number)
  work=$(mktemp -d)
  git clone -q --branch scratch "$AGENT_STACK_URL" "$work/repo"
  git -C "$work/repo" -c user.name=checks -c user.email=checks@localhost -c commit.gpgsign=false \
    commit -q --allow-empty -m "checks: trigger $(date +%s)"
  git -C "$work/repo" push -q origin HEAD:refs/heads/scratch
  rm -rf "$work"
  while [ "$waited" -lt "$BUILD_TIMEOUT_S" ]; do
    after=$(last_build_number)
    [ "$after" -gt "$before" ] && { pass "push to scratch triggered build #$after"; return; }
    sleep 10; waited=$((waited + 10))
  done
  fail "no new scratch build within ${BUILD_TIMEOUT_S}s"
}

check_agent_denied() {
  local path code
  for path in script configure "$PLATFORM_JOB_PATH/build"; do
    code=$(http_code "${AUTH[@]}" -X POST "$JENKINS_URL/$path")
    # Jenkins returns 404 for jobs the user can't see; both count as denied.
    if [ "$code" = "403" ] || [ "$code" = "404" ]; then pass "agent denied on /$path ($code)"
    else fail "agent got $code on /$path, want 403"; fi
  done
}

check_unsigned_webhook_rejected() {
  local code
  code=$(http_code -X POST -H 'Content-Type: application/json' -H 'X-Gitea-Event: push' \
    -d '{"ref":"refs/heads/main"}' "$JENKINS_URL/$WEBHOOK_PATH")
  if [ "${code:0:1}" = "2" ]; then fail "unsigned webhook accepted ($code)"
  else pass "unsigned webhook rejected ($code)"; fi
}

check_controller_executors() {
  local n
  n=$(curl -s "${AUTH[@]}" "$JENKINS_URL/computer/api/json" \
    | jq -r '.computer[] | select(.assignedLabels[]?.name == "built-in") | .numExecutors' | head -n 1)
  if [ "$n" = "0" ]; then pass "controller has 0 executors"; else fail "controller executors: ${n:-unknown}"; fi
}

check_push_triggers_build
check_agent_denied
check_unsigned_webhook_rejected
check_controller_executors
finish
