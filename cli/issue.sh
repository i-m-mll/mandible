#!/usr/bin/env bash

set -u
set -o pipefail

# Bug: fa1ac4c — CLI wrapper for manual issue operations.
# Ledger-era implementation: ordinary issue operations use the Mandible daemon API.

RESET=$'\033[0m'
RED=$'\033[31m'
GREEN=$'\033[32m'

err() {
  printf "%b\n" "$*" >&2
}

die() {
  err "$1"
  exit "${2:-1}"
}

usage() {
  cat <<'USAGE'
Usage:
  mandible issue new -t <title> -m <body> [--label <label>]...   Create a new issue
  mandible issue list [--status open|closed|all]                  List issues (default: open)
  mandible issue show <id>                                        Show issue details
  mandible issue report <id> [--json]                             Print deterministic issue context
  mandible issue triage [opts] [--json]                           Filter issues for review
  mandible issue close <id> [--commit <sha>]                      Close issue, recording resolving commit
  mandible issue open <id>                                        Reopen a closed issue
  mandible issue description show <issue-ref> [--json]            Show only the issue description
  mandible issue description history <issue-ref> [--json] [--with-body]
                                                                  Show issue description revision history
  mandible issue comment add <issue-ref> -m <text>                 Add a comment
  mandible issue comment show <comment-ref> [--json]               Show one comment
  mandible issue comment history <comment-ref> [--json] [--with-body]
                                                                  Show one comment revision history
  mandible issue revision show <revision-id> [--json]             Show one text revision
  mandible issue revision diff <old-revision-id> <new-revision-id> [--force]
                                                                  Diff two text revisions
  mandible issue label add <id> <label>                           Add a label
  mandible issue label rm <id> <label>                            Remove a label
  mandible issue markdown <audit|normalize|export> [opts]          Audit, normalize, or export ledger Markdown
  mandible issue refs backfill [opts]                              Reanalyze issue/comment cross-references
USAGE
}

require_tools() {
  command -v curl >/dev/null 2>&1 || die "curl not found." 1
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
}

api_base() {
  printf 'http://127.0.0.1:%s' "${MANDIBLE_PORT:-19420}"
}

urlencode() {
  jq -rn --arg value "$1" '$value|@uri'
}

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

repo_ref() {
  local common_dir

  if common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    && [[ -n "$common_dir" ]]; then
    case "$common_dir" in
      */.git)
        dirname "$common_dir"
        return
        ;;
      */.git/*)
        printf '%s\n' "${common_dir%%/.git/*}"
        return
        ;;
    esac
  fi

  repo_root
}

api_get() {
  local path="$1"
  curl -sf --max-time 15 "$(api_base)$path"
}

api_send() {
  local method="$1"
  local path="$2"
  local data="$3"
  curl -sf --max-time 15 -X "$method" "$(api_base)$path" \
    -H 'Content-Type: application/json' \
    -d "$data"
}

labels_json() {
  if (( $# == 0 )); then
    printf '[]'
    return
  fi
  printf '%s\n' "$@" | jq -R . | jq -s .
}

print_issue_detail() {
  jq -r '
    "\(.display_id) [\(.status)] \(.title)",
    (if (.labels | length) > 0 then "labels: \(.labels | join(", "))" else "labels:" end),
    "",
    .body,
    (.comments[]? | "\n---\n\(.id) \(.author.display) \(.source)\n\(.body)")
  '
}

cmd_close() {
  local id=""
  local sha=""

  while (( $# > 0 )); do
    case "$1" in
      --commit)
        if (( $# < 2 )); then
          die "Missing value for --commit." 2
        fi
        sha="$2"
        shift 2
        ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$id" ]]; then
          id="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue close <id> [--commit <sha>]" 2
  fi

  if [[ -z "$sha" ]]; then
    sha=$(git rev-parse HEAD 2>/dev/null) || sha="unknown"
  fi

  require_tools
  local message_payload status_payload resolution_payload repo_id
  message_payload=$(jq -n --arg message "Resolved by commit ${sha:0:12}" '{message:$message}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/comments" "$message_payload" >/dev/null || true

  status_payload=$(jq -n '{status:"closed", resolution:"fixed"}')
  api_send PATCH "/api/ledger/issues/$(urlencode "$id")" "$status_payload" >/dev/null \
    || die "${RED}Failed to close issue ${id}${RESET}" 1

  git notes append -m "closes: ${id:0:8}" "$sha" 2>/dev/null || true
  if ! git config --local push.notesRef >/dev/null 2>&1; then
    git config --local push.notesRef "refs/notes/commits" 2>/dev/null || true
  fi

  repo_id=$(basename "$(repo_root)")
  resolution_payload=$(jq -n --arg issue_id "$id" --arg commit_sha "$sha" --arg repo_id "$repo_id" \
    '{issue_id:$issue_id, commit_sha:$commit_sha, repo_id:$repo_id}')
  api_send POST "/api/issues/resolutions" "$resolution_payload" >/dev/null || true
  err "${GREEN}Closed issue ${id} (resolved by ${sha:0:12})${RESET}"
}

cmd_comment_add() {
  local id=""
  local message=""

  while (( $# > 0 )); do
    case "$1" in
      -m)
        if (( $# < 2 )); then
          die "Missing value for -m." 2
        fi
        message="$2"
        shift 2
        ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$id" ]]; then
          id="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$id" || -z "$message" ]]; then
    die "Usage: mandible issue comment add <issue-ref> -m <text>" 2
  fi

  require_tools
  local payload
  payload=$(jq -n --arg message "$message" '{message:$message}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/comments" "$payload" >/dev/null
}

cmd_show() {
  local id="$1"

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue show <id>" 2
  fi

  require_tools
  api_get "/api/ledger/issues/$(urlencode "$id")" | print_issue_detail
}

cmd_report() {
  local id=""
  local json=0

  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$id" ]]; then
          id="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue report <id> [--json]" 2
  fi

  require_tools
  if (( json )); then
    api_get "/api/ledger/issues/$(urlencode "$id")" | jq '{
      id,
      display_id,
      title,
      status,
      resolution,
      labels,
      priority,
      kind,
      project,
      created_at,
      updated_at,
      closed_at,
      author,
      aliases,
      body,
      comments,
      relationships,
      work_units,
      sessions,
      auth_requests,
      timeline,
      conflicts
    }'
  else
    api_get "/api/ledger/issues/$(urlencode "$id")" | jq -r '
      def list_or_dash(xs): if (xs // []) | length == 0 then "-" else (xs | join(", ")) end;
      def short(s): (s // "" | gsub("\\s+"; " ") | if length > 180 then .[0:177] + "..." else . end);
      "\(.display_id) [\(.status)] \(.title)",
      "labels: \(list_or_dash(.labels))",
      "updated: \(.updated_at // "-")",
      "created: \(.created_at // "-")",
      "comments: \((.comments // []) | length)",
      "relationships: \((.relationships // []) | length)",
      "work_units: \((.work_units // []) | length)",
      "sessions: \((.sessions // []) | length)",
      "auth_requests: \((.auth_requests // []) | length)",
      "",
      "body:",
      (.body // ""),
      "",
      "latest comments:",
      (((.comments // []) | sort_by(.created_at // "") | reverse | .[0:5][])?
        | "- \(.id // "?") \(.author.display // .author.id // "unknown") \(.created_at // ""): \(short(.body))")
    '
  fi
}

cmd_triage() {
  local status="open"
  local label=""
  local stale_days=""
  local limit=50
  local json=0
  local repo=""

  while (( $# > 0 )); do
    case "$1" in
      --status)
        if (( $# < 2 )); then die "Missing value for --status." 2; fi
        status="$2"; shift 2 ;;
      --label)
        if (( $# < 2 )); then die "Missing value for --label." 2; fi
        label="$2"; shift 2 ;;
      --repo)
        if (( $# < 2 )); then die "Missing value for --repo." 2; fi
        repo="$2"; shift 2 ;;
      --stale-days)
        if (( $# < 2 )); then die "Missing value for --stale-days." 2; fi
        stale_days="$2"; shift 2 ;;
      --limit)
        if (( $# < 2 )); then die "Missing value for --limit." 2; fi
        limit="$2"; shift 2 ;;
      --json) json=1; shift ;;
      -*)
        die "Unknown option: $1" 2 ;;
      *)
        die "Unexpected argument: $1" 2 ;;
    esac
  done

  case "$status" in
    open|closed|all|merged) ;;
    *) die "Unknown status: $status (expected open, closed, merged, or all)" 2 ;;
  esac
  if [[ -n "$stale_days" && ! "$stale_days" =~ ^[0-9]+$ ]]; then
    die "--stale-days must be an integer" 2
  fi
  if [[ ! "$limit" =~ ^[0-9]+$ ]]; then
    die "--limit must be an integer" 2
  fi

  require_tools
  local root query
  if [[ -n "$repo" ]]; then
    root=$(urlencode "$repo")
  else
    root=$(urlencode "$(repo_ref)")
  fi
  query="repo=${root}&status=$(urlencode "$status")"
  api_get "/api/issues?${query}" | jq \
    --arg label "$label" \
    --arg stale_days "$stale_days" \
    --argjson limit "$limit" \
    --argjson json "$json" '
      def epoch($s):
        if ($s // "") == "" then 0
        else (($s | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601?) // 0)
        end;
      def stale_cutoff:
        if $stale_days == "" then null
        else (now - (($stale_days | tonumber) * 86400))
        end;
      [ .[] as $repo
        | $repo.issues[]
        | . + {repo_name: $repo.repo_name}
        | select($label == "" or ((.labels // []) | index($label)))
        | select((stale_cutoff == null) or (epoch(.updated_at) <= stale_cutoff))
      ]
      | sort_by(.updated_at // "")
      | .[0:$limit]
      | if $json then .
        else .[] | "\(.id)\t\(.status)\t\(.repo_name)\t\(.updated_at // "-")\t\((.labels // []) | join(","))\t\(.title)"
        end
    '
}

cmd_new() {
  local title=""
  local body=""
  local -a labels=()

  while (( $# > 0 )); do
    case "$1" in
      -t)
        if (( $# < 2 )); then
          die "Missing value for -t." 2
        fi
        title="$2"
        shift 2
        ;;
      -m)
        if (( $# < 2 )); then
          die "Missing value for -m." 2
        fi
        body="$2"
        shift 2
        ;;
      --label)
        if (( $# < 2 )); then
          die "Missing value for --label." 2
        fi
        labels+=("$2")
        shift 2
        ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        die "Unexpected argument: $1" 2
        ;;
    esac
  done

  if [[ -z "$title" || -z "$body" ]]; then
    die "Usage: mandible issue new -t <title> -m <body> [--label <label>]..." 2
  fi

  require_tools
  local root payload id label_json repo
  root=$(repo_root)
  repo=$(basename "$root")
  label_json=$(labels_json "${labels[@]+"${labels[@]}"}")
  payload=$(jq -n --arg title "$title" --arg body "$body" --arg root "$root" --argjson labels "$label_json" \
    '{title:$title, body:$body, root:$root, labels:$labels}')
  id=$(api_send POST "/api/issues/$(urlencode "$repo")" "$payload" | jq -r '.display_id // .id') \
    || die "${RED}Failed to create issue${RESET}" 1
  err "${GREEN}Created issue ${id}${RESET}"
}

cmd_list() {
  local status="open"

  while (( $# > 0 )); do
    case "$1" in
      --status)
        if (( $# < 2 )); then
          die "Missing value for --status." 2
        fi
        status="$2"
        shift 2
        ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        die "Unexpected argument: $1" 2
        ;;
    esac
  done

  case "$status" in
    open|closed|all|merged) ;;
    *) die "Unknown status: $status (expected open, closed, merged, or all)" 2 ;;
  esac

  require_tools
  local root query
  root=$(urlencode "$(repo_ref)")
  query="repo=${root}&status=$(urlencode "$status")"
  api_get "/api/issues?${query}" | jq -r '.[] as $repo | $repo.issues[] | "\(.id)\t\(.status)\t\($repo.repo_name)\t\(.title)"'
}

cmd_label() {
  if (( $# < 1 )); then
    cat <<'LABEL_USAGE' >&2
Usage:
  mandible issue label add <id> <label>   Add a label to an issue
  mandible issue label rm <id> <label>    Remove a label from an issue
LABEL_USAGE
    exit 2
  fi

  local action="$1"
  shift

  case "$action" in
    add) cmd_label_set true "$@" ;;
    rm)  cmd_label_set false "$@" ;;
    *)   die "Unknown label action: $action (expected add or rm)" 2 ;;
  esac
}

cmd_label_set() {
  local present="$1"
  shift
  if (( $# < 2 )); then
    die "Usage: mandible issue label add|rm <id> <label>" 2
  fi

  local id="$1"
  local label="$2"
  local payload
  require_tools
  payload=$(jq -n --arg label "$label" --argjson present "$present" '{label:$label, present:$present}')
  api_send POST "/api/ledger/issues/$(urlencode "$id")/labels" "$payload" >/dev/null \
    || die "${RED}Failed to update label '${label}' on ${id}${RESET}" 1
  if [[ "$present" == "true" ]]; then
    err "${GREEN}Added label '${label}' to ${id}${RESET}"
  else
    err "${GREEN}Removed label '${label}' from ${id}${RESET}"
  fi
}

cmd_open() {
  local id="${1:-}"

  if [[ -z "$id" ]]; then
    die "Usage: mandible issue open <id>" 2
  fi

  require_tools
  api_send PATCH "/api/ledger/issues/$(urlencode "$id")" '{"status":"open","resolution":null}' >/dev/null \
    || die "${RED}Failed to reopen issue ${id}${RESET}" 1
  err "${GREEN}Reopened issue ${id}${RESET}"
}

print_revision_history() {
  local with_body="$1"
  jq -r --arg with_body "$with_body" '
    def timestamp:
      ((.occurred_at // .observed_at // 0) / 1000 | todateiso8601);
    def actor:
      (.actor_id // .actor_type // "-");
    def short_hash:
      ((.new_hash // "")[0:12]);
    .revisions as $revisions
    | if ($revisions | length) == 0 then
        "No body revisions."
      else
        "rev\tid\treason\tsource\toccurred\tactor\thash",
        ($revisions[]
          | "#\(.revision_no)\t\(.id)\t\(.reason)\t\(.source)\t\(timestamp)\t\(actor)\t\(short_hash)",
            (if $with_body == "1" then
              "----- body #\(.revision_no) -----\n\(.snapshot_body)\n----- end body #\(.revision_no) -----"
            else empty end))
      end
  '
}

cmd_description_show() {
  local issue_ref=""
  local json=0

  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$issue_ref" ]]; then
          issue_ref="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$issue_ref" ]]; then
    die "Usage: mandible issue description show <issue-ref> [--json]" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/issues/$(urlencode "$issue_ref")") \
    || die "${RED}Failed to fetch issue ${issue_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '{issue_id: .id, display_id, title, description: .body, updated_at}'
  else
    printf '%s\n' "$response" | jq -r '.body // ""'
  fi
}

cmd_description_history() {
  local issue_ref=""
  local json=0
  local with_body=0

  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      --with-body) with_body=1; shift ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$issue_ref" ]]; then
          issue_ref="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$issue_ref" ]]; then
    die "Usage: mandible issue description history <issue-ref> [--json] [--with-body]" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/issues/$(urlencode "$issue_ref")/body/revisions") \
    || die "${RED}Failed to fetch body revisions for issue ${issue_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | print_revision_history "$with_body"
  fi
}

cmd_description() {
  local action="${1:-}"
  shift || true

  case "$action" in
    show) cmd_description_show "$@" ;;
    history) cmd_description_history "$@" ;;
    ""|-h|--help)
      cat <<'DESCRIPTION_USAGE'
Usage:
  mandible issue description show <issue-ref> [--json]
  mandible issue description history <issue-ref> [--json] [--with-body]
DESCRIPTION_USAGE
      ;;
    *)
      die "Unknown description action: $action (expected show or history)" 2
      ;;
  esac
}

resolve_comment_ref() {
  local comment_ref="$1"

  if [[ "$comment_ref" != *"#"* ]]; then
    printf '%s' "$comment_ref"
    return
  fi

  local issue_ref="${comment_ref%%#*}"
  local selector="${comment_ref##*#}"
  if [[ -z "$issue_ref" || -z "$selector" ]]; then
    die "Comment reference must be <issue-ref>#<ordinal>, <issue-ref>#last, or a raw comment id." 2
  fi
  if [[ "$selector" != "last" && ! "$selector" =~ ^[0-9]+$ ]]; then
    die "Comment selector must be an integer ordinal or 'last': $comment_ref" 2
  fi
  if [[ "$selector" == "0" ]]; then
    die "Comment ordinal 0 is the issue description; use 'mandible issue description show ${issue_ref}' or 'mandible issue description history ${issue_ref}'." 2
  fi

  local comment_id
  if [[ "$selector" == "last" ]]; then
    comment_id=$(
      api_get "/api/ledger/issues/$(urlencode "$issue_ref")" \
        | jq -er '(.comments // [] | sort_by(.created_at // 0) | last | .id) // empty'
    ) || die "${RED}Could not resolve comment reference ${comment_ref}${RESET}" 1
  else
    comment_id=$(
      api_get "/api/ledger/issues/$(urlencode "$issue_ref")" \
        | jq -er --argjson ordinal "$selector" '
            (.comments // [])[]
            | select(.ordinal == $ordinal)
            | .id
          '
    ) || die "${RED}Could not resolve comment reference ${comment_ref}${RESET}" 1
  fi
  printf '%s' "$comment_id"
}

cmd_comment_show() {
  local comment_ref=""
  local json=0

  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$comment_ref" ]]; then
          comment_ref="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$comment_ref" ]]; then
    die "Usage: mandible issue comment show <comment-ref> [--json]" 2
  fi

  require_tools
  local comment_id response
  comment_id=$(resolve_comment_ref "$comment_ref")
  response=$(api_get "/api/ledger/comments/$(urlencode "$comment_id")/revisions") \
    || die "${RED}Failed to fetch comment ${comment_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq --arg comment_id "$comment_id" '{
      comment_id: $comment_id,
      revision: (.revisions // [] | sort_by(.revision_no) | last),
      body: ((.revisions // [] | sort_by(.revision_no) | last | .snapshot_body) // "")
    }'
  else
    printf '%s\n' "$response" | jq -r '(.revisions // [] | sort_by(.revision_no) | last | .snapshot_body) // ""'
  fi
}

cmd_comment_history() {
  local comment_ref=""
  local json=0
  local with_body=0

  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      --with-body) with_body=1; shift ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$comment_ref" ]]; then
          comment_ref="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$comment_ref" ]]; then
    die "Usage: mandible issue comment history <comment-ref> [--json] [--with-body]" 2
  fi

  require_tools
  local comment_id response
  comment_id=$(resolve_comment_ref "$comment_ref")
  response=$(api_get "/api/ledger/comments/$(urlencode "$comment_id")/revisions") \
    || die "${RED}Failed to fetch body revisions for comment ${comment_ref}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | print_revision_history "$with_body"
  fi
}

cmd_comment() {
  local action="${1:-}"

  case "$action" in
    add)
      shift
      cmd_comment_add "$@"
      ;;
    show)
      shift
      cmd_comment_show "$@"
      ;;
    history)
      shift
      cmd_comment_history "$@"
      ;;
    ""|-h|--help)
      cat <<'COMMENT_USAGE'
Usage:
  mandible issue comment add <issue-ref> -m <text>
  mandible issue comment show <comment-ref> [--json]
  mandible issue comment history <comment-ref> [--json] [--with-body]

Comment refs can be raw comment IDs, <issue-ref>#<ordinal>, or <issue-ref>#last.
Compatibility alias: mandible issue comment <issue-ref> -m <text>
COMMENT_USAGE
      ;;
    *)
      cmd_comment_add "$@"
      ;;
  esac
}

fetch_revision() {
  local revision_id="$1"
  api_get "/api/ledger/body-revisions/$(urlencode "$revision_id")" | jq -c '.revision'
}

print_revision_detail() {
  jq -r '
    def timestamp:
      ((.occurred_at // .observed_at // 0) / 1000 | todateiso8601);
    "revision: \(.id)",
    "entity: \(.entity_type) \(.entity_id)",
    "issue: \(.issue_id)",
    "number: #\(.revision_no)",
    "reason: \(.reason)",
    "source: \(.source)",
    "occurred: \(timestamp)",
    "actor: \(.actor_id // .actor_type // "-")",
    "base_revision: \(.base_revision_id // "-")",
    "hash: \(.new_hash)",
    "",
    "body:",
    .snapshot_body
  '
}

cmd_revision_show() {
  local revision_id=""
  local json=0

  while (( $# > 0 )); do
    case "$1" in
      --json) json=1; shift ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$revision_id" ]]; then
          revision_id="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$revision_id" ]]; then
    die "Usage: mandible issue revision show <revision-id> [--json]" 2
  fi

  require_tools
  local response
  response=$(api_get "/api/ledger/body-revisions/$(urlencode "$revision_id")") \
    || die "${RED}Failed to fetch body revision ${revision_id}${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq '.'
  else
    printf '%s\n' "$response" | jq -c '.revision' | print_revision_detail
  fi
}

cmd_revision_diff() {
  local old_revision_id=""
  local new_revision_id=""
  local force=0

  while (( $# > 0 )); do
    case "$1" in
      --force) force=1; shift ;;
      -*)
        die "Unknown option: $1" 2
        ;;
      *)
        if [[ -z "$old_revision_id" ]]; then
          old_revision_id="$1"
        elif [[ -z "$new_revision_id" ]]; then
          new_revision_id="$1"
        else
          die "Unexpected argument: $1" 2
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$old_revision_id" || -z "$new_revision_id" ]]; then
    die "Usage: mandible issue revision diff <old-revision-id> <new-revision-id> [--force]" 2
  fi

  command -v python3 >/dev/null 2>&1 || die "python3 not found." 1
  require_tools

  local old_revision new_revision old_entity new_entity old_id new_id
  old_revision=$(fetch_revision "$old_revision_id") \
    || die "${RED}Failed to fetch body revision ${old_revision_id}${RESET}" 1
  new_revision=$(fetch_revision "$new_revision_id") \
    || die "${RED}Failed to fetch body revision ${new_revision_id}${RESET}" 1
  old_entity=$(printf '%s\n' "$old_revision" | jq -r '.entity_type')
  new_entity=$(printf '%s\n' "$new_revision" | jq -r '.entity_type')
  old_id=$(printf '%s\n' "$old_revision" | jq -r '.entity_id')
  new_id=$(printf '%s\n' "$new_revision" | jq -r '.entity_id')

  if (( ! force )) && [[ "$old_entity:$old_id" != "$new_entity:$new_id" ]]; then
    die "Refusing to diff revisions from different entities (${old_entity}:${old_id} vs ${new_entity}:${new_id}); pass --force to override." 2
  fi

  local old_file new_file
  old_file=$(mktemp)
  new_file=$(mktemp)
  printf '%s\n' "$old_revision" | jq -j '.snapshot_body' > "$old_file"
  printf '%s\n' "$new_revision" | jq -j '.snapshot_body' > "$new_file"

  local status
  python3 - "$old_file" "$new_file" "$old_revision" "$new_revision" <<'PY'
import difflib
import json
import sys

old_path, new_path, old_json, new_json = sys.argv[1:5]
old = json.loads(old_json)
new = json.loads(new_json)

def label(revision):
    return f"{revision['id']} #{revision['revision_no']} {revision['entity_type']}:{revision['entity_id']}"

with open(old_path, "r", encoding="utf-8") as handle:
    old_lines = handle.read().splitlines()
with open(new_path, "r", encoding="utf-8") as handle:
    new_lines = handle.read().splitlines()

for line in difflib.unified_diff(
    old_lines,
    new_lines,
    fromfile=label(old),
    tofile=label(new),
    lineterm="",
):
    print(line)
PY
  status=$?
  rm -f "$old_file" "$new_file"
  return "$status"
}

cmd_revision() {
  local action="${1:-}"
  shift || true

  case "$action" in
    show) cmd_revision_show "$@" ;;
    diff) cmd_revision_diff "$@" ;;
    ""|-h|--help)
      cat <<'REVISION_USAGE'
Usage:
  mandible issue revision show <revision-id> [--json]
  mandible issue revision diff <old-revision-id> <new-revision-id> [--force]
REVISION_USAGE
      ;;
    *)
      die "Unknown revision action: $action (expected show or diff)" 2
      ;;
  esac
}

cmd_refs() {
  local action="${1:-}"
  shift || true

  case "$action" in
    backfill)
      local root
      root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
      exec node "$root/dist/cli/issue-refs-backfill.js" "$@"
      ;;
    ""|-h|--help)
      cat <<'REFS_USAGE'
Usage:
  mandible issue refs backfill [--dry-run] [--apply] [--repo <repo>] [--issue <ref>] [--since <date>] [--until <date>] [--json]
REFS_USAGE
      ;;
    *)
      die "Unknown refs action: $action (expected backfill)" 2
      ;;
  esac
}

cmd_markdown() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  exec node "$root/dist/cli/issue-markdown-tools.js" "$@"
}

# --- Main ---

if (( $# < 1 )); then
  usage
  exit 2
fi

subcmd="$1"
shift

case "$subcmd" in
  new)     cmd_new "$@" ;;
  list)    cmd_list "$@" ;;
  show)    cmd_show "${1:-}" ;;
  report)  cmd_report "$@" ;;
  triage)  cmd_triage "$@" ;;
  close)   cmd_close "$@" ;;
  open)    cmd_open "${1:-}" ;;
  description) cmd_description "$@" ;;
  comment) cmd_comment "$@" ;;
  body-history) cmd_description_history "$@" ;;
  comment-history) cmd_comment_history "$@" ;;
  revision) cmd_revision "$@" ;;
  label)   cmd_label "$@" ;;
  markdown) cmd_markdown "$@" ;;
  refs)    cmd_refs "$@" ;;
  -h|--help) usage ;;
  *)       die "Unknown subcommand: $subcmd" 2 ;;
esac
