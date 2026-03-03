#!/usr/bin/env bash

set -o pipefail

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)

session_id="${MANDIBLE_SESSION_ID:-}"
if [[ -z "$session_id" ]]; then
  session_id=$(echo "$INPUT" | jq -r '.session_id // .id // .session.id // empty')
fi
if [[ -z "$session_id" ]]; then
  exit 0
fi

MANDIBLE_PORT="${MANDIBLE_PORT:-19420}"
health_url="http://127.0.0.1:${MANDIBLE_PORT}/api/health"

app=$(echo "$INPUT" | jq -r '.app // empty')
if [[ -z "$app" ]]; then
  # Codex detection: CODEX_THREAD_ID is set by Codex CLI on every spawned
  # process. Also check CODEX_CLI/CODEX for backwards compatibility.
  if [[ -n "${CODEX_THREAD_ID:-}" || -n "${CODEX_CLI:-}" || -n "${CODEX:-}" ]]; then
    app="codex"
  else
    app="claude"
  fi
fi

pid=$(echo "$INPUT" | jq -r '.pid // .process_id // empty')
if [[ -n "$pid" && "$pid" == "null" ]]; then
  pid=""
fi

cwd=$(echo "$INPUT" | jq -r '.cwd // .workspace // empty')
if [[ -z "$cwd" ]]; then
  cwd="$PWD"
fi

branch=$(echo "$INPUT" | jq -r '.branch // empty')
worktree=$(echo "$INPUT" | jq -r '.worktree // empty')

if [[ -z "$branch" ]] && git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)
fi

if [[ -z "$worktree" ]] && git -C "$cwd" rev-parse --show-toplevel >/dev/null 2>&1; then
  worktree=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)
fi

pid_start=""
if [[ -n "$pid" ]]; then
  pid_start=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//')
  if [[ -z "$pid_start" ]]; then
    pid_start=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
  fi
fi

terminal=""
if [[ -n "${WEZTERM_PANE:-}" || -n "${WEZTERM_PANE_ID:-}" ]]; then
  terminal="wezterm"
elif [[ -n "${KITTY_WINDOW_ID:-}" ]]; then
  terminal="kitty"
elif [[ -n "${ITERM_SESSION_ID:-}" ]]; then
  terminal="iterm"
elif [[ -n "${TERM_PROGRAM:-}" ]]; then
  terminal=$(echo "$TERM_PROGRAM" | tr '[:upper:]' '[:lower:]')
fi

multiplexer=""
if [[ -n "${ZELLIJ:-}" ]]; then
  multiplexer="zellij"
elif [[ -n "${TMUX:-}" ]]; then
  multiplexer="tmux"
fi

nav_session=$(echo "$INPUT" | jq -r '.nav_session // empty')
nav_tab=$(echo "$INPUT" | jq -r '.nav_tab // empty')
nav_pane_id=$(echo "$INPUT" | jq -r '.nav_pane_id // empty')

if [[ "$multiplexer" == "zellij" ]] && command -v zellij >/dev/null 2>&1; then
  if [[ -z "$nav_session" ]]; then
    nav_session="${ZELLIJ_SESSION_NAME:-${ZELLIJ_SESSION:-${ZELLIJ:-}}}"
  fi
  if [[ -z "$nav_pane_id" ]]; then
    nav_pane_id="${ZELLIJ_PANE_ID:-}"
  fi
fi

if [[ "$multiplexer" == "tmux" ]] && command -v tmux >/dev/null 2>&1; then
  tmux_session=$(tmux display-message -p '#S' 2>/dev/null || true)
  tmux_window_id=$(tmux display-message -p '#I' 2>/dev/null || true)
  tmux_window_name=$(tmux display-message -p '#W' 2>/dev/null || true)
  tmux_pane_id=$(tmux display-message -p '#D' 2>/dev/null || true)
  tmux_client_tty=$(tmux display-message -p '#{client_tty}' 2>/dev/null || true)
  if [[ -z "$nav_session" ]]; then
    nav_session="$tmux_session"
  fi
  if [[ -z "$nav_tab" ]]; then
    nav_tab="$tmux_window_name"
  fi
  if [[ -z "$nav_pane_id" ]]; then
    nav_pane_id="$tmux_pane_id"
  fi
else
  tmux_session=""
  tmux_window_id=""
  tmux_window_name=""
  tmux_pane_id=""
  tmux_client_tty=""
fi

zellij_tab_status=""
if [[ "$multiplexer" == "zellij" ]]; then
  zellij_tab_status="pending"
fi

nav_extra=$(jq -n \
  --arg wezterm_pane_id "${WEZTERM_PANE_ID:-${WEZTERM_PANE:-}}" \
  --arg wezterm_window_id "${WEZTERM_WINDOW_ID:-}" \
  --arg kitty_window_id "${KITTY_WINDOW_ID:-}" \
  --arg iterm_session_id "${ITERM_SESSION_ID:-}" \
  --arg tmux_session "$tmux_session" \
  --arg tmux_window_id "$tmux_window_id" \
  --arg tmux_window_name "$tmux_window_name" \
  --arg tmux_pane_id "$tmux_pane_id" \
  --arg tmux_client_tty "$tmux_client_tty" \
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
  } | with_entries(select(.value != ""))')

if ! curl -fsS --max-time 0.5 "$health_url" >/dev/null 2>&1; then
  script_dir=$(cd "$(dirname "$0")" && pwd)
  root_dir=$(cd "$script_dir/.." && pwd)
  entry_path="${MANDIBLE_ENTRY:-$root_dir/dist/index.js}"
  if [[ -f "$entry_path" ]]; then
    MANDIBLE_PORT="$MANDIBLE_PORT" nohup node "$entry_path" >/dev/null 2>&1 &
    attempts=0
    while [[ $attempts -lt 15 ]]; do
      if curl -fsS --max-time 0.5 "$health_url" >/dev/null 2>&1; then
        break
      fi
      attempts=$((attempts + 1))
      sleep 0.2
    done
  fi
fi

payload=$(jq -n \
  --arg id "$session_id" \
  --arg app "$app" \
  --arg pid "$pid" \
  --arg pid_start "$pid_start" \
  --arg cwd "$cwd" \
  --arg branch "$branch" \
  --arg worktree "$worktree" \
  --arg terminal "$terminal" \
  --arg multiplexer "$multiplexer" \
  --arg nav_session "$nav_session" \
  --arg nav_tab "$nav_tab" \
  --arg nav_pane_id "$nav_pane_id" \
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
  }')

curl -sS --max-time 5 -X POST "http://127.0.0.1:${MANDIBLE_PORT}/api/sessions/register" \
  -H "Content-Type: application/json" \
  -d "$payload" >/dev/null 2>&1 || exit 0

# Check inbox for pending items (non-fatal)
mandible_bin="$HOME/.dotfiles/bin/mandible"
if [[ -x "$mandible_bin" ]]; then
  inbox_result=$("$mandible_bin" inbox check 2>/dev/null) || true
  if [[ -n "$inbox_result" ]]; then
    printf '%s\n' "$inbox_result"
  fi
fi

exit 0
