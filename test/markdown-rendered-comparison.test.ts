import { expect, it } from 'vitest';
import { compareRenderedMarkdown } from '../ui/src/components/markdown/comparison';

it('keeps a local word edit distinct from the replacement of an unrelated paragraph', () => {
  const local = 'Operators verify the staging environment before rolling out.';
  const removed = 'The incident commander calls the pager and broadcasts escalation instructions to support.';
  const inserted = 'The release manager records a vote and closes deployments after the scheduled freeze.';
  const document = (detail: string, procedure: string) => [
    '# Release workflow', '', detail, '', procedure, '', '## Verification', '', 'Run the independent check.', '',
  ].join('\n');
  const before = document(local, removed);
  const after = document(local.replace('staging', 'production'), inserted);
  const changes = compareRenderedMarkdown(before, after);

  expect(changes.map(({ fromA, toA, fromB, toB }) => [
    before.slice(fromA, toA).trim(), after.slice(fromB, toB).trim(),
  ])).toEqual([
    ['staging', 'production'],
    [removed, inserted],
  ]);
});
