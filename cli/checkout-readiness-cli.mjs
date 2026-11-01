import { checkCheckoutReadiness } from './checkout-readiness.mjs';

const [checkout, baseBranch, base, target] = process.argv.slice(2);
if (![3, 6].includes(process.argv.length)) {
  console.error('Usage: checkout-readiness.sh <checkout> [<base-branch> <base-sha> <candidate-tree>]');
  process.exit(2);
}
const result = await checkCheckoutReadiness(checkout, baseBranch ? { baseBranch, base, target } : undefined);
if (result.status === 'error') {
  console.log(result.message);
  process.exit(result.exitCode);
}
