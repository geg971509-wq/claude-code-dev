#!/usr/bin/env bash
# Compile standalone binaries for mac arm64 and windows x64.
# Outputs: dist/ccb  dist/ccb.exe
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

echo "=== Building mac arm64 ==="
bun run scripts/compile.ts darwin-arm64

echo
echo "=== Building windows x64 ==="
bun run scripts/compile.ts windows-x64

echo
MAC="$ROOT/dist/ccb"
WIN="$ROOT/dist/ccb.exe"

if [[ ! -x "$MAC" ]]; then
  echo "error: expected executable missing: $MAC" >&2
  exit 1
fi
if [[ ! -f "$WIN" ]]; then
  echo "error: expected executable missing: $WIN" >&2
  exit 1
fi

echo "Binaries:"
file "$MAC" || true
ls -lh "$MAC"
echo
file "$WIN" || true
ls -lh "$WIN"

echo
"$MAC" --version
