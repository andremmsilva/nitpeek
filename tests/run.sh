#!/usr/bin/env bash
# Run every nitpeek test suite with an isolated NITPEEK_HOME.
set -uo pipefail
cd "$(dirname "$0")"
export NITPEEK_HOME="$(mktemp -d)"
trap 'rm -rf "$NITPEEK_HOME"' EXIT
(cd .. && bun run build >/dev/null 2>&1) || { echo "UI build failed"; exit 1; }
failures=0
for test in *.test.ts; do
  if output=$(bun run "$test" 2>&1); then echo "✓ ${test%.test.ts}"; else echo "✗ ${test%.test.ts}"; echo "$output" | tail -30; failures=$((failures + 1)); fi
done
[ "$failures" -eq 0 ] && echo "all suites passed" || { echo "$failures suite(s) failed"; exit 1; }
