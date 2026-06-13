#!/usr/bin/env bash

mandible_auth_preflight_check_script() {
  local script_dir
  script_dir="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
  printf "%s" "${script_dir}/auth-check.sh"
}

mandible_auth_merge_preflight() {
  local cwd="$1"
  local head_branch="$2"
  local base_branch="$3"
  local repo="${4:-}"

  local check_script
  check_script=$(mandible_auth_preflight_check_script)
  if [[ ! -x "$check_script" ]]; then
    printf "Error: Mandible auth check helper not found: %s\n" "$check_script" >&2
    return 1
  fi

  local -a args
  args=(--cwd "$cwd" --target "$base_branch" --branch "$head_branch" --json)
  if [[ -n "$repo" ]]; then
    args+=(--repo "$repo")
  fi

  local output
  if ! output=$(bash "$check_script" "${args[@]}" 2>&1); then
    printf "%s\n" "$output" >&2
    printf "Error: Mandible merge preflight failed. Resolve dirty state or conflicts before continuing.\n" >&2
    return 1
  fi
}
