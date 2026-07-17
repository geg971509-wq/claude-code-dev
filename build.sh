#!/usr/bin/env bash
# Compile the final standalone binary for the current host.
# Output: dist/ccb
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required (https://bun.sh)" >&2
  exit 1
fi

# Ensure workspace deps exist (no-op when already installed).
if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  bun install
fi

echo "Building standalone binary..."
bun run scripts/compile-mac.ts

OUT="$ROOT/dist/ccb"
if [[ ! -x "$OUT" ]]; then
  echo "error: expected executable missing: $OUT" >&2
  exit 1
fi

echo
echo "Binary: $OUT"
file "$OUT" || true
ls -lh "$OUT"
"$OUT" --version
