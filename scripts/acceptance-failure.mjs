/**
 * Approver-facing wording for candidate-acceptance failures. The approver reads
 * a failure on the auth request to decide whether to fix the branch or rerun,
 * so every failure names what was checked and ends with whose fault it points to.
 */

const verdicts = {
  candidate: 'This points at the branch: fix it, then run acceptance again.',
  environment: 'This points at the acceptance environment, not the branch: run acceptance again.',
  either: 'This can come from the branch or from the acceptance environment: run acceptance again, and if it fails the same way, look at the branch.',
};

const stages = {
  startup: ['Setting up the acceptance run', 'environment'],
  checkout: ["Preparing a checkout of the candidate and installing its dependencies", 'either'],
  package_build: ['Building the signed Mandible.app from the candidate', 'either'],
  package_verification: ['Verifying the built Mandible.app (its signature, its contents, and that it was built from this candidate)', 'either'],
  readiness: ['Starting the packaged daemon in an isolated instance and waiting for it to report ready', 'either'],
  desktop_interaction: ['Running the packaged app through first-run setup and a Settings edit', 'either'],
  health_coverage: ["Checking the daemon's event-loop delay and memory while the packaged app ran", 'either'],
  finalization: ['Cleaning up after the checks and keeping the tested package', 'environment'],
};

/** What acceptance was doing in `stage`, as a sentence subject. */
export const stageActivity = stage => (stages[stage] ?? stages.startup)[0];

export const sentence = text => {
  const trimmed = String(text).trim();
  return /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** A failure whose message is already written for the approver. */
export class AcceptanceFailure extends Error {
  constructor(fault, message, values) {
    super(message);
    this.name = 'AcceptanceFailure';
    this.acceptanceFault = fault;
    if (values) this.values = values;
  }
}

export const acceptanceFailure = (fault, message, values) => new AcceptanceFailure(fault, message, values);

/** The approver text for a message and its fault. */
export function failureText(fault, message) {
  return `${sentence(message)} ${verdicts[fault]}`;
}

/**
 * Describe any error raised while `stage` ran. Pre-described failures keep
 * their wording; other errors are framed by the stage that was running.
 */
export function describeAcceptanceFailure(error, stage = 'startup') {
  const detail = error instanceof Error ? error.message : String(error);
  const described = (fault, message, values) => ({ fault, text: failureText(fault, message), detail, ...(values ? { values } : {}) });
  if (error?.acceptanceFault in verdicts) return described(error.acceptanceFault, error.message, error.values);
  if (['probe_failed', 'observation_changed'].includes(error?.code) && error.cause) return { ...describeAcceptanceFailure(error.cause, stage), detail };
  if (error?.code === 'PROCESS_LOCK_LOST') {
    return described('environment', 'Acceptance lost exclusive ownership of its scratch directory and stopped. Another acceptance run, or a cleanup of acceptance scratch, probably took it over.');
  }
  const [activity, fault] = stages[stage] ?? stages.startup;
  if (error?.code === 'HUNG') {
    return described('either', `${activity} stopped making progress: ${sentence(detail)} A stuck build tool, a dead network connection or a deadlocked process causes this, and so can a branch that hangs.`);
  }
  return described(fault, `${activity} failed: ${sentence(detail)}`);
}

/** A recorded failure's fault and compared values, without bulky evidence. */
export function compactFailure(failure) {
  if (!failure || typeof failure !== 'object') return undefined;
  const { evidence: _evidence, ...rest } = failure;
  return { ...rest, ...(typeof rest.detail === 'string' ? { detail: rest.detail.slice(0, 1024) } : {}) };
}
