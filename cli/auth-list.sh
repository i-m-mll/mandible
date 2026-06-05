#!/usr/bin/env zsh
# mandible auth list: List active Mandible auth requests.
#
# Usage: mandible auth list [options]

emulate -L zsh -o pipefail

# MANDIBLE_PORT and MANDIBLE_BASE are exported by the dispatcher.

json=0
repo_filter=""
head_filter=""
base_filter=""
status_filter=""
type_filter=""

usage() {
  cat <<'EOF'
Usage: mandible auth list [options]

List active auth requests from the Mandible daemon. The active queue includes
pending, approved, executing, expired, failed, and recently resolved requests.

Options:
  --json              Print the raw queue JSON.
  --repo <name>       Filter by repository name.
  --head <branch>     Filter by head/source branch.
  --base <branch>     Filter by base/target branch.
  --status <status>   Filter by request status.
  --type <type>       Filter by auth request type.
  -h, --help          Show this help.

Examples:
  mandible auth list
  mandible auth list --repo mandible --head feature/example
  mandible auth list --status pending --json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) json=1; shift ;;
    --repo) repo_filter="${2:?--repo requires a value}"; shift 2 ;;
    --head) head_filter="${2:?--head requires a value}"; shift 2 ;;
    --base) base_filter="${2:?--base requires a value}"; shift 2 ;;
    --status) status_filter="${2:?--status requires a value}"; shift 2 ;;
    --type) type_filter="${2:?--type requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) print -u2 "Unknown option: $1"; usage >&2; exit 1 ;;
    *) print -u2 "Unexpected argument: $1"; usage >&2; exit 1 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  print -u2 "Error: jq is required for mandible auth list."
  exit 1
fi

url="${MANDIBLE_BASE}/api/auth/queue"
if [[ -n "$type_filter" ]]; then
  url="${url}?type=${type_filter}"
fi

response=$(curl -fsS --max-time 5 "$url" 2>/dev/null) || {
  print -u2 "Error: could not reach Mandible daemon at ${MANDIBLE_BASE}."
  exit 1
}

jq_filter='.requests'
jq_args=()
if [[ -n "$repo_filter" ]]; then
  jq_filter="${jq_filter} | map(select(.repo == \$repo))"
  jq_args+=(--arg repo "$repo_filter")
fi
if [[ -n "$head_filter" ]]; then
  jq_filter="${jq_filter} | map(select(.head_branch == \$head))"
  jq_args+=(--arg head "$head_filter")
fi
if [[ -n "$base_filter" ]]; then
  jq_filter="${jq_filter} | map(select(.base_branch == \$base))"
  jq_args+=(--arg base "$base_filter")
fi
if [[ -n "$status_filter" ]]; then
  jq_filter="${jq_filter} | map(select(.status == \$status))"
  jq_args+=(--arg status "$status_filter")
fi

filtered=$(printf '%s' "$response" | jq "${jq_args[@]}" "{ requests: (${jq_filter}) }") || {
  print -u2 "Error: auth queue response was not valid JSON."
  exit 1
}

if [[ "$json" == "1" ]]; then
  printf '%s\n' "$filtered"
  exit 0
fi

count=$(printf '%s' "$filtered" | jq '.requests | length')
if [[ "$count" == "0" ]]; then
  print "Auth queue: no active requests"
  exit 0
fi

print "Auth queue: ${count} active request(s)"
printf '%s' "$filtered" | jq -r '
  .requests[]
  | "[\(.id[0:8])] \(.status) \(.repo // "-") \(.head_branch // "-") -> \(.base_branch // "-") - \(.title // "(untitled)")"
'
