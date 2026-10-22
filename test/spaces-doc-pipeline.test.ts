// Tests for the secure, non-executable `spaces-doc.v1` parse/sanitize pipeline
// (Spaces child C14a, issue 047d1be). These cover:
//   - parse path: `spaces-doc.v1` -> data nodes + sanitized HTML
//   - the standing renderer-security AC (#2): NO script execution from any
//     document directive, and NO executable directive path.

import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSpacesDoc,
  renderProseToSafeHtml,
  SPACES_DOC_VERSION,
  FORMAT_KEY,
} from '../ui/src/spaces/doc-pipeline';
import { exportDocument, type DocTree } from '../src/spaces/serialize';
import { __resetResourceRefRecognizers } from '../ui/src/resource-refs';

const HASH64 = 'a'.repeat(64);

afterEach(() => {
  __resetResourceRefRecognizers();
});

function docText(blocks: string[], extraFront: Record<string, string> = {}): string {
  const front = [`${FORMAT_KEY}: ${SPACES_DOC_VERSION}`];
  for (const [k, v] of Object.entries(extraFront)) front.push(`${k}: ${v}`);
  return ['---', ...front, '---', '', ...blocks, ''].join('\n');
}

describe('spaces-doc pipeline: parse to data nodes', () => {
  it('parses spaces-doc.v1 frontmatter + block directives into data records', () => {
    const text = docText(
      [':::block{id="b1" parent="root" sort="m" type="heading"}', '# Title', ':::', '', ':::block{id="b2" parent="b1" sort="n" type="paragraph"}', 'Body prose.', ':::'],
      { space_id: 'space-1' },
    );
    const parsed = parseSpacesDoc(text);

    expect(parsed.format).toBe(SPACES_DOC_VERSION);
    expect(parsed.frontmatter.space_id).toBe('space-1');
    expect(parsed.blocks).toHaveLength(2);

    const [b1, b2] = parsed.blocks;
    expect(b1).toMatchObject({ id: 'b1', parentId: null, blockType: 'heading', sortKey: 'm' });
    expect(b1.markdown).toContain('# Title');
    expect(b1.html).toContain('<h1');

    expect(b2).toMatchObject({ id: 'b2', parentId: 'b1', blockType: 'paragraph', sortKey: 'n' });
    expect(b2.markdown).toContain('Body prose.');
  });

  it('round-trips a C12-exported tree: block identity survives the parse path', () => {
    const tree: DocTree = {
      frontmatter: { space_id: 'sp' },
      blocks: [
        { id: 'r', parent_id: null, block_type: 'heading', item_id: null, sort_key: 'a', markdown: '# Heading' },
        { id: 'c', parent_id: 'r', block_type: 'paragraph', item_id: null, sort_key: 'b', markdown: 'Child text.' },
      ],
    };
    const parsed = parseSpacesDoc(exportDocument(tree));
    expect(parsed.blocks.map((b) => b.id)).toEqual(['r', 'c']);
    expect(parsed.blocks.map((b) => b.parentId)).toEqual([null, 'r']);
    expect(parsed.blocks.map((b) => b.blockType)).toEqual(['heading', 'paragraph']);
  });

  it('surfaces inline ref directives as classified data nodes', () => {
    const text = docText([
      ':::block{id="b1" parent="root" sort="m" type="paragraph"}',
      `See :ref[the artifact]{href="artifact:sha256:${HASH64}"} for details.`,
      ':::',
    ]);
    const parsed = parseSpacesDoc(text);
    expect(parsed.refs).toHaveLength(1);
    const ref = parsed.refs[0];
    expect(ref.directive).toBe('ref');
    expect(ref.kind).toBe('artifact');
    expect(ref.canonical).toBe(`artifact:sha256:${HASH64}`);
    expect(ref.label).toBe('the artifact');
    // The C6 shared parser also classifies it (extension installed by pipeline).
    expect(ref.resource).not.toBeNull();
    expect(ref.resource!.kind).toBe('artifact');
    // It is data, not executable: no html is generated for the directive node.
    expect(parsed.blocks[0].refs).toHaveLength(1);
  });

  it('records an embed container directive as an embed ref data node', () => {
    const text = docText([
      ':::block{id="b1" parent="root" sort="m" type="artifact_embed" item="repo://r@main/x"}',
      ':::embed{href="repo://r@main/x"}',
      ':::',
      ':::',
    ]);
    const parsed = parseSpacesDoc(text);
    expect(parsed.blocks[0].itemId).toBe('repo://r@main/x');
    const embed = parsed.refs.find((r) => r.directive === 'embed');
    expect(embed).toBeTruthy();
    expect(embed!.kind).toBe('repo');
  });

  it('classifies an unknown ref scheme as a retained, inert placeholder', () => {
    const text = docText([
      ':::block{id="b1" parent="root" sort="m" type="paragraph"}',
      'Bad :ref[x]{href="weird:thing"} here.',
      ':::',
    ]);
    const parsed = parseSpacesDoc(text);
    const ref = parsed.refs[0];
    expect(ref.kind).toBe('unknown');
    expect(parsed.diagnostics.some((d) => d.kind === 'unresolved_reference')).toBe(true);
  });

  it('does not throw on malformed / non-spaces-doc input', () => {
    expect(() => parseSpacesDoc('')).not.toThrow();
    expect(() => parseSpacesDoc('just some loose **markdown** text')).not.toThrow();
    const loose = parseSpacesDoc('plain prose, no frontmatter');
    expect(loose.format).toBeNull();
    expect(loose.html).toContain('plain prose');
  });

  it('preserves unknown directive prose without minting block identity', () => {
    const parsed = parseSpacesDoc(docText([
      ':::note',
      'Some prose with [issue:abc1234].',
      ':::',
    ]));

    expect(parsed.html).toContain('Some prose with [issue:abc1234].');
    expect(parsed.refs).toEqual([]);
    expect(parsed.blocks).toEqual([]);
    const diagnostics = parsed.diagnostics.filter((d) => d.kind === 'unknown_directive');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].detail).toContain(':::note');
  });

  it('does not render unknown directive fences as literal prose', () => {
    const parsed = parseSpacesDoc(docText([
      ':::warning',
      `Careful :ref[artifact]{href="artifact:sha256:${HASH64}"}.`,
      ':::',
    ]));

    expect(parsed.html).toContain('Careful artifact.');
    expect(parsed.html).not.toContain(':::warning');
    expect(parsed.html).not.toContain(':::');
    expect(parsed.refs.map((ref) => ref.canonical)).toEqual([`artifact:sha256:${HASH64}`]);
  });

  it('preserves mixed fragment order and separates directive and prose diagnostics', () => {
    const parsed = parseSpacesDoc(docText([
      ':::block{id="b1" parent="root" sort="m" type="paragraph"}',
      'First block.',
      ':::',
      '',
      ':::note',
      'Second directive.',
      ':::',
      '',
      'Third loose prose.',
    ]));

    expect(parsed.html.indexOf('First block.')).toBeLessThan(parsed.html.indexOf('Second directive.'));
    expect(parsed.html.indexOf('Second directive.')).toBeLessThan(parsed.html.indexOf('Third loose prose.'));
    expect(parsed.diagnostics.filter((d) => d.kind === 'unknown_directive')).toHaveLength(1);
    expect(parsed.diagnostics.filter((d) => d.kind === 'non_block_prose')).toHaveLength(1);
  });
});

describe('spaces-doc pipeline: renderer security (standing AC #2)', () => {
  it('strips <script> tags from rendered prose', () => {
    const html = renderProseToSafeHtml('Hello <script>alert(1)</script> world');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('alert(1)');
  });

  it('strips inline event handlers and javascript: hrefs', () => {
    const html = renderProseToSafeHtml('<img src=x onerror="alert(1)"> [x](javascript:alert(1))');
    const lower = html.toLowerCase();
    expect(lower).not.toContain('onerror');
    expect(lower).not.toContain('javascript:');
  });

  it('removes <iframe> smuggled into document prose (iframes reserved for artifact preview only)', () => {
    const html = renderProseToSafeHtml('text <iframe src="https://evil.example" sandbox="allow-scripts"></iframe> more');
    expect(html.toLowerCase()).not.toContain('<iframe');
    expect(html.toLowerCase()).not.toContain('allow-scripts');
  });

  it('a hostile document directive yields ONLY inert data + script-free HTML', () => {
    const text = docText([
      ':::block{id="x" parent="root" sort="m" type="paragraph"}',
      'Evil <script>steal()</script> and :ref[x]{href="javascript:alert(1)"} and <img src=x onerror=alert(1)>.',
      ':::',
    ]);
    const parsed = parseSpacesDoc(text);

    // The directive ref is inert data, classified unknown (a js: href is not a ref).
    const jsRef = parsed.refs.find((r) => r.canonical === 'javascript:alert(1)');
    expect(jsRef).toBeTruthy();
    expect(jsRef!.kind).toBe('unknown');

    // No script-bearing surface survives in any rendered HTML.
    const allHtml = (parsed.html + parsed.blocks.map((b) => b.html).join('\n')).toLowerCase();
    expect(allHtml).not.toContain('<script');
    expect(allHtml).not.toContain('onerror=');
    expect(allHtml).not.toContain('javascript:');
    expect(allHtml).not.toContain('steal()');
  });

});
