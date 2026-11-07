#!/usr/bin/env bash
# Task 4: image build, platform deploy and LKG tagging.
# Verifies: after the soak period, lkg points to the latest green main build; at least 5 lkg-* tags
# are kept; the agent's registry credentials can't move or delete lkg.
# Run on your own platform host, not on a work machine. Run it after the soak period has passed.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

: "${JENKINS_URL:=http://127.0.0.1:8080}"
: "${AGENT_JENKINS_USER:=agent}"
: "${AGENT_JENKINS_TOKEN:?set AGENT_JENKINS_TOKEN}"
: "${AGENT_JOB_PATH:=job/agent/job/agent-stack}"
: "${REGISTRY:=127.0.0.1:5000}"
: "${IMAGE:=agent-stack}"
: "${AGENT_REGISTRY_CREDS:?set AGENT_REGISTRY_CREDS as user:password}"
: "${MIN_LKG_TAGS:=5}"
# Registry is on loopback without TLS; drop this flag if you add TLS.
: "${SKOPEO_TLS:=--tls-verify=false}"

need curl skopeo jq

check_lkg_is_latest_green() {
  local built lkg
  # The agent build publishes image-digest.txt as an artifact (see build-plan Task 4).
  built=$(curl -fs -u "$AGENT_JENKINS_USER:$AGENT_JENKINS_TOKEN" \
    "$JENKINS_URL/$AGENT_JOB_PATH/job/main/lastSuccessfulBuild/artifact/image-digest.txt" | tr -d '[:space:]')
  lkg=$(skopeo inspect $SKOPEO_TLS --format '{{.Digest}}' "docker://$REGISTRY/$IMAGE:lkg")
  if [ -n "$built" ] && [ "$built" = "$lkg" ]; then pass "lkg = latest green main ($lkg)"
  else fail "lkg ($lkg) != latest green main build ($built); still soaking, or promotion failed"; fi
}

check_lkg_retention() {
  local n
  n=$(skopeo list-tags $SKOPEO_TLS "docker://$REGISTRY/$IMAGE" | jq '[.Tags[] | select(startswith("lkg-"))] | length')
  if [ "$n" -ge "$MIN_LKG_TAGS" ]; then pass "$n lkg-* tags retained"
  else fail "only $n lkg-* tags (want >= $MIN_LKG_TAGS; expected until 5 deploys have happened)"; fi
}

check_agent_cannot_move_lkg() {
  # Try to point lkg at the oldest lkg-* image using the agent's registry credentials.
  local oldest
  oldest=$(skopeo list-tags $SKOPEO_TLS "docker://$REGISTRY/$IMAGE" | jq -r '[.Tags[] | select(startswith("lkg-"))] | sort | first // empty')
  if [ -z "$oldest" ]; then fail "no lkg-* tag to test with"; return; fi
  expect_fail "agent cannot move lkg" skopeo copy $SKOPEO_TLS --dest-creds "$AGENT_REGISTRY_CREDS" \
    "docker://$REGISTRY/$IMAGE:$oldest" "docker://$REGISTRY/$IMAGE:lkg"
  expect_fail "agent cannot delete lkg" skopeo delete $SKOPEO_TLS --creds "$AGENT_REGISTRY_CREDS" \
    "docker://$REGISTRY/$IMAGE:lkg"
}

check_lkg_is_latest_green
check_lkg_retention
check_agent_cannot_move_lkg
finish
