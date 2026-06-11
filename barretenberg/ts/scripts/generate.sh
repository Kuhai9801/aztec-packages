#!/usr/bin/env bash
# Generate TypeScript bindings consumed by bb.js, plus the Rust bindings
# consumed by barretenberg-rs.
#
# Each consumer owns its schema (committed next to the C++ server that
# defines the wire format). ipc-codegen is a pure code generator and has
# no knowledge of these schemas — we pass their paths explicitly.
#
set -euo pipefail

cd "$(dirname "$0")/.."
TS_SRC="$(pwd)/src"

CODEGEN="../../ipc-codegen/src/generate.ts"
NODE_FLAGS=(--experimental-strip-types --experimental-transform-types --no-warnings)
gen() { node "${NODE_FLAGS[@]}" "$CODEGEN" "$@"; }

# bb.js core BB API bindings: TypeScript (bb.js workspace) + Rust (barretenberg-rs).
# bb.js is a pure client (the bb binary is the server), so we only emit --client.
gen \
  --schema ../cpp/src/barretenberg/bbapi/bb_schema.json \
  --lang ts \
  --out "$TS_SRC/cbind/generated" \
  --client \
  --prefix Bb --strip-method-prefix \
  --curve-constants ../cpp/src/barretenberg/bbapi/bb_curve_constants.json

gen \
  --schema ../cpp/src/barretenberg/bbapi/bb_schema.json \
  --lang rust \
  --out ../rust/barretenberg-rs/src/generated \
  --client --uds --ffi \
  --prefix Bb --strip-method-prefix

gen \
  --schema ../cpp/src/barretenberg/avm/avm_schema.json \
  --lang ts \
  --out "$TS_SRC/aztec-avm/generated" \
  --client \
  --prefix Avm

gen \
  --schema ../cpp/src/barretenberg/cdb/cdb_schema.json \
  --lang ts \
  --out "$TS_SRC/aztec-cdb/generated" \
  --client \
  --prefix Cdb
