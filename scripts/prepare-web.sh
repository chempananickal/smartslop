#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="${TMPDIR:-$ROOT_DIR/.tmp}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target/wasm-pack-web}"
PKG_DIR="$ROOT_DIR/pkg-web"
VENDOR_DIR="$ROOT_DIR/vendor/rdkit"

mkdir -p "$TMP_DIR" "$TARGET_DIR" "$VENDOR_DIR"

source "$HOME/.cargo/env"

TMPDIR="$TMP_DIR" CARGO_TARGET_DIR="$TARGET_DIR" wasm-pack build \
  --target web \
  --dev \
  --out-dir "$PKG_DIR"

cp "$ROOT_DIR/node_modules/@rdkit/rdkit/dist/RDKit_minimal.js" "$VENDOR_DIR/"
cp "$ROOT_DIR/node_modules/@rdkit/rdkit/dist/RDKit_minimal.wasm" "$VENDOR_DIR/"