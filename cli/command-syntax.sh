#!/usr/bin/env bash
# Sourceable in bash and zsh; keep syntax lookup offline and side-effect free.
MANDIBLE_COMMAND_SYNTAX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)"
mandible_command_syntax() {
  "${NODE_BIN:-node}" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" syntax "$1"
}
mandible_render_commands() {
  "${NODE_BIN:-node}" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" render-cli
}
