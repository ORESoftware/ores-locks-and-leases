#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config="${BMSCL_DURABLE_OBJECTS_CONFIG:-$repo_root/managed/beamscale-critical-section/.bmscl-durable-objects.toml}"

if ! command -v bmscl >/dev/null 2>&1; then
  echo "bmscl is required; install beamscale/bmscl-cli first" >&2
  exit 127
fi

if [ ! -f "$config" ]; then
  echo "missing $config" >&2
  echo "copy managed/beamscale-critical-section/.bmscl-durable-objects.toml.example first" >&2
  exit 2
fi

case "${1:-deploy}" in
  build)
    shift
    exec bmscl durable-objects build --config "$config" "$@"
    ;;
  deploy)
    if [ "${1:-}" = "deploy" ]; then shift; fi
    exec bmscl durable-objects deploy --config "$config" "$@"
    ;;
  *)
    exec bmscl durable-objects deploy --config "$config" "$@"
    ;;
esac
