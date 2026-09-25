#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config="$repo_root/managed/cloudflare-do/wrangler.toml"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler is required; install the Cloudflare Wrangler CLI first" >&2
  exit 127
fi

case "${1:-}" in
  --dry-run)
    shift
    exec wrangler deploy --dry-run --config "$config" "$@"
    ;;
  *)
    exec wrangler deploy --config "$config" "$@"
    ;;
esac
