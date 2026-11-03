#!/usr/bin/env bash
# Task 1: host baseline and zone separation.
# Verifies: agent can't read platform dirs, only loopback listeners, no container socket mounts,
# data dirs are mode 700.
# Run on your own platform host, not on a work machine.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

: "${PLATFORM_USER:=platform}"
: "${AGENT_USER:=agent}"
: "${PLATFORM_DATA_DIR:=/srv/platform}"
: "${AGENT_DATA_DIR:=/srv/agent}"

need ss sudo stat

check_agent_cannot_read_platform() {
  expect_fail "agent cannot list $PLATFORM_DATA_DIR" \
    sudo -n -u "$AGENT_USER" ls "$PLATFORM_DATA_DIR"
}

check_loopback_only() {
  # Local address column; allow 127.0.0.0/8 and ::1 only.
  local exposed
  exposed=$(ss -ltnH | awk '{print $4}' | grep -Ev '^(127\.[0-9.]+|\[::1\]):[0-9]+$' || true)
  if [ -z "$exposed" ]; then pass "only loopback TCP listeners"
  else fail "non-loopback listeners: $(echo "$exposed" | tr '\n' ' ')"; fi
}

check_no_socket_mounts() {
  local u ids mounts bad=""
  for u in "$AGENT_USER" "$PLATFORM_USER"; do
    ids=$(sudo -n -u "$u" podman ps -q 2>/dev/null || true)
    [ -z "$ids" ] && continue
    # shellcheck disable=SC2086
    mounts=$(sudo -n -u "$u" podman inspect --format '{{range .Mounts}}{{.Source}} {{end}}' $ids)
    if echo "$mounts" | grep -Eq '(docker|podman)\.sock'; then bad="$bad $u"; fi
  done
  if [ -z "$bad" ]; then pass "no container mounts docker.sock or podman.sock"
  else fail "socket mounted in containers of:$bad"; fi
}

check_dir_modes() {
  local d mode
  for d in "$PLATFORM_DATA_DIR" "$AGENT_DATA_DIR"; do
    mode=$(sudo -n stat -c '%a' "$d")
    if [ "$mode" = "700" ]; then pass "$d is mode 700"; else fail "$d is mode $mode, want 700"; fi
  done
}

check_agent_cannot_read_platform
check_loopback_only
check_no_socket_mounts
check_dir_modes
finish
