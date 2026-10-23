import type { AuthChangeKind, AuthChangeReport } from '../../src/contracts';

export function authBreakdownFixture(count = 96): AuthChangeReport {
  const kinds: AuthChangeKind[] = ['added', 'deleted', 'modified', 'renamed', 'copied', 'type_changed'];
  const files = Array.from({ length: count }, (_, index) => {
    const change_kind = kinds[index % kinds.length]!;
    const newPath = `src/a-long-reviewed-directory/full-file-path-${String(index).padStart(3, '0')}-with-a-readable-name.ts`;
    const nonText = index === 2 || index === 14;
    return {
      old_path: change_kind === 'added' ? null : ['renamed', 'copied'].includes(change_kind) ? `previous/location/file-${index}.ts` : newPath,
      new_path: change_kind === 'deleted' ? null : newPath,
      change_kind,
      file_type_before: change_kind === 'added' ? 'absent' as const : index === 14 ? 'gitlink' as const : index === 8 ? 'symlink' as const : 'blob' as const,
      file_type_after: change_kind === 'deleted' ? 'absent' as const : index === 14 ? 'gitlink' as const : index === 8 ? 'symlink' as const : 'blob' as const,
      additions: nonText ? null : index + 1,
      deletions: nonText ? null : index % 7,
      bytes_before: index === 2 ? 2048 : null,
      bytes_after: index === 2 ? 4096 : null,
      language: 'TypeScript', file_role: 'implementation' as const,
      generated: index === 3, vendor: index === 4,
    };
  });
  return {
    schema: 'mandible-auth-change-report@1', classifier_version: 'mandible-auth-change-classifier@1',
    rules_version: 'mandible-auth-change-rules@1', rename_similarity_percent: 50,
    comparison: { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), merge_base_sha: 'a'.repeat(40) },
    totals: { files: files.length, additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0), text_files: files.filter(file => file.additions !== null).length, binary_files: files.filter(file => file.additions === null && file.file_type_before !== 'gitlink' && file.file_type_after !== 'gitlink').length }, files,
  };
}
