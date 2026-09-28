#!/usr/bin/env bash
# Run all pi-annotate tests. Requires bun (for TypeScript execution).
set -euo pipefail
cd "$(dirname "$0")"

failures=0
for test in *.test.ts; do
  echo "──────────────────────────────────────────────"
  echo "▶ $test"
  echo "──────────────────────────────────────────────"
  if ! bun run "$test"; then
    failures=$((failures + 1))
  fi
done

echo
if [ "$failures" -eq 0 ]; then
  echo "✅ all suites passed"
else
  echo "❌ $failures suite(s) failed"
  exit 1
fi
