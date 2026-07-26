#!/bin/bash
# mandible wrap: Process lifecycle wrapper for LLM agent sessions
# Registers with Mandible on start, deregisters via orphan watcher on exit.
# Uses exec for full TTY passthrough — the wrapped command replaces this process.
#
# Usage: mandible wrap [--app NAME] [--id ID] -- command [args...]
#        mandible wrap -- claude --dangerously-skip-permissions
#        mandible wrap -- codex exec "fix the bug"
#        mandible wrap --app codex --id my-session-123 -- codex

set -uo pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher
GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"
API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

# ── Argument parsing ─────────────────────────────────────────────

APP=""
SESSION_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      APP="$2"
      shift 2
      ;;
    --id)
      SESSION_ID="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "Usage: mandible wrap [--app NAME] [--id ID] -- command [args...]" >&2
  exit 2
fi

# Infer app from command basename if not specified
if [ -z "$APP" ]; then
  CMD_BASE="$(basename "$1")"
  case "$CMD_BASE" in
    claude*) APP="claude" ;;
    codex*)  APP="codex" ;;
    *)       APP="$CMD_BASE" ;;
  esac
fi

# Generate session ID if not provided
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
fi

# Export so Claude hooks can discover and reuse the same session ID
export MANDIBLE_SESSION_ID="$SESSION_ID"

# Signal to shell init (lib/agent-signing.sh) that this is an AI agent
# session — use software signing key instead of YubiKey.
export AI_AGENT_SIGNING=1

# ── Per-agent identity token injection ───────────────────────────
# Give the launched agent its own verified Mandible identity by fetching
# a per-agent api_token from the macOS keychain and exporting it into the
# launched process's environment only (it is inherited by the exec'd
# command below, never written back to the operator's shell).
#
# The keychain item is a generic password whose service name derives from
# the app: `mandible-agent-<app>` (e.g. mandible-agent-claude,
# mandible-agent-codex). This is the same mechanism for every app that has
# such an item; apps without one simply get nothing. Absence is normal.
# Provision one with `mandible user token mint <user> --store` (issue e2cb93f).
#
# The token value is never printed, logged, echoed, or written to disk; the
# read goes through the secret seam in cli/api.sh, whose exit status and a
# non-empty result are the only success signals. Everything here is non-fatal
# and quiet by default. Opt out with MANDIBLE_NO_KEYCHAIN_TOKEN=1.
#
# Issue 0b989d1 — the PAT is not what gets exported. It is first exchanged for a
# token scoped to THIS session id, which the daemon invalidates when the session
# ends (plus a TTL backstop). The keychain PAT then never enters an agent's
# environment, so a transcript leak exposes only a credential that is already
# dead. The exchange is best-effort by design: any failure falls back to
# exporting the PAT, because a down daemon must never lock an agent out.

# Exchange a long-lived agent PAT for a session-scoped ephemeral token.
# Prints the ephemeral token on stdout and returns 0 on success; returns
# non-zero (printing nothing) on every failure, which is the caller's signal to
# fall back to the PAT. The bearer travels in a 0600 curl config file, never on
# argv where `ps` would show it (the cli/api.sh idiom). Callers must already
# have suspended xtrace: the captured token would otherwise be traced.
exchange_session_token() {
  local pat="$1"
  local cfg="" body="" out="" http_status="" token="" token_body=""

  [ -n "${MANDIBLE_BASE:-}" ] || return 1
  case "$MANDIBLE_BASE" in file://*) return 1 ;; esac
  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1

  cfg=$(api_temp_file) || return 1
  body=$(api_temp_file) || { rm -f "$cfg"; return 1; }
  out=$(api_temp_file) || { rm -f "$cfg" "$body"; return 1; }

  printf 'header = "Authorization: Bearer %s"\n' "$pat" > "$cfg" \
    && jq -n --arg id "$SESSION_ID" '{session_id: $id}' > "$body" 2>/dev/null \
    && http_status=$(curl -s \
      --max-time "${MANDIBLE_SESSION_TOKEN_TIMEOUT:-2}" \
      --config "$cfg" \
      -o "$out" -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' \
      --data-binary "@$body" \
      "$(api_base)/api/client-auth/session-token" 2>/dev/null)

  case "${http_status:-000}" in
    2*) token=$(jq -r '.token // empty' < "$out" 2>/dev/null) || token="" ;;
  esac

  rm -f "$cfg" "$body" "$out"
  case "$token" in
    mandible_pat_*)
      [ "${#token}" -eq 56 ] || return 1
      token_body="${token#mandible_pat_}"
      case "$token_body" in
        *[!A-Za-z0-9_-]*) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
  printf '%s' "$token"
}

inject_agent_token() {
  # Explicit opt-out.
  [ "${MANDIBLE_NO_KEYCHAIN_TOKEN:-}" = "1" ] && return 0
  # Respect an already-provided token (e.g. injected by the launcher).
  [ -n "${MANDIBLE_TOKEN:-}" ] && return 0
  # Need a known app to derive the service name.
  [ -n "$APP" ] || return 0

  local service token session_token traced=0
  service="mandible-agent-$APP"
  # Suspend xtrace across the capture AND the export: under `bash -x` both the
  # assignment and the export line would echo the token (issue e2cb93f). The
  # previous setting is restored on every path below, so the state this function
  # leaves behind — and therefore what the exec'd command inherits — is exactly
  # what it found.
  case "$-" in *x*) traced=1; { set +x; } 2>/dev/null ;; esac
  # An unavailable backend or an absent item is normal here: leave the token
  # unset and let the session run with whatever identity it already has.
  if ! token=$(secret_get "$service"); then
    [ "$traced" -eq 0 ] || set -x
    return 0
  fi
  if [ -n "$token" ]; then
    # Fail open (mandatory): only a completed exchange replaces the PAT.
    if [ "${MANDIBLE_NO_SESSION_TOKEN_EXCHANGE:-}" != "1" ] \
      && session_token=$(exchange_session_token "$token") \
      && [ -n "$session_token" ]; then
      export MANDIBLE_TOKEN="$session_token"
    else
      export MANDIBLE_TOKEN="$token"
    fi
  fi
  [ "$traced" -eq 0 ] || set -x
}

inject_agent_token

# Detect if the wrapped command uses --dangerously-* flags (YOLO mode).
# Agents check this to maintain permission parity when delegating to sub-agents.
CLAUDE_SKIP_PERMISSIONS=0
for _arg in "$@"; do
  case "$_arg" in
    --dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox)
      CLAUDE_SKIP_PERMISSIONS=1
      break
      ;;
  esac
done
export CLAUDE_SKIP_PERMISSIONS

# ── Environment detection ────────────────────────────────────────

detect_terminal() {
  if [ -n "${WEZTERM_PANE:-}" ] || [ -n "${WEZTERM_PANE_ID:-}" ]; then
    echo "wezterm"
  elif [ -n "${KITTY_WINDOW_ID:-}" ]; then
    echo "kitty"
  elif [ -n "${ITERM_SESSION_ID:-}" ]; then
    echo "iterm"
  elif [ -n "${TERM_PROGRAM:-}" ]; then
    echo "$TERM_PROGRAM" | tr '[:upper:]' '[:lower:]'
  fi
}

detect_multiplexer() {
  if [ -n "${ZELLIJ:-}" ]; then
    echo "zellij"
  elif [ -n "${TMUX:-}" ]; then
    echo "tmux"
  fi
}

TERMINAL=$(detect_terminal)
MULTIPLEXER=$(detect_multiplexer)

BRANCH=""
WORKTREE=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null || true)
  WORKTREE=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi

PID_START=$(ps -p $$ -o lstart= 2>/dev/null | sed 's/^ *//' || true)

# ── Multiplexer nav data ────────────────────────────────────────

NAV_SESSION=""
NAV_TAB=""
NAV_PANE_ID=""
TMUX_SESSION=""
TMUX_WINDOW_ID=""
TMUX_WINDOW_NAME=""
TMUX_PANE_ID=""
TMUX_CLIENT_TTY=""

if [ "$MULTIPLEXER" = "zellij" ] && command -v zellij >/dev/null 2>&1; then
  NAV_SESSION="${ZELLIJ_SESSION_NAME:-${ZELLIJ_SESSION:-${ZELLIJ:-}}}"
  NAV_PANE_ID="${ZELLIJ_PANE_ID:-}"
elif [ "$MULTIPLEXER" = "tmux" ] && command -v tmux >/dev/null 2>&1; then
  TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null || true)
  TMUX_WINDOW_ID=$(tmux display-message -p '#I' 2>/dev/null || true)
  TMUX_WINDOW_NAME=$(tmux display-message -p '#W' 2>/dev/null || true)
  TMUX_PANE_ID=$(tmux display-message -p '#D' 2>/dev/null || true)
  TMUX_CLIENT_TTY=$(tmux display-message -p '#{client_tty}' 2>/dev/null || true)
  NAV_SESSION="$TMUX_SESSION"
  NAV_TAB="$TMUX_WINDOW_NAME"
  NAV_PANE_ID="$TMUX_PANE_ID"
fi

# ── Registration ─────────────────────────────────────────────────

register_session() {
  # Bail if dependencies missing
  if ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  local zellij_tab_status=""
  if [ "$MULTIPLEXER" = "zellij" ]; then
    zellij_tab_status="pending"
  fi

  local nav_extra
  nav_extra=$(jq -n \
    --arg wezterm_pane_id "${WEZTERM_PANE_ID:-${WEZTERM_PANE:-}}" \
    --arg wezterm_window_id "${WEZTERM_WINDOW_ID:-}" \
    --arg kitty_window_id "${KITTY_WINDOW_ID:-}" \
    --arg iterm_session_id "${ITERM_SESSION_ID:-}" \
    --arg tmux_session "$TMUX_SESSION" \
    --arg tmux_window_id "$TMUX_WINDOW_ID" \
    --arg tmux_window_name "$TMUX_WINDOW_NAME" \
    --arg tmux_pane_id "$TMUX_PANE_ID" \
    --arg tmux_client_tty "$TMUX_CLIENT_TTY" \
    --arg zellij_tab_status "$zellij_tab_status" \
    '{
      wezterm_pane_id: $wezterm_pane_id,
      wezterm_window_id: $wezterm_window_id,
      kitty_window_id: $kitty_window_id,
      iterm_session_id: $iterm_session_id,
      tmux_session: $tmux_session,
      tmux_window_id: $tmux_window_id,
      tmux_window_name: $tmux_window_name,
      tmux_pane_id: $tmux_pane_id,
      tmux_client_tty: $tmux_client_tty,
      zellij_tab_status: $zellij_tab_status
    } | with_entries(select(.value != ""))') || nav_extra="{}"

  local payload
  payload=$(jq -n \
    --arg id "$SESSION_ID" \
    --arg app "$APP" \
    --arg pid "$$" \
    --arg pid_start "$PID_START" \
    --arg cwd "$PWD" \
    --arg branch "$BRANCH" \
    --arg worktree "$WORKTREE" \
    --arg terminal "$TERMINAL" \
    --arg multiplexer "$MULTIPLEXER" \
    --arg nav_session "$NAV_SESSION" \
    --arg nav_tab "$NAV_TAB" \
    --arg nav_pane_id "$NAV_PANE_ID" \
    --argjson nav_extra "$nav_extra" \
    '{
      id: $id,
      app: $app,
      pid: (if $pid == "" then null else ($pid | tonumber) end),
      pid_start: (if $pid_start == "" then null else $pid_start end),
      cwd: (if $cwd == "" then null else $cwd end),
      branch: (if $branch == "" then null else $branch end),
      worktree: (if $worktree == "" then null else $worktree end),
      terminal: (if $terminal == "" then null else $terminal end),
      multiplexer: (if $multiplexer == "" then null else $multiplexer end),
      nav_session: (if $nav_session == "" then null else $nav_session end),
      nav_tab: (if $nav_tab == "" then null else $nav_tab end),
      nav_pane_id: (if $nav_pane_id == "" then null else $nav_pane_id end),
      nav_extra: $nav_extra
    }') || return 0

  api_send POST "/api/sessions/register" "$payload" >/dev/null 2>&1 || true
}

# ── Orphan watcher (deregisters when exec'd process dies) ────────

# Capture PID before subshell — $$ in subshell still refers to parent
WRAPPER_PID=$$

spawn_watcher() {
  (
    # Ignore signals meant for the foreground process
    trap '' TERM INT HUP
    while kill -0 "$WRAPPER_PID" 2>/dev/null; do
      sleep 1
    done
    # Process died — deregister
    api_send PATCH "/api/sessions/$(urlencode "$SESSION_ID")/end" '{"status":"ended"}' >/dev/null 2>&1 || true
  ) &
  disown 2>/dev/null || true
}

# ── Main ─────────────────────────────────────────────────────────

register_session
spawn_watcher
exec "$@"
