// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { useState } from 'preact/hooks';
import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeAuthMergeReviewMetadata } from '../src/auth-context';
import { mapRow } from '../src/auth-request-row';
import { readGitFilePair } from '../src/git-change-review';
import { appendRequestNarrativeAnswer, ensureRequestReviewRound, readRequestReview, requestReviewRound } from '../src/feedback/request-review';
import { mutateRequestDraft } from '../src/feedback/request-drafts';
import { createUser } from '../src/users/store';
import { clearApiGetCache, getAuthDiffFile } from '../ui/src/api';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import { ChangeList } from '../ui/src/components/ChangeList';
import { AuthReviewNarrative } from '../ui/src/views/AuthReviewNarrative';
import { AuthReviewTextFile, useAuthRequestReview } from '../ui/src/views/AuthRequestReview';
import { createMigratedDb } from './helpers/ledger-fixtures';
import { authCliRepo } from './helpers/prepared-git-fixture';
import { testRuntimeRoot } from './helpers/runtime-isolation';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from './helpers/dom';
import { establishTestClientAccess } from './helpers/local-client-access';

it('reviews changed Git text beside its reasons and uses the same draft in file order', async () => {
  const root = mkdtempSync(join(testRuntimeRoot, 'narrative-repo-'));
  authCliRepo.copyInto(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, timeout: 5000 });
  const writeFile = (file: string, value: string) => writeFileSync(join(root, file), value);
  const first = 'first.md';
  const second = 'second.md';
  const before = '## Local base\n\nUnchanged\n\nReconcile on startup.\n';
  const proposed = '## Snapshot custody\n\nUnchanged\n\nReconcile after refresh.\n';
  writeFile(first, before);
  writeFile(second, 'Report the old lifecycle.\n');
  git('add', first, second);
  git('commit', '-m', 'Pin the real comparison');
  const branch = 'feature/review';
  git('checkout', '-b', branch);
  writeFile(first, proposed);
  writeFile(second, 'Report the current lifecycle.\n');
  git('add', first, second);
  git('commit', '-m', 'Propose the reviewed changes');
  const { changeReport } = await computeAuthMergeReviewMetadata(root, 'main', branch);
  const paths = changeReport.files.map(file => file.new_path);
  const narrative = [
    'Show delivery before custody.',
    ':::change{path="second.md"}\nReport the current lifecycle.\n:::',
    'Pinning makes the evidence reproducible.',
    ':::change{path="first.md"}\nSnapshot custody\n:::',
    ':::change{path="first.md"}\ne\n:::',
    ':::change{path="../outside.md"}\nDo not load this path.\n:::',
    ':::spec-item{key="context" type="verdict" required="false"}\nIs this enough context?\n:::',
    '',
  ].join('\r\n\r\n');
  const db = createMigratedDb();
  const operator = createUser(db, { slug: 'narrative-operator', kind: 'human', display_name: 'Reviewer' });
  const statement = db.prepare(`INSERT INTO auth_requests
    (id, command, title, cwd, target_repo_root, created_at, updated_at, expires_at, change_report_json,
     merge_head_sha, files_changed, additions, deletions, narrative)
    VALUES ('review-narrative', 'mandible auth merge feature/review --into main', 'Review', ?, ?, 1, 1, 2, ?, ?, ?, ?, ?, ?)
    RETURNING *`);
  const { files, additions, deletions } = changeReport.totals;
  const request = mapRow(statement.get(root, root, JSON.stringify(changeReport), changeReport.comparison.head_sha,
    files, additions, deletions, narrative) as Record<string, unknown>);
  const round = requestReviewRound(request);
  ensureRequestReviewRound(db, round);
  await establishTestClientAccess();
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  const loads: number[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const match = /\/files\/(\d+)/.exec(url);
    if (match) {
      const index = Number(match[1]);
      loads.push(index);
      const result = await readGitFilePair(root, changeReport.comparison, changeReport.files[index]);
      if (!result.ok) throw new Error(result.error);
      return json(result.file);
    }
    if (url.endsWith('/review')) return json({
      ...await readRequestReview(db, request, operator.id),
      precondition: { expected_revision: 1, expected_custody_generation: 0 }, status: 'pending',
    });
    const body = init?.body && JSON.parse(String(init.body));
    if (url.endsWith('/answers')) return json({ response_event_id: db.transaction(() =>
      appendRequestNarrativeAnswer(db, request, round, operator.id, body.directive_key, body.mutation, 2))() });
    if (url.endsWith('/drafts')) {
      const result = mutateRequestDraft(db, request.id, operator.id, body.path, body.expected_generation, proposed, body.mutation);
      if (!result.ok) throw new Error(result.reason);
      return json(result.draft);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  function Review() {
    const review = useAuthRequestReview(request.id, 'pending', request.updated_at, 1, true, () => undefined);
    const [files, setFiles] = useState(false);
    if (!review.data?.narrative) return null;
    return <>
      <button type="button" onClick={() => setFiles(true)}>File order</button>
      {files ? <ChangeList files={changeReport.files} scope="narrative-fixture" ariaLabel="File order changes"
        loadFile={(_file, index, signal) => getAuthDiffFile(request.id, index, signal)}
        renderTextFile={(_file, pair, index, view) => <AuthReviewTextFile review={review} pair={pair} index={index} view={view} />} /> :
        <AuthReviewNarrative id={request.id} review={review} onFile={() => setFiles(true)} />}
    </>;
  }
  try {
    render(<Review />);
    await screen.findByRole('textbox', { name: second });
    await waitFor(() => expect(screen.getAllByRole('textbox', { name: first })).toHaveLength(2));
    const beforeEdit = screen.getAllByRole('textbox', { name: first });
    const compare = beforeEdit.find(editor => editor.textContent?.includes('Snapshot'));
    expect(compare?.textContent).toContain('Local base');
    expect(beforeEdit.some(editor => editor.textContent?.includes('refresh'))).toBe(true);
    const groups = screen.getAllByRole('region').filter(region => paths.includes(region.getAttribute('aria-label') ?? ''));
    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual([second, first, first, first]);
    expect(within(groups[2]).queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('link', { name: '../outside.md' })).toBeNull();
    expect([...loads].sort()).toEqual([0, 1]);

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(db.prepare("SELECT value_json FROM briefing_response_events").get()).toEqual({ value_json: '{"verdict":"keep"}' }));
    const edit = within(groups[1]).getByRole('textbox', { name: first });
    const editor = EditorView.findFromDOM(edit.closest('.cm-editor') as HTMLElement)!;
    vi.spyOn(editor, 'coordsAtPos').mockReturnValue({ left: 64, right: 68, top: 64, bottom: 80 });
    const offset = editor.state.doc.toString().indexOf('Snapshot custody');
    act(() => editor.dispatch({ selection: { anchor: offset, head: offset + 'Snapshot custody'.length } }));
    const rail = await within(groups[1]).findByRole('toolbar', { name: 'Selection actions' });
    fireEvent.click(within(rail).getByRole('button', { name: 'Edit', exact: true }));
    expect(edit.getAttribute('contenteditable')).toBe('true');
    act(() => editor.dispatch({ changes: { from: offset, to: offset + 'Snapshot custody'.length, insert: 'Review custody' } }));

    fireEvent.click(screen.getByRole('button', { name: 'File order' }));
    const fileEditor = await screen.findByRole('textbox', { name: `${first} after` });
    expect(fileEditor.textContent).toContain('Review custody');
    await waitFor(() => expect(db.prepare("SELECT text FROM request_review_drafts").get())
      .toEqual({ text: proposed.replace('Snapshot custody', 'Review custody') }));
  } finally {
    cleanup();
    clearApiGetCache();
    __resetBrowserSessionForTests();
    vi.unstubAllGlobals();
    db.close();
  }
});
