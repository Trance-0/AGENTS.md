#!/usr/bin/env bash
# Shared helpers for checks/*.sh. Source this file; don't run it directly.
# Run checks on your own platform host, not on a work machine.

FAILURES=0

# Every curl call gets a timeout. A later -m/--max-time in a call overrides this default.
curl() { command curl --max-time "${CURL_TIMEOUT:-30}" "$@"; }

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# expect_ok "description" cmd...    passes when the command succeeds
expect_ok() {
  local desc=$1; shift
  if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi
}

# expect_fail "description" cmd...  passes when the command fails (for "must be rejected" checks)
expect_fail() {
  local desc=$1; shift
  if "$@" >/dev/null 2>&1; then fail "$desc (was allowed)"; else pass "$desc"; fi
}

# http_code [curl args...]  prints only the HTTP status code
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# need cmd...  fails fast when a required tool is missing
need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || { echo "missing required tool: $c" >&2; exit 1; }
  done
}

# require_disruptive  stops scripts that restart services unless the owner opted in
require_disruptive() {
  if [ "${CONFIRM_DISRUPTIVE:-}" != "yes" ]; then
    echo "this check stops and restarts services; set CONFIRM_DISRUPTIVE=yes to run it" >&2
    exit 2
  fi
}

# fake_key  prints a random string shaped like a GitHub token so gitleaks/redaction rules match it
fake_key() { printf 'ghp_%s' "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 36)"; }

finish() {
  if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed" >&2
    exit 1
  fi
  echo "all checks passed"
}
