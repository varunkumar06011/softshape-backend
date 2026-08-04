#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check-unguarded-fetch.sh — CI guardrail for unguarded fetch() calls
# ─────────────────────────────────────────────────────────────────────────────
# Scans all .ts files in src/ for raw fetch() calls that don't include
# a signal or AbortSignal.timeout in the same call expression.
#
# Exits 1 if any violations are found, 0 otherwise.
#
# Usage: bash scripts/check-unguarded-fetch.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

VIOLATIONS=0

# Find all .ts files (excluding node_modules) and check for raw fetch() without signal
while IFS= read -r file; do
  # Match lines with fetch( that don't contain 'signal' or 'AbortSignal' or 'cloudFetch'
  matches=$(grep -n 'fetch(' "$file" | grep -v 'signal' | grep -v 'AbortSignal' | grep -v 'cloudFetch' | grep -v 'httpFetch' | grep -v 'fetchWithRetry' || true)
  if [ -n "$matches" ]; then
    echo "❌ Unguarded fetch() calls in $file:"
    echo "$matches"
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done < <(find src/ -name '*.ts' -not -path '*/node_modules/*')

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "❌ Found unguarded fetch() calls in $VIOLATIONS file(s)."
  echo "   Wrap fetch() with AbortSignal.timeout() or use a shared helper."
  echo "   To suppress: add 'signal: AbortSignal.timeout(...)' to the fetch options."
  exit 1
fi

echo "✅ All fetch() calls are guarded with timeout/signal."
exit 0
