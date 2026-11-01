import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUTH_REQUEST_STATUSES, computeAuthRequestOutcome } from '../src/contracts.ts';

export const authStatusShell = `# Generated from src/contracts.ts by scripts/generate-auth-status.mjs.
# Exit codes: 0 delivered, 1 terminal failure, 2 in flight, 3 unknown.
mandible_auth_classify() {
  case "\${1:-}" in
${AUTH_REQUEST_STATUSES.map(status => {
  const outcome = computeAuthRequestOutcome(status);
  const code = outcome === null ? 2 : outcome === 'succeeded' ? 0 : 1;
  return `    ${status}) return ${code} ;;`;
}).join('\n')}
    *) return 3 ;;
  esac
}
`;
export const authStatusPath = new URL('../cli/auth-status.generated.sh', import.meta.url);
export function authStatusDrift() {
  return readFileSync(authStatusPath, 'utf8') === authStatusShell ? []
    : ['cli/auth-status.generated.sh: stale; run scripts/bun-runtime.sh --exec scripts/generate-auth-status.mjs'];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(authStatusPath, authStatusShell);
