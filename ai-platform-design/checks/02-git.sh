#!/usr/bin/env bash
# Task 2: Forgejo with history protection.
# Verifies, using the agent's credentials: force push, branch delete, tag delete, push to
# platform-infra and a commit containing a fake key are all rejected; a normal push to scratch
# works; the off-device mirror has the latest main commit.
# Run on your own platform host, not on a work machine.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

# URLs must carry the agent's credentials, e.g. https://agent:TOKEN@127.0.0.1:3000/owner/agent-stack.git
: "${AGENT_STACK_URL:?set AGENT_STACK_URL (agent credentials)}"
: "${PLATFORM_INFRA_URL:?set PLATFORM_INFRA_URL (agent credentials)}"
: "${MIRROR_URL:?set MIRROR_URL (read access to the off-device mirror)}"

need git

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git clone -q "$AGENT_STACK_URL" "$WORK/agent-stack"
cd "$WORK/agent-stack"
git config user.name "checks"
git config user.email "checks@localhost"
# Probe commits are made by the script, not the agent's signing key.
git config commit.gpgsign false

check_normal_push() {
  git fetch -q origin scratch 2>/dev/null && git checkout -q -B scratch origin/scratch || git checkout -q -B scratch
  git commit -q --allow-empty -m "checks: probe $(date +%s)"
  expect_ok "normal push to scratch" git push -q origin HEAD:refs/heads/scratch
}

check_force_push_rejected() {
  git checkout -q -B probe-force origin/main
  git commit -q --amend --allow-empty -m "checks: rewritten history"
  expect_fail "force push to main rejected" git push -q --force origin HEAD:refs/heads/main
}

check_branch_delete_rejected() {
  expect_fail "delete main rejected" git push -q origin --delete main
  expect_fail "delete scratch rejected" git push -q origin --delete scratch
}

check_tag_delete_rejected() {
  local tag
  tag=$(git ls-remote --tags origin 'refs/tags/lkg-*' | awk '{print $2}' | grep -v '\^{}' | tail -n 1 || true)
  if [ -z "$tag" ]; then fail "no lkg-* tag found to test (run after Task 4)"; return; fi
  expect_fail "delete $tag rejected" git push -q origin --delete "$tag"
}

check_platform_infra_push_rejected() {
  expect_fail "push to platform-infra rejected" \
    git push -q "$PLATFORM_INFRA_URL" HEAD:refs/heads/agent-probe
}

check_secret_push_rejected() {
  git checkout -q -B probe-secret scratch
  printf 'token = "%s"\n' "$(fake_key)" > leaked.txt
  git add leaked.txt
  git commit -q -m "checks: fake secret"
  expect_fail "commit with fake key rejected by pre-receive hook" \
    git push -q origin HEAD:refs/heads/scratch
  git checkout -q scratch
}

check_mirror_current() {
  # Run after the nightly mirror job, or trigger the mirror first.
  local origin_main mirror_main
  origin_main=$(git ls-remote origin refs/heads/main | awk '{print $1}')
  mirror_main=$(git ls-remote "$MIRROR_URL" refs/heads/main | awk '{print $1}')
  if [ -n "$origin_main" ] && [ "$origin_main" = "$mirror_main" ]; then pass "mirror has latest main"
  else fail "mirror main ($mirror_main) != origin main ($origin_main)"; fi
}

check_normal_push
check_force_push_rejected
check_branch_delete_rejected
check_tag_delete_rejected
check_platform_infra_push_rejected
check_secret_push_rejected
check_mirror_current
finish
