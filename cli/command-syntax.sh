#!/usr/bin/env bash
# Sourceable in bash and zsh; keep syntax lookup offline and side-effect free.
MANDIBLE_COMMAND_SYNTAX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)"
# Repository and flattened cache bundles carry the same verified selector.
mandible_bun_runtime() {
  local selector="$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh"
  if [[ -f "$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/scripts/bun-runtime.sh" ]]; then
    selector="$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/scripts/bun-runtime.sh"
  fi
  "$selector"
}
# The selector reports its own refusal; stop there rather than exec an empty path.
mandible_syntax_tool() {
  local runtime
  runtime="$(mandible_bun_runtime)" || return
  "$runtime" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" "$@"
}
mandible_command_syntax() {
  mandible_syntax_tool syntax "$1"
}
mandible_render_commands() {
  mandible_syntax_tool render-cli
}

mandible_bind_arguments() {
  local key="$1" bindings="$2"
  shift 2
  mandible_syntax_tool bind-entry "$key" "$bindings" "$@"
}

mandible_bind_main_arguments() {
  local key="$1" bindings="$2"
  shift 2
  mandible_syntax_tool bind-main "$key" "$bindings" "$@"
}

mandible_command_help() {
  mandible_syntax_tool help "$@"
}
mandible_parse_command() {
  mandible_syntax_tool parse "$@"
}
