#!/usr/bin/env bash

set -o pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

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
pid="${pid:-${CLAUDE_PID:-}}"

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

payload=$(jq -n \
  --arg id "$session_id" \
  --arg conversation_id "$provider_session_id" \
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
    conversation_id: (if $conversation_id == "" then null else $conversation_id end),
    app: $app,
    cwd: (if $cwd == "" then null else $cwd end),
    branch: (if $branch == "" then null else $branch end),
    worktree: (if $worktree == "" then null else $worktree end),
    terminal: (if $terminal == "" then null else $terminal end),
    multiplexer: (if $multiplexer == "" then null else $multiplexer end),
    nav_session: (if $nav_session == "" then null else $nav_session end),
    nav_tab: (if $nav_tab == "" then null else $nav_tab end),
    nav_pane_id: (if $nav_pane_id == "" then null else $nav_pane_id end),
    nav_extra: $nav_extra
  }
  + (if $pid == "" then {} else { pid: ($pid | tonumber), pid_start: (if $pid_start == "" then null else $pid_start end) } end)')

api_send POST /api/sessions/register "$payload" >/dev/null || exit 1

# Check inbox for pending items.
# Bug: 4e32923 — surface a single-line summary of *escalated* (tier 2/3) and
# legacy (tier 0) auth results plus continuations and work units. Owner
# (tier-1) auth results are delivered live via the MCP channel server and
# must not be re-surfaced at session start; otherwise every session would
# re-see results that are already in the agent's context. Nothing prints if
# there is nothing to show.
inbox_json=$(api_get "/api/inbox/global?session_id=$(urlencode "$session_id")") || exit 1
if [[ -n "$inbox_json" ]]; then
  summary=$(printf '%s' "$inbox_json" | jq -r '
    # Tier 1 is delivered via the channel server; surface only escalated /
    # legacy auth results (tier in {0, 2, 3}) plus continuations and work units.
    ( [ .auth_results[]? | select((.tier // 0) != 1) ] ) as $auth
    | ( .continuations // [] ) as $cont
    | ( .work_units // [] ) as $wu
    | ( ($auth | length) + ($cont | length) + ($wu | length) ) as $n
    | if $n == 0 then empty
      else
        "Mandible inbox: \($n) item(s)"
        + (if ($auth | length) > 0 then " — \($auth | length) auth result(s)" else "" end)
        + (if ($cont | length) > 0 then " — \($cont | length) continuation(s)" else "" end)
        + (if ($wu | length) > 0 then " — \($wu | length) work unit(s)" else "" end)
      end
  ' 2>/dev/null || true)
  if [[ -n "$summary" ]]; then
    printf '%s\n' "$summary"
  fi
fi

exit 0
