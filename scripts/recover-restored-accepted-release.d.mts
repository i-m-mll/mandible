import type Database from '../src/sqlite.ts';

type QuarantinePlan = {
  root: string;
  destination: string;
  reference: string;
  packageSha256: string;
  recoveryReceipt: string;
  authority: { kind: 'ledger'; acceptanceId: string; requestId: string } | { kind: 'prior-discard' };
};

type PurgePlan = Pick<QuarantinePlan, 'root' | 'destination' | 'packageSha256' | 'recoveryReceipt'> & {
  purgeReceipt: string;
  apparentBytes: number;
};

export function recoverRestoredAcceptedRelease(db: Database, home: string, runId: string, options?: {
  applyToken?: string;
  purge?: boolean;
  inspect?: (root: string) => { idle: true } | { idle: false; reason: string };
}): Promise<
  | ({ action: 'quarantine'; applyToken: string } & QuarantinePlan)
  | ({ action: 'quarantined' } & QuarantinePlan)
  | ({ action: 'purge'; applyToken: string } & PurgePlan)
  | ({ action: 'purged' } & PurgePlan)
  | ({ action: 'purge-pending'; reason: string } & PurgePlan)
  | { action: 'preserve' | 'quarantine-unconfirmed'; root: string; destination: string; reason: string }
>;
