# Generated from src/contracts.ts by scripts/generate-auth-status.mjs.
# Exit codes: 0 delivered, 1 terminal failure, 2 in flight, 3 unknown.
mandible_auth_classify() {
  case "${1:-}" in
    pending) return 2 ;;
    executing) return 2 ;;
    approved) return 2 ;;
    needs_rebase) return 1 ;;
    rejected) return 1 ;;
    withdrawn) return 1 ;;
    superseded) return 1 ;;
    expired) return 1 ;;
    completed) return 0 ;;
    failed) return 1 ;;
    dismissed) return 1 ;;
    *) return 3 ;;
  esac
}
