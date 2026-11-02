export interface CheckoutCandidate { baseBranch: string; base: string; target: string }
export type CheckoutReadiness = { status: 'clean' } | { status: 'error'; exitCode: 1 | 2; message: string };
export function checkCheckoutReadiness(checkout: string, candidate?: CheckoutCandidate, env?: NodeJS.ProcessEnv): Promise<CheckoutReadiness>;
