#!/usr/bin/env bash
# Compile standalone binaries for mac arm64, windows x64, and linux x64.
# Outputs: dist/ccb  dist/ccb.exe  dist/ccb-linux
# Also stages vendored ripgrep next to the binaries so Grep works ootb
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

# Sidecar vendor layout used by src/utils/ripgrep.ts for dist/ccb*:
#   dist/vendor/ripgrep/{arch}-{platform}/rg[.exe]
stage_rg() {
  local src_subdir="$1" # e.g. arm64-darwin
  local src_bin="$2"    # e.g. rg
  local dest_subdir="$3"
  local dest_bin="$4"
  local src="$ROOT/src/utils/vendor/ripgrep/$src_subdir/$src_bin"
  local dest_dir="$ROOT/dist/vendor/ripgrep/$dest_subdir"
  mkdir -p "$dest_dir"
  if [[ -f "$src" ]]; then
    cp "$src" "$dest_dir/$dest_bin"
    if [[ "$dest_bin" != *.exe ]]; then
      chmod +x "$dest_dir/$dest_bin"
    fi
    echo "Staged $dest_subdir/$dest_bin"
  else
    echo "warn: missing $src (Grep may need system rg on that platform)" >&2
  fi
}

echo
echo "=== Staging vendored ripgrep for ootb Grep ==="
# Host mac arm64 (this machine)
stage_rg "arm64-darwin" "rg" "arm64-darwin" "rg"

# Linux x64 — download if missing
LINUX_RG_DIR="$ROOT/src/utils/vendor/ripgrep/x64-linux"
LINUX_RG="$LINUX_RG_DIR/rg"
if [[ ! -f "$LINUX_RG" ]]; then
  echo "Downloading linux x64 ripgrep for packaging..."
  RG_VERSION="14.1.1"
  URL="https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz"
  MIRROR="https://ghproxy.net/${URL}"
  TMP="$(mktemp -d)"
  if ! curl -fsSL "$URL" -o "$TMP/rg.tar.gz" 2>/dev/null; then
    curl -fsSL "$MIRROR" -o "$TMP/rg.tar.gz"
  fi
  mkdir -p "$LINUX_RG_DIR"
  tar -xzf "$TMP/rg.tar.gz" -C "$TMP"
  find "$TMP" -name 'rg' -type f -exec cp {} "$LINUX_RG" \;
  chmod +x "$LINUX_RG"
  rm -rf "$TMP"
  if [[ ! -f "$LINUX_RG" ]]; then
    echo "warn: failed to download linux rg" >&2
  else
    echo "Installed $LINUX_RG"
  fi
fi
stage_rg "x64-linux" "rg" "x64-linux" "rg"

# Windows x64 for dist/ccb.exe consumers — download if missing.
WIN_RG_DIR="$ROOT/src/utils/vendor/ripgrep/x64-win32"
WIN_RG="$WIN_RG_DIR/rg.exe"
if [[ ! -f "$WIN_RG" ]]; then
  echo "Downloading windows x64 ripgrep for packaging..."
  RG_VERSION="15.0.1"
  URL="https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${RG_VERSION}/ripgrep-v${RG_VERSION}-x86_64-pc-windows-msvc.zip"
  MIRROR="https://ghproxy.net/${URL}"
  TMP="$(mktemp -d)"
  if ! curl -fsSL "$URL" -o "$TMP/rg.zip" 2>/dev/null; then
    curl -fsSL "$MIRROR" -o "$TMP/rg.zip"
  fi
  mkdir -p "$WIN_RG_DIR"
  # zip usually contains rg.exe at top level
  unzip -qo "$TMP/rg.zip" -d "$TMP/out"
  find "$TMP/out" -name 'rg.exe' -exec cp {} "$WIN_RG" \;
  rm -rf "$TMP"
  if [[ ! -f "$WIN_RG" ]]; then
    echo "warn: failed to download windows rg.exe" >&2
  else
    echo "Installed $WIN_RG"
  fi
fi
stage_rg "x64-win32" "rg.exe" "x64-win32" "rg.exe"

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
