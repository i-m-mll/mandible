import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Spaces reference detail header inheritance', () => {
  it('delegates Issue and Artifact details to canonical consumers without owning a header', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'ui/src/views/spaces/SpaceReferenceDetailPanel.tsx'),
      'utf8',
    );

    expect(source).toMatch(/import \{ LedgerIssueDetail \} from ['"]\.\.\/\.\.\/components\/ledger\/IssueDetail['"]/);
    expect(source).toMatch(/import \{ ArtifactDetail \} from ['"]\.\.\/artifacts['"]/);
    expect(source).toContain('<LedgerIssueDetail');
    expect(source).toContain('<ArtifactDetail');
    expect(source).not.toMatch(/DetailPaneHeader|DetailHeaderIdentity|CopyRefButton/);
  });
});
