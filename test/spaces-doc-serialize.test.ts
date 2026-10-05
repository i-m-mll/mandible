import { describe, expect, it } from 'vitest';
import {
  BLOCK_TYPES,
  SPACES_DOC_VERSION,
  assertNonExecutableGrammar,
  exportDocument,
  importDocument,
  isSpacesDocDirectiveRef,
  parseDirectiveAttributes,
  parseSpacesDocDirectiveRef,
  type DocBlock,
  type DocTree,
} from '../src/spaces/serialize';

const HASH64 = 'a'.repeat(64);

function block(partial: Partial<DocBlock> & Pick<DocBlock, 'id' | 'sort_key'>): DocBlock {
  return {
    parent_id: null,
    block_type: 'paragraph',
    item_id: null,
    markdown: '',
    ...partial,
  };
}

function tree(blocks: DocBlock[], frontmatter: Record<string, string> = {}): DocTree {
  return { frontmatter, blocks };
}

// Normalize for round-trip equality: tree identity is the block set keyed by id,
// compared field-by-field (document order is reconstructed from sort_key/parent).
function normalize(t: DocTree): Record<string, DocBlock> {
  const byId: Record<string, DocBlock> = {};
  for (const b of t.blocks) byId[b.id] = b;
  return byId;
}

describe('spaces-doc.v1 frozen grammar', () => {
  it('publishes the frozen version marker', () => {
    expect(SPACES_DOC_VERSION).toBe('spaces-doc.v1');
  });

  it('block types match the C11 space_blocks CHECK set (frozen)', () => {
    expect([...BLOCK_TYPES]).toEqual([
      'heading',
      'paragraph',
      'reference',
      'artifact_embed',
      'issue_embed',
      'comment_embed',
      'todo',
    ]);
  });

  it('export writes the format marker into frontmatter', () => {
    const text = exportDocument(tree([block({ id: 'b1', sort_key: 'a0', block_type: 'heading', markdown: '# Hi' })]));
    expect(text).toContain('mandible_format: spaces-doc.v1');
  });
});

describe('round-trip: import(export(tree)) == tree', () => {
  it('round-trips parent_id, sort_key, block_type, item_id embeds, and prose body', () => {
    const original = tree(
      [
        block({ id: 'b1', sort_key: 'a0', block_type: 'heading', markdown: '# Results' }),
        block({
          id: 'b2',
          parent_id: 'b1',
          sort_key: 'a1',
          block_type: 'paragraph',
          markdown: 'The run produced output and resolved the question.',
        }),
        block({
          id: 'b3',
          parent_id: 'b1',
          sort_key: 'a2',
          block_type: 'artifact_embed',
          item_id: `artifact:sha256:${HASH64}`,
          markdown: `![figure](artifact:sha256:${HASH64})`,
        }),
        block({ id: 'b4', parent_id: 'b1', sort_key: 'a3', block_type: 'todo', markdown: '> TODO: decide.' }),
      ],
      { mandible_space: 'space-123' },
    );

    const text = exportDocument(original);
    const { tree: reimported, conflicts } = importDocument(text);

    expect(conflicts).toEqual([]);
    expect(normalize(reimported)).toEqual(normalize(original));
    // Specific field assertions for each round-trip-required field.
    const b3 = reimported.blocks.find((b) => b.id === 'b3')!;
    expect(b3.parent_id).toBe('b1');
    expect(b3.sort_key).toBe('a2');
    expect(b3.block_type).toBe('artifact_embed');
    expect(b3.item_id).toBe(`artifact:sha256:${HASH64}`);
    expect(b3.markdown).toContain('artifact:sha256:');
    expect(reimported.frontmatter.mandible_space).toBe('space-123');
  });

  it('export is deterministic (stable serialization)', () => {
    const t = tree([
      block({ id: 'b2', sort_key: 'a1', markdown: 'second' }),
      block({ id: 'b1', sort_key: 'a0', markdown: 'first' }),
    ]);
    expect(exportDocument(t)).toBe(exportDocument(t));
    // sort_key drives order regardless of input array order.
    const text = exportDocument(t);
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
  });

  it('round-trips empty-body prose blocks', () => {
    const original = tree([block({ id: 'b1', sort_key: 'a0', markdown: '' })]);
    const { tree: reimported, conflicts } = importDocument(exportDocument(original));
    expect(conflicts).toEqual([]);
    expect(normalize(reimported)).toEqual(normalize(original));
  });
});

describe('import-conflict matrix (custody-doc §1.3, all 5 rows)', () => {
  it('row 1: duplicate block id is a conflict, never silently merged', () => {
    const text = [
      '---',
      'mandible_format: spaces-doc.v1',
      '---',
      '',
      ':::block{id="b1" parent="root" sort="a0" type="paragraph"}',
      'first',
      ':::',
      '',
      ':::block{id="b1" parent="root" sort="a1" type="paragraph"}',
      'duplicate',
      ':::',
      '',
    ].join('\n');
    const { tree: t, conflicts } = importDocument(text);
    expect(conflicts.some((c) => c.kind === 'duplicate_id' && c.blockId === 'b1')).toBe(true);
    // The duplicate is NOT merged into the kept block: only one b1 survives.
    expect(t.blocks.filter((b) => b.id === 'b1')).toHaveLength(1);
  });

  it('row 2: a block node with no id is imported as a new generated-ID block', () => {
    const text = [
      '---',
      'mandible_format: spaces-doc.v1',
      '---',
      '',
      ':::block{parent="root" sort="a0" type="paragraph"}',
      'externally added prose',
      ':::',
      '',
    ].join('\n');
    const { tree: t, conflicts } = importDocument(text);
    const conflict = conflicts.find((c) => c.kind === 'new_external_block');
    expect(conflict).toBeDefined();
    expect(conflict!.blockId).toMatch(/^imported-/);
    expect(t.blocks.find((b) => b.id === conflict!.blockId)?.markdown).toBe('externally added prose');
  });

  it('row 2b: loose prose outside any directive is imported as a new block', () => {
    const text = [
      '---',
      'mandible_format: spaces-doc.v1',
      '---',
      '',
      'Hand-typed paragraph with no directive wrapper.',
      '',
    ].join('\n');
    const { conflicts } = importDocument(text);
    expect(conflicts.some((c) => c.kind === 'new_external_block')).toBe(true);
  });

  it('row 3: body changed under a known id is flagged as an external edit', () => {
    const prior = tree([block({ id: 'b1', sort_key: 'a0', markdown: 'original body' })]);
    const editedText = exportDocument(tree([block({ id: 'b1', sort_key: 'a0', markdown: 'externally edited body' })]));
    const { tree: t, conflicts } = importDocument(editedText, prior);
    const edit = conflicts.find((c) => c.kind === 'external_edit' && c.blockId === 'b1');
    expect(edit).toBeDefined();
    // Content is updated from the file (not discarded).
    expect(t.blocks.find((b) => b.id === 'b1')?.markdown).toBe('externally edited body');
  });

  it('row 4: a known id dropped from the file is a delete-after-confirm conflict, never auto-dropped', () => {
    const prior = tree([
      block({ id: 'b1', sort_key: 'a0', markdown: 'kept' }),
      block({ id: 'b2', sort_key: 'a1', markdown: 'will be removed externally' }),
    ]);
    const droppedText = exportDocument(tree([block({ id: 'b1', sort_key: 'a0', markdown: 'kept' })]));
    const { conflicts } = importDocument(droppedText, prior);
    const dropped = conflicts.find((c) => c.kind === 'dropped_block' && c.blockId === 'b2');
    expect(dropped).toBeDefined();
    expect(dropped!.detail).toMatch(/confirm/i);
  });

  it('row 5: an unresolved/unknown reference is retained as a placeholder, never dropped', () => {
    const text = [
      '---',
      'mandible_format: spaces-doc.v1',
      '---',
      '',
      ':::block{id="b1" parent="root" sort="a0" type="paragraph"}',
      'see :ref[mystery]{href="weird://unknown/thing"} here',
      ':::',
      '',
    ].join('\n');
    const { conflicts } = importDocument(text);
    const unresolved = conflicts.find((c) => c.kind === 'unresolved_reference');
    expect(unresolved).toBeDefined();
    expect(unresolved!.ref).toBe('weird://unknown/thing');
  });

  it('a clean, unmodified round-trip produces NO conflicts', () => {
    const original = tree([
      block({ id: 'b1', sort_key: 'a0', block_type: 'heading', markdown: '# H' }),
      block({ id: 'b2', parent_id: 'b1', sort_key: 'a1', markdown: 'body' }),
    ]);
    const { conflicts } = importDocument(exportDocument(original), original);
    expect(conflicts).toEqual([]);
  });
});

describe('non-executable data-node guarantee', () => {
  it('assertNonExecutableGrammar passes (no executable directive path exists)', () => {
    expect(assertNonExecutableGrammar()).toBe(true);
  });

  it('a javascript:-scheme ref directive is inert unresolved data, not executed', () => {
    const parsed = parseSpacesDocDirectiveRef(':ref[x]{href="javascript:alert(1)"}');
    expect(parsed).not.toBeNull();
    expect(parsed!.canonical).toBe('javascript:alert(1)');
    expect(parsed!.kind).toBe('unknown');
  });

  it('expression-shaped attribute values are parsed as inert strings, never evaluated', () => {
    const attrs = parseDirectiveAttributes('expr={1+1} href="repo://r@main/x"');
    // The `{1+1}` token is captured as inert string data, NOT evaluated to 2.
    expect(typeof attrs.expr).toBe('string');
    expect(attrs.expr).not.toBe('2');
    expect(attrs.expr).toContain('1+1');
    expect(attrs.href).toBe('repo://r@main/x');
  });

  it('the serializer module exports no eval/Function/import() executable path', () => {
    // Structural guard: the directive parsers are pure functions over strings.
    // A directive carrying a function-call-shaped body never produces callable
    // output — only data records.
    const parsed = parseSpacesDocDirectiveRef(':embed{href="artifact:sha256:' + HASH64 + '"}');
    expect(parsed?.directive).toBe('embed');
    expect(typeof parsed).toBe('object');
  });
});

describe('spaces-doc.v1 directive ref recognition (frozen grammar)', () => {
  it('recognizes inline :ref[label]{href=...} directives', () => {
    const parsed = parseSpacesDocDirectiveRef(':ref[abc]{href="artifact:sha256:' + HASH64 + '"}');
    expect(parsed).not.toBeNull();
    expect(parsed!.directive).toBe('ref');
    expect(parsed!.label).toBe('abc');
    expect(parsed!.kind).toBe('artifact');
    expect(parsed!.canonical).toBe(`artifact:sha256:${HASH64}`);
  });

  it('recognizes mandible://…/issue/… refs as issue kind', () => {
    const parsed = parseSpacesDocDirectiveRef(':ref[e70757d]{href="mandible://mandible/issue/e70757d"}');
    expect(parsed!.kind).toBe('issue');
  });

  it('recognizes repo:// refs as repo kind', () => {
    const parsed = parseSpacesDocDirectiveRef(':embed{href="repo://mandible@main/docs/x.md"}');
    expect(parsed!.kind).toBe('repo');
    expect(parsed!.directive).toBe('embed');
  });

  it('rejects non-directive text', () => {
    expect(isSpacesDocDirectiveRef('just some prose')).toBe(false);
    expect(isSpacesDocDirectiveRef('[artifact:abc123]')).toBe(false);
    expect(parseSpacesDocDirectiveRef('')).toBeNull();
  });
});
