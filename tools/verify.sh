#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
if command -v cargo >/dev/null 2>&1; then
    cargo=cargo
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
    cargo="$HOME/.cargo/bin/cargo"
else
    echo "Falta Rust/Cargo; instala una herramienta Rust compatible." >&2
    exit 1
fi
"$cargo" fmt --all -- --check
dbus-run-session -- "$cargo" test --workspace --no-default-features --locked
python3 -m unittest discover -s tests -v
"$cargo" check -p cosmic-global-menu --features ui --locked
dbus-run-session -- "$cargo" test -p cosmic-global-menu --features ui --bin cosmic-global-menu --locked
