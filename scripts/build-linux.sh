#!/bin/sh
# Static Linux x86_64 (musl) build that runs on any Ubuntu/Debian.
# Run on Linux or WSL. Requires rustup, gcc, musl-tools (sudo apt install musl-tools), node and npm.
#   ./scripts/build-linux.sh        -> dist/nodepilot-linux-x86_64
set -eu
cd "$(dirname "$0")/.."

TARGET=x86_64-unknown-linux-musl
command -v musl-gcc >/dev/null || { echo "musl-gcc not found: sudo apt install musl-tools" >&2; exit 1; }
rustup target add "$TARGET" >/dev/null

if [ -f web/package.json ]; then
    (cd web && (npm ci || npm install) && npm run build)
fi

# A target dir outside OneDrive/Windows drives is much faster under WSL.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/nodepilot-target}"
cargo build --release --locked --target "$TARGET" -p nodepilot

mkdir -p dist
cp "$CARGO_TARGET_DIR/$TARGET/release/nodepilot" dist/nodepilot-linux-x86_64
ls -lh dist/nodepilot-linux-x86_64
file dist/nodepilot-linux-x86_64 2>/dev/null || true
