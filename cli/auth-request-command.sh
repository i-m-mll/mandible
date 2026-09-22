#!/usr/bin/env bash
# Explicit commands use the shared approval queue without Git preparation.

prepare_command_request() {
  if [[ ! -d "$cwd_override" ]]; then
    echo "Error: execution directory '$cwd_override' does not exist" >&2
    exit 2
  fi
  target_cwd=$(cd -- "$cwd_override" && pwd -P)
}
