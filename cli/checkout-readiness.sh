#!/usr/bin/env bash
set -eu
script_dir=${BASH_SOURCE[0]%/*}
source "$script_dir/command-syntax.sh" --mandible-syntax-definitions-only
exec "$(mandible_bun_runtime)" --no-install "$script_dir/checkout-readiness-cli.mjs" "$@"
