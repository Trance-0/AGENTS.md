#!/usr/bin/env bash
# Task 5: watchdog and automatic rollback.
# Verifies: a broken image rolls back to lkg within N minutes; the same works with Jenkins stopped;
# the watchdog logged an alert; the kill switch exists.
# DISRUPTIVE: deploys a broken image and stops Jenkins. Requires CONFIRM_DISRUPTIVE=yes.
# Run on your own platform host, not on a work machine.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
require_disruptive

: "${HEALTH_URL:=http://127.0.0.1:9000/healthz}"
: "${N_MINUTES:=5}"
: "${REGISTRY:=127.0.0.1:5000}"
: "${IMAGE:=agent-stack}"
: "${BROKEN_DIGEST:?set BROKEN_DIGEST to an image digest whose health endpoint fails}"
: "${CONTAINER:=agent-stack}"
: "${PLATFORM_USER:=platform}"
: "${WATCHDOG_UNIT:=ai-watchdog.service}"
: "${JENKINS_UNIT:=jenkins.service}"
: "${KILLSWITCH:=/usr/local/bin/ai-killswitch}"
: "${SKOPEO_TLS:=--tls-verify=false}"

need curl skopeo sudo systemctl journalctl

START=$(date '+%Y-%m-%d %H:%M:%S')
LKG=$(skopeo inspect $SKOPEO_TLS --format '{{.Digest}}' "docker://$REGISTRY/$IMAGE:lkg")
trap 'sudo systemctl start "$JENKINS_UNIT" || true' EXIT

running_digest() {
  sudo -n -u "$PLATFORM_USER" podman inspect --format '{{.ImageDigest}}' "$CONTAINER" 2>/dev/null || true
}

deploy_broken() {
  # Same path the watchdog uses, so this works without Jenkins.
  # TODO: adjust to how your deploy job runs the container (ports, env file, volumes).
  sudo -n -u "$PLATFORM_USER" podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
  sudo -n -u "$PLATFORM_USER" podman run -d --name "$CONTAINER" "$REGISTRY/$IMAGE@$BROKEN_DIGEST" >/dev/null
}

wait_for_rollback() {
  local label=$1 deadline=$(( $(date +%s) + N_MINUTES * 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$(running_digest)" = "$LKG" ] && curl -fs -m 5 "$HEALTH_URL" >/dev/null; then
      pass "$label: rolled back to lkg and healthy"; return
    fi
    sleep 15
  done
  fail "$label: not back on lkg within $N_MINUTES min (running: $(running_digest))"
}

check_rollback_with_jenkins() {
  deploy_broken
  wait_for_rollback "jenkins up"
}

check_rollback_without_jenkins() {
  sudo systemctl stop "$JENKINS_UNIT"
  deploy_broken
  wait_for_rollback "jenkins stopped"
  sudo systemctl start "$JENKINS_UNIT"
}

check_alert_logged() {
  # TODO: adjust the pattern to what your watchdog logs after a successful notifier send.
  if sudo journalctl -u "$WATCHDOG_UNIT" --since "$START" --no-pager | grep -q 'alert sent'; then
    pass "watchdog logged an alert (confirm it arrived on Telegram)"
  else fail "no 'alert sent' in $WATCHDOG_UNIT log since $START"; fi
}

check_killswitch_present() {
  expect_ok "kill switch is executable at $KILLSWITCH" test -x "$KILLSWITCH"
}

check_rollback_with_jenkins
check_rollback_without_jenkins
check_alert_logged
check_killswitch_present
finish
