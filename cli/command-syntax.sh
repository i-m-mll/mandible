#!/usr/bin/env bash
# Sourceable in bash and zsh; keep syntax lookup offline and side-effect free.
MANDIBLE_COMMAND_SYNTAX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)"
mandible_command_syntax() {
  "$("$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh")" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" syntax "$1"
}
mandible_render_commands() {
  "$("$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh")" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" render-cli
}

mandible_bind_arguments() {
  local key="$1" bindings="$2"
  shift 2
  "$("$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh")" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" bind-entry "$key" "$bindings" "$@"
}

mandible_bind_main_arguments() {
  local key="$1" bindings="$2"
  shift 2
  "$("$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh")" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" bind-main "$key" "$bindings" "$@"
}

mandible_command_help() {
  "$("$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh")" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" help "$@"
}
mandible_parse_command() {
  "$("$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh")" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" parse "$@"
}
