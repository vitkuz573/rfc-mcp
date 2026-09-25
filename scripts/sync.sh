#!/usr/bin/env bash
# Corpus maintenance for rfc-mcp. Operator action only: the MCP surface is read-only.
#
#   ./scripts/sync.sh                 # catalog + a curated seed set
#   ./scripts/sync.sh --all           # every RFC in the catalog (hours, large)
#   ./scripts/sync.sh --rfc 2119 9110 # specific documents
#
# Environment:
#   RFC_MCP_DATA_DIR   corpus location (default ~/.local/share/rfc-mcp)
#   RFC_MCP_LOG_LEVEL  default warn for bulk runs

set -euo pipefail

cd "$(dirname "$0")/.."

export RFC_MCP_DATA_DIR="${RFC_MCP_DATA_DIR:-$HOME/.local/share/rfc-mcp}"
export RFC_MCP_LOG_LEVEL="${RFC_MCP_LOG_LEVEL:-warn}"

if [ ! -f dist/cli.js ]; then
  echo "building…" >&2
  npm run --silent build
fi

CLI=(node dist/cli.js)

# Curated seed: the documents a protocol engineer reaches for first.
SEED=(
  2119 8174            # requirement level language
  3986 3987 3988 3989  # URI, IRIs, HTTP URI scheme, relative URIs
  7230 9110 9111 9112  # HTTP/1.1 and the HTTP core quartet
  9113 9114            # HTTP caching, message syntax
  5322 8446 8200 8252  # security, TLS 1.3, PSK, OAuth 2.0
  9000                 # QUIC
  3335 8445            # DNS terminology, SNI
)

echo "== catalog" >&2
"${CLI[@]}" sync index

if [ "${1:-}" = "--all" ]; then
  echo "== full corpus ingest" >&2
  exec "${CLI[@]}" sync all
fi

if [ "${1:-}" = "--rfc" ]; then
  shift
  echo "== ingest $* " >&2
  exec "${CLI[@]}" sync rfc "$@"
fi

echo "== ingest seed set (${#SEED[@]} documents)" >&2
"${CLI[@]}" sync rfc "${SEED[@]}"

echo "== status" >&2
"${CLI[@]}" status
