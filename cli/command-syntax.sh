#!/usr/bin/env bash
# Sourceable in bash and zsh; keep syntax lookup offline and side-effect free.
MANDIBLE_COMMAND_SYNTAX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)"
# Repository and flattened cache bundles carry the same verified selector.
mandible_bun_runtime() {
  local selector="$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh"
  if [[ -f "$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/scripts/bun-runtime.sh" ]]; then
    selector="$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/scripts/bun-runtime.sh"
    export MANDIBLE_RUNTIME_STORE="$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/cache"
    unset MANDIBLE_RELEASE_ROOT MANDIBLE_RUNTIME MANDIBLE_RUNTIME_ARCHIVE
  fi
  "$selector" --bun-only
}
mandible_cli_module() {
  local relative="$1" root
  if [[ -f "$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/scripts/bun-runtime.sh" ]]; then
    echo 'This command requires host-local resources; use the installed Mandible command on the host.' >&2
    return 2
  fi
  root="$(cd "$MANDIBLE_COMMAND_SYNTAX_DIR/.." && pwd -P)"
  if [[ -n "${MANDIBLE_RELEASE_ROOT:-}" || -f "$root/release.json" ]]; then
    printf '%s/dist/%s.js\n' "${MANDIBLE_RELEASE_ROOT:-$root}" "$relative"
  else
    printf '%s/src/%s.ts\n' "$root" "$relative"
  fi
}
mandible_prepare_syntax_runtime() {
  # Native arrays cannot arrive through the environment. An inherited scalar
  # never constitutes evidence that this shell qualified the runtime.
  case "$(builtin typeset -p _MANDIBLE_SYNTAX_RUNTIME 2>/dev/null)" in
    "declare -a "*|"typeset -a "*|"typeset -g -a "*)
      if [[ "${_MANDIBLE_SYNTAX_SOURCE:-}" == "$MANDIBLE_COMMAND_SYNTAX_DIR" && "${#_MANDIBLE_SYNTAX_RUNTIME[@]}" == 1 && -n "${_MANDIBLE_SYNTAX_RUNTIME[@]}" ]]; then
        return 0
      fi ;;

  esac
  unset _MANDIBLE_SYNTAX_RUNTIME
  local selector="$MANDIBLE_COMMAND_SYNTAX_DIR/../scripts/bun-runtime.sh" runtime
  if [[ -f "$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/scripts/bun-runtime.sh" ]]; then
    selector="$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/scripts/bun-runtime.sh"
    export MANDIBLE_RUNTIME_STORE="$MANDIBLE_COMMAND_SYNTAX_DIR/runtime/cache"
    unset MANDIBLE_RELEASE_ROOT MANDIBLE_RUNTIME MANDIBLE_RUNTIME_ARCHIVE
  fi
  runtime="$("$selector" --bun-only)" || return
  [[ -n "$runtime" ]] || return 1
  _MANDIBLE_SYNTAX_SOURCE="$MANDIBLE_COMMAND_SYNTAX_DIR"
  _MANDIBLE_SYNTAX_RUNTIME=("$runtime")
}

mandible_syntax_tool() {
  mandible_prepare_syntax_runtime || return
  "${_MANDIBLE_SYNTAX_RUNTIME[@]}" "$MANDIBLE_COMMAND_SYNTAX_DIR/command-syntax.cjs" "$@"
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

# API-only callers do not parse arguments. Entrypoints qualify in the parent
# before their command substitutions; repeated sources retain the shell array.
if [[ "${1:-}" != --mandible-syntax-definitions-only ]]; then
  mandible_prepare_syntax_runtime || exit $?
fi
