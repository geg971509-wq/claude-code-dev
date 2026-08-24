#!/usr/bin/env bash
# Compile standalone binaries for mac arm64, windows x64, and linux x64.
# Outputs: dist/ccb  dist/ccb.exe  dist/ccb-linux
# compile.ts stages vendored ripgrep next to each binary so Grep works ootb
# (no brew/system rg required). Bun compile does not embed multi-call rg.
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

# Host-platform ripgrep into src/utils/vendor (postinstall is idempotent).
echo "=== Ensuring host ripgrep vendor ==="
node scripts/postinstall.cjs

echo "=== Building mac arm64 ==="
bun run scripts/compile.ts darwin-arm64

echo
echo "=== Building windows x64 ==="
bun run scripts/compile.ts windows-x64

echo
echo "=== Building linux x64 ==="
# compile.ts writes linux to dist/ccb-linux so it does not overwrite mac dist/ccb
bun run scripts/compile.ts linux-x64

echo
MAC="$ROOT/dist/ccb"
WIN="$ROOT/dist/ccb.exe"
LINUX="$ROOT/dist/ccb-linux"

if [[ ! -x "$MAC" ]]; then
  echo "error: expected executable missing: $MAC" >&2
  exit 1
fi
if [[ ! -f "$WIN" ]]; then
  echo "error: expected executable missing: $WIN" >&2
  exit 1
fi
if [[ ! -x "$LINUX" ]]; then
  echo "error: expected executable missing: $LINUX" >&2
  exit 1
fi

echo "Binaries:"
file "$MAC" || true
ls -lh "$MAC"
echo
file "$WIN" || true
ls -lh "$WIN"
echo
file "$LINUX" || true
ls -lh "$LINUX"
echo
ls -lh dist/vendor/ripgrep/*/* 2>/dev/null || true

echo
"$MAC" --version
