#!/usr/bin/env zsh
# mandible artifact: custody-aware artifact CLI over the Mandible daemon API.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)/command-syntax.sh"

set -euo pipefail

GIT_ENV_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/git-env.sh"
source "$GIT_ENV_HELPER"

RESET=$'\033[0m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'

API_HELPER="${MANDIBLE_CLI_DIR:-$(cd "$(dirname "$0")" && pwd)}/api.sh"
source "$API_HELPER"

err() {
  printf "%b\n" "$*" >&2
}

die() {
  err "$1"
  exit "${2:-1}"
}

# Map a non-2xx artifact byte-transport response to an explicit, actionable
# error code instead of leaking a raw transport failure (issue 833e972).
explain_transport_failure() {
  local body_file="$1" fallback="${2:-api_ingest_failed}" detail=""
  [[ -f "$body_file" ]] && detail="$(jq -r '.error // .detail // .message // empty' "$body_file" 2>/dev/null || true)"
  case "$detail" in
    *content_base64*content_path*|*"content_path, or json is required"*|*"content_base64, json, sha256"*)
      printf 'daemon_missing_path_ingest_support: this Mandible daemon does not accept path-based artifact bytes (content_path); upgrade the daemon' ;;
    *file_rpc_attachment*)
      printf 'file_rpc_attachment_rejected: the daemon could not resolve the spool attachment for large bytes; upgrade the daemon' ;;
    file_rpc_timeout)
      printf 'file_rpc_timeout: no daemon response (raise MANDIBLE_FILE_RPC_TIMEOUT or check the daemon)' ;;
    "") printf '%s' "$fallback" ;;
    *) printf '%s: %s' "$fallback" "$detail" ;;
  esac
}

# Run an artifact API request without discarding its non-2xx response body.
# api_request intentionally exposes only successful bodies, so artifact
# mutations that need actionable resolver/validation diagnostics use capture.
artifact_api_request() {
  local method="$1" request_path="$2" data="${3:-}"
  local response_file response_status detail body
  response_file="$(mktemp)"
  response_status="$(api_capture "$method" "$request_path" "$data" "$response_file")"
  if [[ "$response_status" =~ ^2 ]]; then
    cat "$response_file"
    rm -f "$response_file"
    return 0
  fi

  detail="$(jq -r '.error // .detail // .message // empty' "$response_file" 2>/dev/null || true)"
  if [[ -n "$detail" ]]; then
    printf 'Mandible artifact request failed (HTTP %s): %s\n' "$response_status" "$detail" >&2
  elif [[ -s "$response_file" ]]; then
    body="$(cat "$response_file")"
    printf 'Mandible artifact request failed (HTTP %s): %s\n' "$response_status" "$body" >&2
  else
    printf 'Mandible artifact request failed (HTTP %s).\n' "$response_status" >&2
  fi
  rm -f "$response_file"
  return 22
}

usage() {
  mandible_command_help artifact
}

require_tools() {
  api_is_file_rpc || command -v curl >/dev/null 2>&1 || die "curl not found." 1
  command -v jq >/dev/null 2>&1 || die "jq not found." 1
}

api_post() {
  local endpoint="$1"
  local payload="$2"
  api_send POST "$endpoint" "$payload"
}

json_quote() {
  jq -Rn --arg value "$1" '$value'
}

python_path() {
  python3 - "$@" <<'PY'
import os
import sys

cmd = sys.argv[1]
if cmd == "abs":
    print(os.path.abspath(os.path.expanduser(sys.argv[2])))
elif cmd == "real":
    print(os.path.realpath(os.path.expanduser(sys.argv[2])))
elif cmd == "rel":
    print(os.path.relpath(sys.argv[2], sys.argv[3]).replace(os.sep, "/"))
PY
}

# Classify how a user-supplied path relates to its realpath so the CLI stores a
# durable (non-disposable) file:// URI and records why (issue 2f9c3c3). This
# mirrors the backend classifyLocalSymlink() so CLI dry-run plans match what
# POST /api/artifacts/plan and registerLocalArtifactPath would store. Prints a
# JSON LocalPathDecision (minus stored_uri, which the caller fills in).
#   artifact_symlink_plan LEXICAL_ABS RESOLVED_REAL REAL_REPO_ROOT
artifact_symlink_plan() {
  python3 - "$1" "$2" "$3" <<'PY'
import os
import subprocess
import sys
import json

lexical = sys.argv[1]
real = sys.argv[2]
real_root = sys.argv[3] or ""


def git(directory, args):
    try:
        proc = subprocess.run(
            ["git", "-C", directory, *args],
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.strip()
    return out or None


def toplevel(directory):
    out = git(directory, ["rev-parse", "--show-toplevel"])
    return os.path.abspath(out) if out else None


def common_dir(directory):
    out = git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    return os.path.abspath(out) if out else None


def lexical_worktree_dir(lex):
    # First ancestor that is not itself a symlink: walking up past the leaf
    # `_artifacts`-style directory symlink lands on the worktree the user wrote
    # through (git still reports it as a linked worktree even when nested under
    # the main repo), while stopping at the first real directory ignores benign
    # prefix symlinks such as macOS /tmp -> /private/tmp.
    directory = os.path.dirname(os.path.abspath(lex))
    for _ in range(64):
        try:
            if not os.path.islink(directory):
                return directory
        except OSError:
            return directory
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent
    return None


symlink_resolved = lexical != real
inside_worktree = bool(real_root)
decision = {
    "input_path": lexical,
    "resolved_path": real,
    "symlink_resolved": symlink_resolved,
}

if not symlink_resolved:
    decision.update(
        symlink_class="none",
        worktree_substitution=False,
        decision_warnings=[],
        reason="input path is already a realpath; stored as-is",
    )
elif not inside_worktree:
    decision.update(
        symlink_class="outside_repo",
        worktree_substitution=False,
        decision_warnings=["outside_repo_symlink"],
        reason="input traverses a symlink whose target is outside any git repo; "
        "link custody is non-durable, use --managed",
    )
else:
    root_abs = os.path.abspath(real_root)
    real_common = common_dir(os.path.dirname(real))
    lex_dir = lexical_worktree_dir(lexical)
    lex_root = toplevel(lex_dir) if lex_dir else None
    lex_common = common_dir(lex_dir) if lex_dir else None
    if lex_common and real_common and lex_common != real_common:
        decision.update(
            symlink_class="cross_repo",
            worktree_substitution=True,
            decision_warnings=["cross_repo_symlink"],
            reason="input traverses a symlink crossing into a different git "
            "repository; stored the cross-repo realpath",
        )
    elif lex_root and root_abs and lex_root != root_abs:
        decision.update(
            symlink_class="same_repo_durable",
            worktree_substitution=True,
            decision_warnings=["symlink_resolved_to_durable_target"],
            reason="input traverses a same-repo worktree symlink; stored the "
            "persistent realpath so it survives feature-worktree deletion",
        )
    else:
        decision.update(
            symlink_class="prefix_only",
            worktree_substitution=False,
            decision_warnings=[],
            reason="input differs from its realpath only by a path-prefix "
            "symlink; stored the realpath",
        )

print(json.dumps(decision))
PY
}

stable_hash() {
  shasum -a 256 "$1" | awk '{print $1}'
}

media_type_for() {
  local file_path="$1"
  if command -v file >/dev/null 2>&1; then
    file -b --mime-type "$file_path" 2>/dev/null || printf 'application/octet-stream'
  else
    printf 'application/octet-stream'
  fi
}

infer_role() {
  local file_path="$1"
  local lower
  lower="$(printf '%s' "$file_path" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *manifest*) printf 'manifest' ;;
    *config*) printf 'config' ;;
    *report*) printf 'report' ;;
    *result*|*metric*|*eval*) printf 'result' ;;
    *.md|*.txt|*.pdf|*.json|*.jsonl|*.csv|*.tsv|*.yaml|*.yml) printf 'document' ;;
    *) printf 'artifact' ;;
  esac
}

repo_id_for_root() {
  local repo_root="$1"
  local common_dir parent
  common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common_dir" && "$(basename "$common_dir")" == ".git" ]]; then
    parent="$(dirname "$common_dir")"
    basename "$parent"
    return
  fi
  basename "$repo_root"
}

is_uri_like() {
  [[ "$1" =~ '^[A-Za-z][A-Za-z0-9+.-]*:' ]]
}

issue_json=""
issue_id=""
issue_repo=""

resolve_issue() {
  local ref="$1"
  [[ -n "$ref" ]] || return 0
  local tmp_response http_status detail
  tmp_response="$(mktemp)"
  http_status="$(api_capture GET "/api/ledger/issues/$(urlencode "$ref")" "" "$tmp_response")"
  if [[ ! "$http_status" =~ ^2 ]]; then
    detail="$(jq -r '.error // .detail // .message // empty' "$tmp_response" 2>/dev/null || true)"
    rm -f "$tmp_response"
    if [[ -n "$detail" ]]; then
      die "${RED}Unable to resolve issue '${ref}' (HTTP ${http_status}: ${detail}).${RESET}" 1
    fi
    die "${RED}Unable to resolve issue '${ref}' (HTTP ${http_status}). Use a longer or project-scoped issue ref if it is ambiguous.${RESET}" 1
  fi
  issue_json="$(cat "$tmp_response")"
  rm -f "$tmp_response"
  issue_id="$(printf '%s' "$issue_json" | jq -r '.id')"
  issue_repo="$(printf '%s' "$issue_json" | jq -r '.project.repo_id // .project.repo_name // empty')"
}

issue_link_json() {
  local relation="${1:-references}"
  local role="${2:-}"
  if [[ -z "$issue_id" ]]; then
    printf '[]'
    return
  fi
  jq -n \
    --arg entity_id "$issue_id" \
    --arg link_type "$relation" \
    --arg role "$role" \
    --arg repo_id "$issue_repo" \
    '[{
      entity_type:"issue",
      entity_id:$entity_id,
      link_type:$link_type,
      role:(if $role == "" then null else $role end),
      repo_id:(if $repo_id == "" then null else $repo_id end),
      source:"artifact_cli"
    }]'
}

classify_path() {
  local input="$1"
  local role_override="${2:-}"
  local abs real dir root rel repo_id branch commit git_status tracked ignored index_status worktree_status staged dirty untracked
  local sha size media filename role warnings repo_locator uri canonical_ref recoverability availability git_json
  local symlink_json decision_codes path_decision

  abs="$(python_path abs "$input")"
  if [[ ! -e "$abs" ]]; then
    jq -n --arg input "$input" '{input:$input, ok:false, error:"path_missing", warnings:[{code:"path_missing", message:"path does not exist"}]}'
    return
  fi
  if [[ -d "$abs" ]]; then
    jq -n --arg input "$input" '{input:$input, ok:false, error:"path_is_directory", warnings:[{code:"path_is_directory", message:"directories must be bundled through an explicit manifest"}]}'
    return
  fi

  # Classify against the realpath (symlinks resolved) so a feature worktree's
  # disposable `_artifacts` symlink resolves to its persistent repo-root target
  # and the stored file:// URI survives worktree deletion (issue 2f9c3c3).
  real="$(python_path real "$input")"
  dir="$(dirname "$real")"
  root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
  sha="$(stable_hash "$real")"
  size="$(wc -c < "$real" | tr -d ' ')"
  media="$(media_type_for "$real")"
  filename="$(basename "$real")"
  role="${role_override:-$(infer_role "$input")}"
  availability="present"
  warnings='[]'

  if [[ -n "$root" ]]; then
    rel="$(python_path rel "$real" "$root")"
    repo_id="$(repo_id_for_root "$root")"
    branch="$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null || git -C "$root" rev-parse --short HEAD 2>/dev/null || true)"
    commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || true)"
    git_status="$(git -C "$root" status --porcelain=v1 -- "$rel" 2>/dev/null | head -n 1 || true)"
    if git -C "$root" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then tracked=true; else tracked=false; fi
    if git -C "$root" check-ignore -q -- "$rel" >/dev/null 2>&1; then ignored=true; else ignored=false; fi
    index_status="$(printf '%s' "$git_status" | cut -c1)"
    worktree_status="$(printf '%s' "$git_status" | cut -c2)"
    [[ "$index_status" != " " && "$index_status" != "?" && -n "$index_status" ]] && staged=true || staged=false
    [[ "$worktree_status" != " " && -n "$worktree_status" ]] && dirty=true || dirty=false
    [[ "$git_status" == \?\?* ]] && untracked=true || untracked=false

    if [[ "$tracked" == true && "$staged" == false && "$dirty" == false ]]; then
      recoverability="repo_commit"
      uri="repo://${repo_id}@${commit}/${rel}"
      repo_locator="$(jq -n --arg repo_id "$repo_id" --arg ref "$commit" --arg path "$rel" \
        '{repo_id:$repo_id, ref:$ref, path:$path}')"
    elif [[ "$tracked" == true ]]; then
      recoverability="repo_worktree"
      uri="repo://${repo_id}@${branch}/${rel}"
      repo_locator="$(jq -n --arg repo_id "$repo_id" --arg ref "$branch" --arg path "$rel" \
        '{repo_id:$repo_id, ref:$ref, path:$path}')"
      [[ "$dirty" == true ]] && warnings="$(printf '%s' "$warnings" | jq '. + [{code:"tracked_dirty", message:"tracked file has worktree changes"}]')"
      [[ "$staged" == true ]] && warnings="$(printf '%s' "$warnings" | jq '. + [{code:"tracked_staged", message:"tracked file has staged changes"}]')"
      warnings="$(printf '%s' "$warnings" | jq '. + [{code:"mutable_ref", message:"repo locator uses a mutable worktree ref"}]')"
    else
      recoverability="local_only"
      # Durable realpath, not the possibly-disposable input path.
      uri="file://${real}"
      canonical_ref="artifact-blob:${sha}"
      repo_locator="$(jq -n --arg repo_id "$repo_id" --arg ref "$branch" --arg path "$rel" \
        '{repo_id:$repo_id, ref:$ref, path:$path, local_only:true}')"
      if [[ "$ignored" == true ]]; then
        warnings="$(printf '%s' "$warnings" | jq '. + [{code:"ignored_local_only", message:"ignored file is local-only unless copied or managed"}]')"
      else
        warnings="$(printf '%s' "$warnings" | jq '. + [{code:"untracked_local_only", message:"untracked file is local-only unless copied or managed"}]')"
      fi
      warnings="$(printf '%s' "$warnings" | jq '. + [{code:"mutable_ref", message:"repo locator uses a mutable worktree ref"}]')"
    fi
    git_json="$(jq -n \
      --arg repo_id "$repo_id" --arg relative_path "$rel" --arg branch "$branch" --arg commit "$commit" --arg status "$git_status" \
      --argjson tracked "$tracked" --argjson ignored "$ignored" --argjson staged "$staged" --argjson dirty "$dirty" --argjson untracked "$untracked" \
      '{repo_id:$repo_id, relative_path:$relative_path, branch:$branch, commit:$commit, status:$status, tracked:$tracked, ignored:$ignored, staged:$staged, dirty:$dirty, untracked:$untracked}')"
  else
    rel="$filename"
    repo_id=""
    uri="file://${real}"
    canonical_ref="artifact-blob:${sha}"
    repo_locator='{}'
    recoverability="local_only"
    warnings="$(jq -n '[{code:"outside_repo", message:"outside-repo paths require --managed for durable registration"}]')"
    git_json="$(jq -n '{repo_id:null, relative_path:null, tracked:false, ignored:false, staged:false, dirty:false, untracked:false}')"
  fi

  # Record the symlink decision (input path, realpath, stored URI, why) so the
  # stored artifact explains durable-path selection, and surface any symlink
  # warning codes alongside the recoverability warnings.
  symlink_json="$(artifact_symlink_plan "$abs" "$real" "$root")"
  decision_codes="$(printf '%s' "$symlink_json" | jq -c '.decision_warnings')"
  warnings="$(printf '%s' "$warnings" | jq --argjson codes "$decision_codes" \
    '. + ($codes | map({code:., message:"symlink path decision"}))')"
  path_decision="$(printf '%s' "$symlink_json" | jq --arg uri "$uri" '. + {stored_uri:$uri}')"

  jq -n \
    --arg input "$input" \
    --arg filename "$filename" \
    --arg sha256 "$sha" \
    --arg media_type "$media" \
    --arg role "$role" \
    --arg uri "$uri" \
    --arg recoverability "$recoverability" \
    --arg availability "$availability" \
    --argjson size_bytes "$size" \
    --argjson warnings "$warnings" \
    --argjson repo_locator "$repo_locator" \
    --argjson git "$git_json" \
    --argjson path_decision "$path_decision" \
    '{
      input:$input,
      ok:true,
      filename:$filename,
      logical_name:$filename,
      sha256:$sha256,
      media_type:$media_type,
      role:$role,
      size_bytes:$size_bytes,
      uri:$uri,
      input_path:$path_decision.input_path,
      canonical_ref:(if $recoverability == "local_only" then "artifact-blob:" + $sha256 else $uri end),
      recoverability:$recoverability,
      availability:$availability,
      custody_mode:"git",
      repo_locator:$repo_locator,
      git:$git,
      path_decision:$path_decision,
      warnings:$warnings
    }'
}

payload_for_path() {
  local input="$1" mode="$2" role_override="$3" allow_local="$4" allow_dirty="$5" relation="$6"
  local classified ok recoverability tracked dirty staged untracked ignored repo_id uri links
  classified="$(classify_path "$input" "$role_override")"
  ok="$(printf '%s' "$classified" | jq -r '.ok')"
  if [[ "$ok" != "true" ]]; then
    printf '%s' "$classified" | jq '{input, status:"failed", error, warnings}'
    return 1
  fi

  recoverability="$(printf '%s' "$classified" | jq -r '.recoverability')"
  tracked="$(printf '%s' "$classified" | jq -r '.git.tracked')"
  dirty="$(printf '%s' "$classified" | jq -r '.git.dirty')"
  staged="$(printf '%s' "$classified" | jq -r '.git.staged')"
  untracked="$(printf '%s' "$classified" | jq -r '.git.untracked')"
  ignored="$(printf '%s' "$classified" | jq -r '.git.ignored')"
  repo_id="$(printf '%s' "$classified" | jq -r '.git.repo_id // empty')"

  if [[ "$mode" == "git" && -z "$repo_id" ]]; then
    printf '%s' "$classified" | jq '{input, status:"failed", error:"outside_repo_requires_copy_or_managed", warnings}'
    return 1
  fi
  if [[ "$mode" == "git" && -n "$issue_id" && "$tracked" == "true" && ( "$dirty" == "true" || "$staged" == "true" ) && "$allow_dirty" != "1" ]]; then
    printf '%s' "$classified" | jq '{input, status:"failed", error:"dirty_link_requires_override", warnings}'
    return 1
  fi
  if [[ "$mode" == "git" && -n "$issue_id" && ( "$untracked" == "true" || "$ignored" == "true" ) && "$allow_local" != "1" ]]; then
    printf '%s' "$classified" | jq '{input, status:"failed", error:"local_only_issue_link_requires_override", warnings}'
    return 1
  fi

  links="$(issue_link_json "$relation" "$(printf '%s' "$classified" | jq -r '.role')")"
  if [[ "$mode" == "managed" ]]; then
    # Bytes are NOT embedded here. They are delivered to the daemon out-of-band:
    # a daemon-visible content_path over local HTTP, or a spool attachment over
    # file-RPC (issue 833e972). This keeps large files off argv/JSON entirely.
    classified="$(printf '%s' "$classified" | jq \
      --arg custody "$mode" \
      '.custody_mode=$custody | .recoverability="mandible_cas" | .canonical_ref=("artifact-blob:" + .sha256) | .warnings=(.warnings + [{code:"snapshot_custody", message:"bytes will be stored in Mandible artifact storage"}])')"
    printf '%s' "$classified" | jq \
      --argjson links "$links" \
      '{
        canonical_ref:.canonical_ref,
        sha256,
        filename,
        logical_name,
        media_type,
        role,
        size_bytes,
        custody_mode,
        availability,
        home_repo_id:(.git.repo_id // null),
        repo_locator,
        reference:{owner_system:"artifact_cli", recoverability:.recoverability, git:.git, source_uri:.uri, preferred_ref:.canonical_ref, path_decision:.path_decision},
        metadata:{filename, logical_name, recoverability:.recoverability, git:.git, warnings:.warnings, source:"artifact_cli", preferred_ref:.canonical_ref, source_path:.path_decision.resolved_path, input_path:.path_decision.input_path, path_decision:.path_decision},
        links:$links
      }'
    return 0
  fi

  uri="$(printf '%s' "$classified" | jq -r '.uri')"
  printf '%s' "$classified" | jq \
    --argjson links "$links" \
    '{
      canonical_ref:.canonical_ref,
      sha256,
      uri,
      filename,
      logical_name,
      media_type,
      role,
      size_bytes,
      custody_mode:"git",
      availability,
      home_repo_id:(.git.repo_id // null),
      repo_locator,
      reference:{owner_system:"repo", recoverability:.recoverability, git:.git, preferred_ref:.canonical_ref, content_identity:{algorithm:"sha256", hash:.sha256}, path_decision:.path_decision},
      metadata:{filename, logical_name, recoverability:.recoverability, git:.git, warnings:.warnings, source:"artifact_cli", preferred_ref:.canonical_ref, source_path:.path_decision.resolved_path, input_path:.path_decision.input_path, path_decision:.path_decision},
      links:$links
    }'
}

print_batch_human() {
  api_jq_human '
    (.registered[]? |
      if .artifact_version then "\(.status // (if .created == false then "unchanged" elif .artifact_version.version_no == 1 then "created" else "updated" end)) \(.artifact | mandible_display_ref) \(.artifact_version | mandible_display_ref)"
      elif .blob_only then "registered blob \(.artifact | mandible_display_ref)"
      else "registered \(.artifact | mandible_display_ref) \(.artifact.custody_mode) \(.artifact.metadata.recoverability // .artifact.reference.recoverability // "-")" end),
    (.linked[]? | "linked \(.artifact | mandible_display_ref) \(.link.link_type) issue:\(.link.entity_id | mandible_short_id)"),
    (.failed[]? | "failed \(.input // .ref // "-") \(.error)")
  '
}

artifact_version_payload_for_path() {
  local payload="$1" path_arg="$2" issue_id_value="$3"
  local abs source_kind
  abs="$(python_path abs "$path_arg")"
  source_kind="$(printf '%s' "$payload" | jq -r 'if .metadata.git.tracked == true and (.metadata.git.repo_id // "") != "" then "tracked_repo" else "local_only" end')"
  printf '%s' "$payload" | jq \
    --arg source_kind "$source_kind" \
    --arg path "$abs" \
    --arg issue "$issue_id_value" \
    '{source_kind:$source_kind, path:$path,
      logical_name, role, media_type, custody_mode,
      title:(.metadata.title // null)}
      + (if $issue != "" then {issue:$issue} else {} end)'
}

artifact_version_payload_for_upload() {
  local payload="$1" issue_id_value="$2" project="$3"
  printf '%s' "$payload" | jq \
    --arg issue "$issue_id_value" \
    --arg project "$project" \
    '{source_kind:"managed",
      source:(if .metadata.git.tracked == true and (.metadata.git.repo_id // "") != "" and (.metadata.git.relative_path // "") != ""
        then {kind:"repo", project_id:.metadata.git.repo_id, path:.metadata.git.relative_path}
        else {kind:"local", path:.metadata.source_path} end),
      logical_name, role, media_type, custody_mode,
      title:(.metadata.title // null)}
      + (if $issue != "" then {issue:$issue} else {} end)
      + (if $project != "" then {project:$project} else {} end)'
}

cmd_ingest_like() {
  local mode="$1"
  shift
  local project="" commit="" artifact_target="" issue="" role="" json=0 dry_run=0 allow_local=0 allow_dirty=0 upload=0 mode_explicit=0 blob_only=0 relation="references"
  local paths=()
  local binding
  binding=$(mandible_bind_arguments "artifact.ingest" '{"project":{"option":"project"},"commit":{"option":"commit"},"artifact_target":{"option":"artifact"},"issue":{"option":"issue"},"role":{"option":"role"},"mode":[{"option":"managed","constant":"managed"},{"option":"git","constant":"git"}],"mode_explicit":{"option":["managed","git"],"constant":"1"},"upload":{"option":"upload","constant":"1"},"blob_only":{"option":"blob-only","constant":"1"},"dry_run":{"option":"dry-run","constant":"1"},"json":{"option":"json","constant":"1"},"paths":{"rest":0}}' "$@") || return $?
  eval "$binding"
  (( ${#paths[@]} > 0 )) || die "No paths supplied." 2
  if [[ -n "$artifact_target" ]] && (( ${#paths[@]} != 1 || blob_only )); then
    die "--artifact requires exactly one path and cannot be combined with --blob-only" 2
  fi
  require_tools
  if (( upload )) || api_is_file_rpc; then
    if [[ "$mode" == "git" ]]; then
      if (( mode_explicit )); then
        die "${RED}git custody requires daemon-visible host paths; use --managed for upload mode.${RESET}" 2
      fi
      mode="managed"
    fi
  fi
  if [[ -n "$commit" ]] && { (( upload || blob_only )) || api_is_file_rpc; }; then
    die "--commit ingestion requires daemon-visible repository paths over HTTP" 2
  fi
  [[ -z "$project" ]] || (( ! blob_only )) || die "--blob-only stores bytes without a logical artifact, so it takes no --project" 2
  if (( ! upload && ! blob_only )) && ! api_is_file_rpc; then
    local batch_payload batch_result
    batch_payload="$(python3 - "$PWD" "$commit" "$project" "$artifact_target" "$mode" "$role" "$issue" "$dry_run" "$allow_local" "$allow_dirty" "${paths[@]}" <<'PYBATCH'
import json, os, sys
cwd, commit, project, artifact, mode, role, issue, dry_run, allow_local, allow_dirty, *paths = sys.argv[1:]
body = dict(paths=paths if commit else [os.path.abspath(os.path.expanduser(p)) for p in paths], cwd=cwd,
            dry_run=dry_run == '1')
if mode: body['custody_mode'] = mode
body.update({k: v for k, v in dict(commit=commit, project=project, artifact_id=artifact, role=role, issue=issue).items() if v})
print(json.dumps(body))
PYBATCH
)"
    batch_result="$(artifact_api_request POST "/api/artifacts/ingest" "$batch_payload")" || return $?
    if (( json )); then printf '%s\n' "$batch_result" | jq .
    elif (( dry_run )); then printf '%s\n' "$batch_result" | jq '.plans'
    else printf '%s\n' "$batch_result" | print_batch_human
    fi
    return 0
  fi
  [[ -n "$issue" ]] && resolve_issue "$issue"
  [[ -n "$mode" ]] || mode="managed"

  local registered='[]' failed='[]' planned='[]' payload response result version_payload version_response
  local abs resp_tmp resp_status err availability
  local needs_bytes=0
  [[ "$mode" == "managed" ]] && needs_bytes=1
  for path_arg in "${paths[@]}"; do
    if payload="$(payload_for_path "$path_arg" "$mode" "$role" "$allow_local" "$allow_dirty" "$relation")"; then
      planned="$(printf '%s' "$planned" | jq --argjson payload "$payload" '. + [$payload]')"
      if (( dry_run )); then
        # No bytes are generated in dry-run; annotate how bytes would travel so
        # --json stays informative without ever building base64 (issue 833e972).
        registered="$(printf '%s' "$registered" | jq --argjson payload "$payload" --argjson needs_bytes "$needs_bytes" --argjson blob_only "$blob_only" \
          '. + [{input:($payload.metadata.git.relative_path // $payload.filename),
                 identity_mode:(if $blob_only == 1 then "blob_only" else "artifact_version" end),
                 planned_payload:(if $needs_bytes == 1
                   then ($payload + {content_transport:"daemon-visible path or file-RPC attachment (bytes omitted in dry-run)"})
                   else $payload end)}]')"
      elif (( ! blob_only )); then
        abs="$(python_path abs "$path_arg")"
        if (( upload )) || api_is_file_rpc; then
          version_payload="$(artifact_version_payload_for_upload "$payload" "${issue_id:-}" "$project")"
          version_payload="$(printf '%s' "$version_payload" | jq --arg id "$artifact_target" 'if $id == "" then . else . + {artifact_id:$id} end')"
          resp_tmp="$(mktemp)"
          resp_status="$(api_send_content POST "/api/artifacts/versions" "$version_payload" "path" "$abs" "$resp_tmp")"
          if [[ ! "$resp_status" =~ ^2 ]]; then
            err="$(explain_transport_failure "$resp_tmp" "api_version_record_failed")"
            failed="$(printf '%s' "$failed" | jq --arg input "$path_arg" --arg error "$err" '. + [{input:$input, error:$error}]')"
            rm -f "$resp_tmp"
            continue
          fi
          version_response="$(cat "$resp_tmp")"
          rm -f "$resp_tmp"
        else
          version_payload="$(artifact_version_payload_for_path "$payload" "$path_arg" "${issue_id:-}")"
          version_payload="$(printf '%s' "$version_payload" | jq --arg id "$artifact_target" 'if $id == "" then . else . + {artifact_id:$id} end')"
          version_response="$(artifact_api_request POST "/api/artifacts/versions" "$version_payload")" || {
            failed="$(printf '%s' "$failed" | jq --arg input "$path_arg" '. + [{input:$input, error:"api_version_record_failed"}]')"
            continue
          }
        fi
        registered="$(printf '%s' "$registered" | jq --argjson result "$(printf '%s' "$version_response" | jq '.result')" '. + [$result]')"
      elif (( needs_bytes )); then
        abs="$(python_path abs "$path_arg")"
        resp_tmp="$(mktemp)"
        resp_status="$(api_send_content POST "/api/artifacts/ingest" "$payload" "content_path" "$abs" "$resp_tmp")"
        if [[ "$resp_status" =~ ^2 ]]; then
          availability="$(jq -r '.artifact.availability // empty' "$resp_tmp" 2>/dev/null || true)"
          if [[ "$availability" != "present" ]]; then
            failed="$(printf '%s' "$failed" | jq --arg input "$path_arg" \
              '. + [{input:$input, error:"daemon_did_not_store_bytes: snapshot/copy bytes were not stored (daemon may predate path-based ingest); upgrade the daemon"}]')"
            rm -f "$resp_tmp"
            continue
          fi
          registered="$(printf '%s' "$registered" | jq --argjson artifact "$(jq '.artifact' "$resp_tmp")" '. + [{artifact:$artifact, blob_only:true}]')"
        else
          err="$(explain_transport_failure "$resp_tmp" "api_ingest_failed")"
          failed="$(printf '%s' "$failed" | jq --arg input "$path_arg" --arg error "$err" '. + [{input:$input, error:$error}]')"
          rm -f "$resp_tmp"
          continue
        fi
        rm -f "$resp_tmp"
      else
        response="$(api_post "/api/artifacts/ingest" "$payload")" || {
          failed="$(printf '%s' "$failed" | jq --arg input "$path_arg" '. + [{input:$input, error:"api_ingest_failed"}]')"
          continue
        }
        registered="$(printf '%s' "$registered" | jq --argjson artifact "$(printf '%s' "$response" | jq '.artifact')" '. + [{artifact:$artifact, blob_only:true}]')"
      fi
    else
      failed="$(printf '%s' "$failed" | jq --argjson item "$payload" '. + [$item]')"
    fi
  done
  result="$(jq -n --arg command "ingest" --arg custody "$mode" --argjson dry_run "$dry_run" --argjson registered "$registered" --argjson failed "$failed" \
    '{command:$command, dry_run:$dry_run, custody_mode:$custody, registered:$registered, failed:$failed}')"
  if (( json )); then
    printf '%s\n' "$result" | jq .
  else
    printf '%s\n' "$result" | print_batch_human
  fi
  [[ "$(printf '%s' "$failed" | jq 'length')" == "0" ]]
}

cmd_ref() {
  local issue="" role="" json=0
  local refs=()
  local binding
  binding=$(mandible_bind_arguments "artifact.ref" '{"issue":{"option":"issue"},"role":{"option":"role"},"json":{"option":"json","constant":"1"},"refs":{"rest":0}}' "$@") || return $?
  eval "$binding"
  (( ${#refs[@]} > 0 )) || die "No refs supplied." 2
  require_tools
  [[ -n "$issue" ]] && resolve_issue "$issue"

  local registered='[]' failed='[]' ref response artifact link_payload link_response result
  for ref in "${refs[@]}"; do
    if [[ -e "$ref" ]]; then
      if response="$(payload_for_path "$ref" "git" "$role" 1 1 "references")"; then
        response="$(api_post "/api/artifacts/ingest" "$response")" || {
          failed="$(printf '%s' "$failed" | jq --arg ref "$ref" '. + [{ref:$ref, error:"api_ingest_failed"}]')"
          continue
        }
        registered="$(printf '%s' "$registered" | jq --argjson artifact "$(printf '%s' "$response" | jq '.artifact')" '. + [{artifact:$artifact}]')"
      else
        failed="$(printf '%s' "$failed" | jq --argjson item "$response" '. + [$item]')"
      fi
      continue
    fi
    response="$(api_get "/api/artifacts/resolve?ref=$(urlencode "$ref")")" || {
      failed="$(printf '%s' "$failed" | jq --arg ref "$ref" '. + [{ref:$ref, error:"api_resolve_failed"}]')"
      continue
    }
    artifact="$(printf '%s' "$response" | jq '.resolution.artifact')"
    if [[ -n "$issue_id" ]]; then
      link_payload="$(jq -n --arg ref "$ref" --arg entity_id "$issue_id" --arg repo_id "$issue_repo" --arg role "$role" \
        '{ref:$ref, entity_type:"issue", entity_id:$entity_id, link_type:"references", role:(if $role == "" then null else $role end), repo_id:(if $repo_id == "" then null else $repo_id end), source:"artifact_cli"}')"
      link_response="$(api_post "/api/artifacts/link" "$link_payload")" || {
        failed="$(printf '%s' "$failed" | jq --arg ref "$ref" '. + [{ref:$ref, error:"api_link_failed"}]')"
        continue
      }
      registered="$(printf '%s' "$registered" | jq --argjson artifact "$artifact" --argjson link "$(printf '%s' "$link_response" | jq '.link')" '. + [{artifact:$artifact, link:$link}]')"
    else
      registered="$(printf '%s' "$registered" | jq --argjson artifact "$artifact" '. + [{artifact:$artifact}]')"
    fi
  done
  result="$(jq -n --arg command "ref" --argjson registered "$registered" --argjson failed "$failed" '{command:$command, registered:$registered, failed:$failed}')"
  if (( json )); then printf '%s\n' "$result" | jq .; else printf '%s\n' "$result" | print_batch_human; fi
  [[ "$(printf '%s' "$failed" | jq 'length')" == "0" ]]
}

cmd_link() {
  local ref="" issue="" role="" relation="references" link_kind="" json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.link" '{"issue":{"option":"issue"},"role":{"option":"role"},"relation":{"option":"relation"},"link_kind":[{"option":"pinned","constant":"pinned"},{"option":"living","constant":"living"}],"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" && -n "$issue" ]] || die "Usage: $(mandible_command_syntax artifact.link)" 2
  case "$relation" in references|output|evidence|handoff) ;; *) die "Unknown relation: $relation" 2 ;; esac
  require_tools
  resolve_issue "$issue"
  local payload response tmp_response http_status detail
  payload="$(jq -n \
    --arg ref "$ref" \
    --arg entity_id "$issue_id" \
    --arg repo_id "$issue_repo" \
    --arg link_type "$relation" \
    --arg role "$role" \
    --arg link_kind "$link_kind" \
    '{ref:$ref, entity_type:"issue", entity_id:$entity_id, link_type:$link_type, role:(if $role == "" then null else $role end), repo_id:(if $repo_id == "" then null else $repo_id end), source:"artifact_cli"}
     + (if $link_kind == "" then {} else {link_kind:$link_kind} end)')"
  tmp_response="$(mktemp)"
  http_status="$(api_capture POST "/api/artifacts/link" "$payload" "$tmp_response")"
  if [[ ! "$http_status" =~ ^2 ]]; then
    detail="$(jq -r '.error // .detail // .message // empty' "$tmp_response" 2>/dev/null || true)"
    rm -f "$tmp_response"
    [[ -n "$detail" ]] || detail="api_link_failed"
    die "${RED}Failed to link artifact ref: ${detail}.${RESET}" 1
  fi
  response="$(cat "$tmp_response")"
  rm -f "$tmp_response"
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      .link as $l
      | .resolution as $r
      | ($l.link_kind // "pinned") as $kind
      | ($l.resolved_version_no // $r.resolved_version_no // $r.artifact_version.version_no // null) as $version
      | (if $version == null then "" else " v\($version)" end) as $version_suffix
      | (if $kind == "living" then "[living · latest\($version_suffix)]" else "[pinned\($version_suffix)]" end) as $badge
      | "linked \(($r.logical_artifact // $r.artifact_version // $r.artifact_blob) | mandible_display_ref) \($l.link_type) issue:\($l.entity_id | mandible_short_id) \($badge)"'
  fi
}

cmd_resolve() {
  local ref="" json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.resolve" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax artifact.resolve)" 2
  require_tools
  local response
  response="$(api_get "/api/artifacts/resolve?ref=$(urlencode "$ref")")" || die "${RED}Failed to resolve artifact ref.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      .resolution
      | "\(.status) \(.target_type // "legacy_artifact") \((.target_id // .artifact.ref // .artifact.id // "-") | mandible_typed_short_ref) \((.normalized_ref // "-") | mandible_typed_short_ref)",
        ( (.warnings // [])[] | "warning: \(.)" )'
  fi
}

cmd_format() {
  local ref="" format="id" label="" json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.format" '{"format":{"option":"as"},"label":{"option":"label"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax artifact.format)" 2
  case "$format" in id|ref|url|markdown|full) ;; *) die "Unknown --as format: $format" 2 ;; esac
  require_tools
  local response identity full_id encoded_ref web_base url markdown result target_type series_ref version_no
  response="$(api_get "/api/artifacts/resolve?ref=$(urlencode "$ref")")" \
    || die "${RED}Failed to resolve artifact ref.${RESET}" 1
  identity="$(printf '%s\n' "$response" | jq -er --arg input_ref "$ref" '
    .resolution as $r
    | if $r.status != "resolved" then error("artifact ref did not resolve")
      elif ($input_ref | test("^artifact-series:"; "i")) and $r.logical_artifact then
        (($r.logical_artifact.ref // $r.logical_artifact.id) | sub("^artifact:"; "artifact-series:"))
        + (if ($input_ref | test("@[0-9]+$")) and $r.artifact_version then "@" + ($r.artifact_version.version_no | tostring) else "" end)
      elif $r.target_type == "artifact" then ($r.logical_artifact.ref // $r.logical_artifact.id)
      elif $r.target_type == "artifact_version" then ($r.artifact_version.ref // $r.target_id)
      elif $r.target_type == "artifact_blob" then ($r.artifact_blob.ref // $r.target_id)
      else error("unsupported artifact target type") end
  ')" || die "${RED}Artifact ref did not resolve to a typed identity.${RESET}" 1
  full_id="$(printf '%s\n' "$response" | jq -er --arg input_ref "$ref" '
    .resolution as $r
    | if ($input_ref | test("^artifact-series:"; "i")) and $r.logical_artifact then
        ($r.logical_artifact.id | sub("^artifact:"; "artifact-series:")) + (if ($input_ref | test("@[0-9]+$")) and $r.artifact_version then "@" + ($r.artifact_version.version_no | tostring) else "" end)
      else $r.target_id end')"
  target_type="$(printf '%s\n' "$response" | jq -r --arg input_ref "$ref" '
    if ($input_ref | test("^artifact-series:"; "i")) then "artifact_series" else .resolution.target_type end')"
  web_base="${MANDIBLE_WEB_BASE:-$MANDIBLE_CANONICAL_ORIGIN}"
  if [[ "$target_type" == "artifact_series" ]]; then
    series_ref="${identity%@*}"
    version_no=""
    [[ "$identity" == *@* ]] && version_no="${identity##*@}"
    encoded_ref="$(jq -nr --arg value "$series_ref" '$value | @uri')"
    url="${web_base}/#/artifacts?series=${encoded_ref}"
    [[ -n "$version_no" ]] && url+="&version=${version_no}"
    url+="&sidebar=hidden"
  else
    encoded_ref="$(jq -nr --arg value "$identity" '$value | @uri')"
    url="${web_base}/#/artifacts?ref=${encoded_ref}&sidebar=hidden"
  fi
  [[ -n "$label" ]] || label="$identity"
  markdown="[${label}](${url})"
  result="$(jq -n \
    --arg ref "$identity" \
    --arg full_id "$full_id" \
    --arg target_type "$target_type" \
    --arg url "$url" \
    --arg markdown "$markdown" \
    '{ref:$ref, full_id:$full_id, target_type:$target_type, url:$url, markdown:$markdown}')"
  if (( json )); then
    printf '%s\n' "$result" | jq .
    return
  fi
  case "$format" in
    id|ref) printf '%s\n' "$identity" ;;
    full) printf '%s\n' "$full_id" ;;
    url) printf '%s\n' "$url" ;;
    markdown) printf '%s\n' "$markdown" ;;
  esac
}

cmd_list() {
  local repo="" issue="" role="" custody="" json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.list" '{"repo":{"option":"repo"},"issue":{"option":"issue"},"role":{"option":"role"},"custody":{"option":"custody"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  [[ -n "$issue" ]] && resolve_issue "$issue"
  local query="" sep="?"
  for pair in "repo:$repo" "role:$role" "custody:$custody"; do
    local key="${pair%%:*}" value="${pair#*:}"
    if [[ -n "$value" ]]; then
      query+="${sep}${key}=$(urlencode "$value")"; sep="&"
    fi
  done
  if [[ -n "$issue_id" ]]; then
    query+="${sep}linked_entity_type=issue&linked_entity_id=$(urlencode "$issue_id")"
  fi
  local response
  response="$(api_get "/api/artifacts${query}")" || die "${RED}Failed to list artifacts.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '.artifacts[]? | "\(mandible_display_ref) \(.custody_mode) \(.availability) \(.role // "-") \(.uri)"'
  fi
}

cmd_associate() {
  local ref="" project="" role="" title="" json=0 canonical=0
  local binding
  binding=$(mandible_bind_arguments "artifact.associate" '{"project":{"option":"project"},"role":{"option":"role"},"title":{"option":"title"},"canonical":{"option":"canonical","constant":"1"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" && -n "$project" ]] || die "Usage: $(mandible_command_syntax artifact.associate)" 2
  require_tools
  local kind="associated"
  (( canonical )) && kind="canonical"
  local payload response
  payload="$(jq -n \
    --arg target_ref "$ref" \
    --arg project_ref "$project" \
    --arg association_kind "$kind" \
    --arg role "$role" \
    --arg title "$title" \
    '{target_ref:$target_ref, project_ref:$project_ref, association_kind:$association_kind}
      + (if $role != "" then {role:$role} else {} end)
      + (if $title != "" then {title:$title} else {} end)')"
  response="$(artifact_api_request POST "/api/artifacts/associations" "$payload")" \
    || die "${RED}Failed to associate artifact with project.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      .association
      | "associated \((.target_ref // (.target_type + ":" + .target_id)) | mandible_typed_short_ref) with project \(.project_key // (.project_id | mandible_short_id)) [\(.association_kind)\(if .role != "" then " · " + .role else "" end)]"'
  fi
}

cmd_associations() {
  local project="" json=0 canonical=0
  local binding
  binding=$(mandible_bind_arguments "artifact.associations" '{"project":{"option":"project"},"canonical":{"option":"canonical","constant":"1"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  local query="" sep="?"
  if [[ -n "$project" ]]; then
    query+="${sep}project=$(urlencode "$project")"; sep="&"
  fi
  if (( canonical )); then
    query+="${sep}association_kind=canonical"
  fi
  local response
  response="$(api_get "/api/artifacts/associations${query}")" \
    || die "${RED}Failed to list artifact associations.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      .associations[]?
      | "\(.project_key // (.project_id | mandible_short_id)) \(.association_kind) \((.target_ref // (.target_type + ":" + .target_id)) | mandible_typed_short_ref)\(if .role != "" then " " + .role else "" end)"'
  fi
}

artifact_route_target_for_ref() {
  local ref="$1"
  api_get "/api/artifacts/resolve?ref=$(urlencode "$ref")" \
    | jq -er '.resolution | select(.status == "resolved") | .target_id | select(type == "string" and length > 0)'
}

canonical_ref_for_artifact_json() {
  jq -r '
    if (.content_hash // "") != "" then "artifact-blob:" + .content_hash
    elif (.id // "" | test("^artifact:sha256:")) then (.id | sub("^artifact:sha256:"; "artifact-blob:"))
    else .id
    end'
}

cmd_show() {
  local ref="" json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.show" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax artifact.show)" 2
  require_tools
  local id response
  id="$(artifact_route_target_for_ref "$ref")" || die "${RED}Failed to resolve artifact ref.${RESET}" 1
  response="$(api_get "/api/artifacts/$(urlencode "$id")")" || die "${RED}Failed to show artifact.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '.artifact | "\(mandible_display_ref)\nrole: \(.role // "-")\ncustody: \(.custody_mode)\navailability: \(.availability)\nuri: \(.uri)"'
  fi
}

cmd_content() {
  local ref="" output="" json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.content" '{"output":{"option":"output"},"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax artifact.content)" 2
  require_tools
  local id response
  id="$(artifact_route_target_for_ref "$ref")" || die "${RED}Failed to resolve artifact ref.${RESET}" 1
  response="$(api_get "/api/artifacts/$(urlencode "$id")/content")" || die "${RED}Failed to fetch artifact content.${RESET}" 1
  if [[ -n "$output" ]]; then
    printf '%s\n' "$response" | jq -er '.content.preview.text' > "$output" \
      || die "${RED}Artifact has no text preview to write.${RESET}" 1
  fi
  if (( json )); then
    printf '%s\n' "$response" | jq .
  elif [[ -z "$output" ]]; then
    printf '%s\n' "$response" | jq -r '.content.preview.text // .content.reason // "binary content available; use --json for metadata"'
  else
    err "${GREEN}wrote artifact preview to ${output}${RESET}"
  fi
}

cmd_check() {
  local json=0 refs=()
  local binding
  binding=$(mandible_bind_arguments "artifact.check" '{"json":{"option":"json","constant":"1"},"refs":{"rest":0}}' "$@") || return $?
  eval "$binding"
  (( ${#refs[@]} > 0 )) || die "Usage: $(mandible_command_syntax artifact.check)" 2
  require_tools
  local refs_json result
  refs_json="$(printf '%s\n' "${refs[@]}" | jq -R . | jq -s .)"
  result="$(api_post "/api/artifacts/check" "$(jq -n --argjson refs "$refs_json" '{refs:$refs}')")" \
    || die "${RED}Failed to check artifacts.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$result" | jq .
  else
    printf '%s\n' "$result" | api_jq_human '.checks[] | .check as $c | "\($c.materializable // false) \(($c.ref // $c.artifact_ref // $c.artifact_id // .ref) | mandible_typed_short_ref) \((($c.reasons // []) + ($c.warnings // [])) | join(","))"'
  fi
}

# Read-only version history for a logical artifact series (issue f7a994e).
cmd_versions() {
  local ref="" json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.versions" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax artifact.versions)" 2
  require_tools
  local response
  response="$(api_get "/api/artifacts/versions?ref=$(urlencode "$ref")")" \
    || die "${RED}Failed to load artifact versions.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      .history.series as $s
      | ($s.ref // ($s.id | sub("^artifact-series:"; "artifact:"))) as $artifact_ref
      | "artifact \($artifact_ref) [\($s.source_kind)] \($s.version_count) version(s)\(if $s.title then " — \($s.title)" else "" end)",
      (.history.versions[]
        | "  v\(.version_no) \(.source_kind) \((.ref // .id // .artifact_id) | mandible_typed_short_ref)\(if .commit_sha then " @\(.commit_sha[0:12])" else "" end)\(if .label then " (\(.label))" else "" end)")'
  fi
}

# Read-only text/JSON/Markdown diff derived from two artifacts' full snapshot
# bytes (issue f7a994e). Refs use canonical artifact:, artifact-version:, or
# artifact-blob: forms accepted by the resolver.
cmd_diff() {
  local refs=() json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.diff" '{"json":{"option":"json","constant":"1"},"refs":{"rest":0}}' "$@") || return $?
  eval "$binding"
  (( ${#refs[@]} == 2 )) || die "Usage: $(mandible_command_syntax artifact.diff)" 2
  require_tools
  local response
  response="$(api_get "/api/artifacts/diff?a=$(urlencode "${refs[0]}")&b=$(urlencode "${refs[1]}")")" \
    || die "${RED}Failed to diff artifacts.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | jq -r '
      .diff as $d
      | if ($d.diffable | not) then "no diff: \($d.reason // "unavailable")"
        elif $d.identical then "identical (\($d.a.content_hash[0:12]))"
        else $d.unified end'
  fi
}

# Explicit recording selects custody and a canonical target; source changes
# require a guarded move. Ordinary ingest resolves the registered source.
cmd_move() {
  local ref="${1:-}" project="" target_path="" revision="" reconcile=0 json=0
  [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax artifact.move)" 2
  shift
  local binding
  binding=$(mandible_bind_arguments "artifact.move" '{"project":{"option":"project"},"target_path":{"option":"path"},"revision":{"option":"if-revision"},"reconcile":{"option":"reconcile","constant":"1"},"json":{"option":"json","constant":"1"}}' "$ref" "$@") || return $?
  eval "$binding"
  [[ -n "$project" || -n "$target_path" ]] || die "move requires --project or --path" 2
  [[ -z "$revision" || "$revision" =~ ^[0-9]+$ ]] || die "--if-revision must be a nonnegative integer" 2
  require_tools
  local payload response
  payload="$(jq -n --arg artifact_id "$ref" --arg project "$project" --arg path "$target_path" --arg revision "$revision" --argjson reconcile "$reconcile" '
    {artifact_id:$artifact_id,reconcile:($reconcile == 1)}
    + (if $project == "" then {} else {project:$project} end)
    + (if $path == "" then {} else {path:$path} end)
    + (if $revision == "" then {} else {expected_revision:($revision|tonumber)} end)')"
  response="$(artifact_api_request POST "/api/artifacts/source/move" "$payload")" || return $?
  if (( json )); then printf '%s\n' "$response" | jq .
  else printf '%s\n' "$response" | api_jq_human '"\(.status) \(.source.artifact_id | mandible_display_ref)"'
  fi
}

cmd_source() {
  local operation="${1:-}" ref="${2:-}"
  [[ "$operation" == "show" || "$operation" == "move" ]] && [[ -n "$ref" ]] \
    || die "Usage: mandible artifact source <show|move> <artifact-ref> [--expected-revision N --source JSON] [--json]" 2
  shift 2
  local revision="" source_json="" reconcile=0 json=0 response
  local binding
  binding=$(mandible_bind_arguments "artifact.source.${operation}" '{"revision":{"option":"expected-revision"},"source_json":{"option":"source"},"reconcile":{"option":"reconcile","constant":"1"},"json":{"option":"json","constant":"1"}}' "$ref" "$@") || return $?
  eval "$binding"
  require_tools
  if [[ "$operation" == "show" ]]; then
    [[ -z "$revision" && -z "$source_json" && "$reconcile" == "0" ]] || die "show does not accept move options" 2
    response="$(artifact_api_request GET "/api/artifacts/source?ref=$(urlencode "$ref")")" || return $?
  else
    [[ "$revision" =~ ^[0-9]+$ && -n "$source_json" ]] || die "move requires --expected-revision N and --source JSON" 2
    printf '%s' "$source_json" | jq -e 'type == "object" and (.kind == "repo" or .kind == "local" or .kind == "managed")' >/dev/null \
      || die "--source must be a repo, local or managed source object" 2
    local payload
    payload="$(jq -n --arg artifact_id "$ref" --argjson expected_revision "$revision" --argjson source "$source_json" --argjson reconcile "$reconcile" \
      '{artifact_id:$artifact_id,expected_revision:$expected_revision,source:$source,reconcile:($reconcile == 1)}')"
    response="$(artifact_api_request POST "/api/artifacts/source/move" "$payload")" || return $?
  fi
  if (( json )); then printf '%s\n' "$response" | jq .
  else printf '%s\n' "$response" | jq '.source | {revision,source,reconciliation_reason}'
  fi
}

cmd_record() {
  local artifact_target="" kind="" input_path="" ref="" series_key="" logical_name="" label="" note="" role="" title="" custody="" provider="" repo="" issue="" json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.record" '{"artifact_target":{"option":"artifact"},"kind":{"option":"kind"},"ref":{"option":"ref"},"series_key":{"option":"series-key"},"logical_name":{"option":"logical-name"},"label":{"option":"label"},"note":{"option":"note"},"role":{"option":"role"},"title":{"option":"title"},"custody":{"option":"custody"},"provider":{"option":"provider"},"repo":{"option":"repo"},"issue":{"option":"issue"},"json":{"option":"json","constant":"1"},"input_path":{"position":0}}' "$@") || return $?
  eval "$binding"
  [[ -n "$kind" ]] || die "Usage: $(mandible_command_syntax artifact.record)" 2
  case "$kind" in tracked_repo|local_only|managed) ;; *) die "Unknown --kind: $kind (expected tracked_repo, local_only, or managed)" 2 ;; esac
  if [[ -z "$input_path" && -z "$ref" ]]; then
    die "record requires a <path> (or --ref for managed)" 2
  fi
  require_tools
  local abs=""
  if [[ -n "$input_path" ]]; then
    abs="$(python_path abs "$input_path")"
    [[ -f "$abs" ]] || die "${RED}Not a regular file: ${abs}${RESET}" 1
  fi
  local payload
  payload="$(jq -n \
    --arg artifact_id "$artifact_target" \
    --arg source_kind "$kind" \
    --arg path "$abs" \
    --arg ref "$ref" \
    --arg series_key "$series_key" \
    --arg logical_name "$logical_name" \
    --arg label "$label" \
    --arg note "$note" \
    --arg role "$role" \
    --arg title "$title" \
    --arg custody_mode "$custody" \
    --arg provider_id "$provider" \
    --arg repo_id "$repo" \
    --arg issue "$issue" \
    '{source_kind:$source_kind}
      + (if $artifact_id != "" then {artifact_id:$artifact_id} else {} end)
      + (if $path != "" then {path:$path} else {} end)
      + (if $ref != "" then {ref:$ref} else {} end)
      + (if $series_key != "" then {series_key:$series_key} else {} end)
      + (if $logical_name != "" then {logical_name:$logical_name} else {} end)
      + (if $label != "" then {label:$label} else {} end)
      + (if $note != "" then {note:$note} else {} end)
      + (if $role != "" then {role:$role} else {} end)
      + (if $title != "" then {title:$title} else {} end)
      + (if $custody_mode != "" then {custody_mode:$custody_mode} else {} end)
      + (if $provider_id != "" then {provider_id:$provider_id} else {} end)
      + (if $repo_id != "" then {repo_id:$repo_id} else {} end)
      + (if $issue != "" then {issue:$issue} else {} end)')"
  local response
  response="$(artifact_api_request POST "/api/artifacts/versions" "$payload")" \
    || die "${RED}Failed to record artifact version.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '
      .result as $r
      | "\(if $r.created then "recorded" else "exists" end) v\($r.artifact_version.version_no) \($r.artifact_version | mandible_display_ref)",
        "series \($r.logical_artifact | mandible_display_ref) [\($r.logical_artifact.source_kind)] \($r.logical_artifact.version_count) version(s)",
        "artifact \($r.logical_artifact | mandible_display_ref)",
        ( ($r.warnings // [])[] | "warning: \(.)" )'
  fi
}

cmd_scan_repos() {
  local repo="" max_depth="" register=0 dry_run=0 json=0
  local binding
  binding=$(mandible_bind_arguments "artifact.scan-repos" '{"repo":{"option":"repo"},"max_depth":{"option":"max-depth"},"register":{"option":"register","constant":"1"},"dry_run":{"option":"dry-run","constant":"1"},"json":{"option":"json","constant":"1"}}' "$@") || return $?
  eval "$binding"
  require_tools
  local payload result
  payload="$(jq -n --arg repo "$repo" --arg max_depth "$max_depth" --argjson register "$register" --argjson dry_run "$dry_run" '{
    repo_ids:(if $repo == "" then null else [$repo] end),
    max_depth:(if $max_depth == "" then null else ($max_depth|tonumber) end),
    register:$register,
    dry_run:(if $dry_run == 1 then true else false end),
    discovery_only:(if $register == 1 then false else true end)
  } | with_entries(select(.value != null))')"
  result="$(api_post "/api/artifacts/scan-repos" "$payload")" || die "${RED}Failed to scan repos.${RESET}" 1
  if (( json )); then printf '%s\n' "$result" | jq .; else printf '%s\n' "$result" | jq -r 'if .warning then .warning else "scanned \(.scanned_repos|length) repos, ingested \(.ingested) artifacts" end'; fi
}

cmd_snapshot() {
  local from_path="" issue="" role="" json=0 upload=0 dry_run=0
  local args=()
  local binding
  binding=$(mandible_bind_arguments "artifact.snapshot" '{"from_path":{"option":"from"},"issue":{"option":"issue"},"role":{"option":"role"},"upload":{"option":"upload","constant":"1"},"dry_run":{"option":"dry-run","constant":"1"},"json":{"option":"json","constant":"1"},"args":{"rest":0}}' "$@") || return $?
  eval "$binding"

  if [[ -z "$from_path" ]]; then
    local forwarded=("${args[@]}")
    [[ -n "$issue" ]] && forwarded+=(--issue "$issue")
    [[ -n "$role" ]] && forwarded+=(--role "$role")
    (( upload )) && forwarded+=(--upload)
    (( dry_run )) && forwarded+=(--dry-run)
    (( json )) && forwarded+=(--json)
    cmd_ingest_like "managed" "${forwarded[@]}"
    return
  fi

  (( dry_run == 0 )) || die "Usage: $(mandible_command_syntax artifact.snapshot)" 2
  [[ ${#args[@]} -eq 1 ]] || die "Usage: $(mandible_command_syntax artifact.snapshot)" 2
  [[ -f "$from_path" ]] || die "Snapshot source path not found or not a regular file." 2
  require_tools
  [[ -n "$issue" ]] && resolve_issue "$issue"

  local ref="${args[1]}" payload response artifact link_response result abs_from link_ref
  abs_from="$(python_path abs "$from_path")"
  if api_is_file_rpc; then
    # Sandbox transport: bytes ride as a spool attachment, never inline base64
    # through argv/JSON (issue 833e972). The daemon injects content_path.
    local media filename resp_tmp resp_status
    media="$(media_type_for "$from_path")"
    filename="$(basename "$from_path")"
    payload="$(jq -n \
      --arg ref "$ref" \
      --arg filename "$filename" \
      --arg media_type "$media" \
      --arg role "$role" \
      --arg source_path "$abs_from" \
      '{
        ref:$ref,
        filename:$filename,
        logical_name:$filename,
        media_type:$media_type,
        custody_mode:"managed",
        metadata:{source:"artifact_cli", snapshot_source_path:$source_path},
        reference:{owner_system:"artifact_cli"}
      } + (if $role == "" then {} else {role:$role} end)')"
    resp_tmp="$(mktemp)"
    resp_status="$(api_send_content POST "/api/artifacts/snapshot" "$payload" "content_path" "$abs_from" "$resp_tmp")"
    [[ "$resp_status" =~ ^2 ]] || {
      local snap_err
      snap_err="$(explain_transport_failure "$resp_tmp" "api_snapshot_failed")"
      rm -f "$resp_tmp"
      die "${RED}Failed to snapshot artifact bytes: ${snap_err}.${RESET}" 1
    }
    response="$(cat "$resp_tmp")"
    rm -f "$resp_tmp"
  else
    # Local HTTP: the daemon shares the filesystem, so send the daemon-visible
    # absolute path and let it read the bytes (no base64 anywhere).
    payload="$(jq -n --arg ref "$ref" --arg path "$abs_from" --arg role "$role" \
      '{ref:$ref, path:$path, custody_mode:"managed"} + (if $role == "" then {} else {role:$role} end)')"
    response="$(api_post "/api/artifacts/snapshot" "$payload")" || die "${RED}Failed to snapshot artifact bytes.${RESET}" 1
  fi
  artifact="$(printf '%s' "$response" | jq '.artifact')"
  if [[ -n "$issue_id" ]]; then
    link_ref="$(printf '%s' "$artifact" | canonical_ref_for_artifact_json)"
    link_response="$(api_post "/api/artifacts/link" "$(jq -n --arg ref "$link_ref" --arg entity_id "$issue_id" --arg repo_id "$issue_repo" --arg role "$role" \
      '{ref:$ref, entity_type:"issue", entity_id:$entity_id, link_type:"references", role:(if $role == "" then null else $role end), repo_id:(if $repo_id == "" then null else $repo_id end), source:"artifact_cli"}')")" \
      || die "${RED}Snapshot succeeded but issue link failed.${RESET}" 1
    result="$(jq -n --argjson artifact "$artifact" --argjson link "$(printf '%s' "$link_response" | jq '.link')" '{artifact:$artifact, link:$link}')"
  else
    result="$(jq -n --argjson artifact "$artifact" '{artifact:$artifact}')"
  fi
  if (( json )); then
    printf '%s\n' "$result" | jq .
  else
    printf '%s\n' "$result" | api_jq_human '"snapshotted \(.artifact | mandible_display_ref) \(.artifact.custody_mode) \(.artifact.availability)"'
  fi
}

bundle_create() {
  local name="" manifest="" issue="" role="run_packet" json=0 dry_run=0 allow_local=0 allow_dirty=0
  local members=()
  local binding
  binding=$(mandible_bind_arguments "artifact.bundle.create" '{"name":{"option":"name"},"manifest":{"option":"manifest"},"issue":{"option":"issue"},"role":{"option":"role"},"dry_run":{"option":"dry-run","constant":"1"},"json":{"option":"json","constant":"1"},"members":{"rest":0}}' "$@") || return $?
  eval "$binding"
  require_tools
  [[ -n "$issue" ]] && resolve_issue "$issue"
  if [[ -n "$manifest" ]]; then
    [[ -f "$manifest" ]] || die "Bundle manifest not found." 2
    name="${name:-$(jq -r '.name // empty' "$manifest")}"
    role="${role:-$(jq -r '.role // "run_packet"' "$manifest")}"
    members=()
    while IFS= read -r member; do
      [[ -n "$member" ]] && members+=("$member")
    done < <(jq -r '.members[]? | .path // .ref // .uri // empty' "$manifest")
  fi
  [[ -n "$name" ]] || die "bundle create requires --name or manifest.name" 2

  local member_results='[]' failed='[]' member payload response artifact artifact_ref bundle_manifest bundle_payload bundle_response bundle_id link_payload bundle_links bundle_artifact encoded_ref members_payload
  members_payload='[]'
  if [[ -n "$manifest" ]]; then
    members_payload="$(jq '.members // []' "$manifest")"
  else
    for member in "${members[@]}"; do
      if [[ -e "$member" ]]; then
        members_payload="$(printf '%s' "$members_payload" | jq --arg path "$member" '. + [{path:$path}]')"
      else
        members_payload="$(printf '%s' "$members_payload" | jq --arg ref "$member" '. + [{ref:$ref}]')"
      fi
    done
  fi

  if (( ! dry_run )); then
    payload="$(jq -n --arg name "$name" --arg role "$role" --arg issue "$issue" --argjson members "$members_payload" \
      '{name:$name, role:$role, members:$members} + (if $issue == "" then {} else {issue:$issue} end)')"
    bundle_response="$(artifact_api_request POST "/api/artifacts/bundles" "$payload")" || die "${RED}Failed to create bundle.${RESET}" 1
    if (( json )); then
      printf '%s\n' "$bundle_response" | jq .
    else
      printf '%s\n' "$bundle_response" | api_jq_human '"bundle \(.bundle | mandible_display_ref) members=\(.members|length)"'
    fi
    return
  fi

  for member in "${members[@]}"; do
    if [[ -e "$member" ]]; then
      if ! payload=$(payload_for_path "$member" "git" "" "$allow_local" "$allow_dirty" "references"); then
        failed="$(printf '%s' "$failed" | jq --argjson item "$payload" '. + [$item]')"
        continue
      fi
      if (( dry_run )); then
        artifact="$(printf '%s' "$payload" | jq '{id:("artifact-blob:" + .sha256), role, custody_mode, recoverability:.metadata.recoverability, uri}')"
      else
        if ! response=$(api_post "/api/artifacts/ingest" "$payload"); then
          failed="$(printf '%s' "$failed" | jq --arg ref "$member" '. + [{ref:$ref, error:"api_ingest_failed"}]')"
          continue
        fi
        artifact="$(printf '%s' "$response" | jq '.artifact')"
      fi
    else
      encoded_ref="$(urlencode "$member")"
      if ! response=$(api_get "/api/artifacts/resolve?ref=${encoded_ref}"); then
        failed="$(printf '%s' "$failed" | jq --arg ref "$member" '. + [{ref:$ref, error:"api_resolve_failed"}]')"
        continue
      fi
      artifact="$(printf '%s' "$response" | jq '.resolution.artifact')"
    fi
    artifact_ref="$(printf '%s' "$artifact" | canonical_ref_for_artifact_json)"
    artifact="$(printf '%s' "$artifact" | jq --arg id "$artifact_ref" '.id=$id')"
    member_results="$(printf '%s' "$member_results" | jq --arg input "$member" --argjson artifact "$artifact" '. + [{input:$input, artifact:$artifact}]')"
  done

  bundle_manifest="$(
    jq -n \
      --arg name "$name" \
      --arg role "$role" \
      --argjson members "$member_results" \
      '{
        schema_version:"mandible.artifact_bundle.v1",
        name:$name,
        role:$role,
        members:($members | map({
          input,
          artifact_id:.artifact.id,
          ref:(.artifact.uri // .artifact.id),
          role:.artifact.role,
          custody_mode:.artifact.custody_mode,
          recoverability:(.artifact.metadata.recoverability // .artifact.reference.recoverability // null)
        }))
      }'
  )"
  bundle_links="$(issue_link_json "references" "$role")"
  bundle_payload="$(
    jq -n \
      --arg name "$name" \
      --arg role "$role" \
      --argjson manifest "$bundle_manifest" \
      --argjson links "$bundle_links" \
      '{
        json:$manifest,
        filename:($name + ".bundle.json"),
        logical_name:$name,
        media_type:"application/json",
        role:$role,
        custody_mode:"managed",
        availability:"present",
        metadata:{title:$name, recoverability:"mandible_cas", bundle:true, source:"artifact_cli"},
        reference:{owner_system:"artifact_cli", identity_kind:"bundle_manifest", recoverability:"mandible_cas"},
        links:$links
      }'
  )"
  if (( dry_run )); then
    bundle_response="$(jq -n --argjson planned_payload "$bundle_payload" --argjson members "$member_results" --argjson failed "$failed" '{command:"bundle create", dry_run:true, planned_payload:$planned_payload, members:$members, failed:$failed}')"
  else
    bundle_response="$(artifact_api_request POST "/api/artifacts/ingest" "$bundle_payload")" || die "${RED}Failed to create bundle manifest artifact.${RESET}" 1
    bundle_id="$(printf '%s' "$bundle_response" | jq -r '.artifact.id')"
    for artifact_id in $(printf '%s' "$member_results" | jq -r '.[].artifact.id'); do
      link_payload="$(jq -n --arg ref "$artifact_id" --arg bundle_id "$bundle_id" \
        '{ref:$ref, entity_type:"artifact", entity_id:$bundle_id, link_type:"bundle_contains", source:"artifact_cli"}')"
      artifact_api_request POST "/api/artifacts/link" "$link_payload" >/dev/null || true
    done
    bundle_artifact="$(printf '%s' "$bundle_response" | jq '.artifact')"
    bundle_response="$(jq -n --argjson bundle "$bundle_artifact" --argjson members "$member_results" --argjson failed "$failed" '{command:"bundle create", bundle:$bundle, members:$members, failed:$failed}')"
  fi
  if (( json )); then printf '%s\n' "$bundle_response" | jq .; else printf '%s\n' "$bundle_response" | api_jq_human '"bundle \(if .bundle then (.bundle | mandible_display_ref) else .planned_payload.logical_name end) members=\(.members|length)"'; fi
}

bundle_add() {
  local bundle_ref="" json=0 allow_local=0 allow_dirty=0 members=()
  local binding
  binding=$(mandible_bind_arguments "artifact.bundle.add" '{"json":{"option":"json","constant":"1"},"bundle_ref":{"position":0},"members":{"rest":1}}' "$@") || return $?
  eval "$binding"
  [[ -n "$bundle_ref" && ${#members[@]} -gt 0 ]] || die "Usage: $(mandible_command_syntax artifact.bundle.add)" 2
  require_tools
  local bundle_id member artifact response payload linked='[]' failed='[]' members_payload='[]'
  bundle_id="$(artifact_route_target_for_ref "$bundle_ref")" || die "${RED}Failed to resolve bundle ref.${RESET}" 1
  for member in "${members[@]}"; do
    if [[ -e "$member" ]]; then
      members_payload="$(printf '%s' "$members_payload" | jq --arg path "$member" '. + [{path:$path}]')"
    else
      members_payload="$(printf '%s' "$members_payload" | jq --arg ref "$member" '. + [{ref:$ref}]')"
    fi
  done
  response="$(artifact_api_request POST "/api/artifacts/bundles/$(urlencode "$bundle_id")/members" "$(jq -n --argjson members "$members_payload" '{members:$members}')")" \
    || die "${RED}Failed to add bundle members.${RESET}" 1
  if (( json )); then
    printf '%s\n' "$response" | jq .
  else
    printf '%s\n' "$response" | api_jq_human '"bundle \(.bundle | mandible_display_ref) members=\(.members|length)"'
  fi
}

bundle_show() {
  local bundle_ref="$1" json="${2:-0}"
  require_tools
  local bundle_id result
  bundle_id="$(artifact_route_target_for_ref "$bundle_ref")" || die "${RED}Failed to resolve bundle ref.${RESET}" 1
  result="$(api_get "/api/artifacts/bundles/$(urlencode "$bundle_id")")" || die "${RED}Failed to show bundle.${RESET}" 1
  if (( json )); then printf '%s\n' "$result" | jq .; else printf '%s\n' "$result" | api_jq_human '"bundle \(.bundle | mandible_display_ref) members=\(.members|length)"'; fi
}

cmd_bundle() {
  local sub="${1:-}"
  [[ -n "$sub" ]] || die "Usage: mandible artifact bundle <create|add|show|check> ..." 2
  shift
  case "$sub" in
    create) bundle_create "$@" ;;
    add) bundle_add "$@" ;;
    show)
      local json=0 ref=""
      local binding
      binding=$(mandible_bind_arguments "artifact.bundle.show" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
      eval "$binding"
      [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax artifact.bundle.show)" 2
      bundle_show "$ref" "$json"
      ;;
    check)
      local json=0 ref=""
      local binding
      binding=$(mandible_bind_arguments "artifact.bundle.check" '{"json":{"option":"json","constant":"1"},"ref":{"position":0}}' "$@") || return $?
      eval "$binding"
      [[ -n "$ref" ]] || die "Usage: $(mandible_command_syntax artifact.bundle.check)" 2
      local bundle_id refs=()
      bundle_id="$(artifact_route_target_for_ref "$ref")" || die "${RED}Failed to resolve bundle ref.${RESET}" 1
      for member_id in $(api_get "/api/artifacts/bundles/$(urlencode "$bundle_id")" | jq -r '.members[].artifact.id'); do
        refs+=("$member_id")
      done
      cmd_check "${refs[@]}" $([[ "$json" == "1" ]] && printf -- "--json")
      ;;
    *) die "Unknown bundle subcommand: $sub" 2 ;;
  esac
}

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

cmd="$1"
shift
case "$cmd" in
  move) cmd_move "$@" ;;
  source) cmd_source "$@" ;;
  ingest) cmd_ingest_like "" "$@" ;;
  snapshot) cmd_snapshot "$@" ;;
  ref) cmd_ref "$@" ;;
  link) cmd_link "$@" ;;
  resolve) cmd_resolve "$@" ;;
  format) cmd_format "$@" ;;
  list) cmd_list "$@" ;;
  associate) cmd_associate "$@" ;;
  associations) cmd_associations "$@" ;;
  show) cmd_show "$@" ;;
  content) cmd_content "$@" ;;
  check) cmd_check "$@" ;;
  versions) cmd_versions "$@" ;;
  diff) cmd_diff "$@" ;;
  record) cmd_record "$@" ;;
  scan-repos) cmd_scan_repos "$@" ;;
  bundle) cmd_bundle "$@" ;;
  *) die "Unknown artifact subcommand: $cmd" 2 ;;
esac
