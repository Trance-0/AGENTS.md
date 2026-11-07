#!/usr/bin/env bash
# Runs checks 01..NN in order and stops at the first failure.
# Usage: run-all.sh [NN]   (default 11; e.g. run-all.sh 04 while building Task 4)
# 05 and 10 are disruptive and need CONFIRM_DISRUPTIVE=yes.
# Run on your own platform host, not on a work machine.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
UPTO=$((10#${1:-11}))

for script in "$DIR"/[0-9][0-9]-*.sh; do
  n=$((10#$(basename "$script" | cut -c1-2)))
  [ "$n" -gt "$UPTO" ] && break
  echo "=== $(basename "$script")"
  if ! bash "$script"; then
    echo "stopped: $(basename "$script") failed" >&2
    exit 1
  fi
done
echo "=== checks 01..$(printf '%02d' "$UPTO") passed"
