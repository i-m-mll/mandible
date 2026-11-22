import { useMemo } from 'preact/hooks';
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import { ChangeInventoryList, type ChangeListFile, type ChangeListProps } from './ChangeList';

function toFile(file: FileDiffMetadata): ChangeListFile {
  return {
    old_path: file.type === 'new' ? null : file.prevName ?? file.name,
    new_path: file.type === 'deleted' ? null : file.name,
    change_kind: file.type === 'new' ? 'added' : file.type === 'deleted' ? 'deleted' : file.prevName ? 'renamed' : 'modified',
    additions: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
    deletions: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
    patch: file,
  };
}

export function ParsedChangeList({ patch, contents, ...props }: ChangeListProps) {
  const files = useMemo(() => {
    try {
      if (contents) {
        if (contents.before.contents === contents.after.contents) return [];
        const file = toFile(parseDiffFromFile(contents.before, contents.after, {}, true));
        return [{ ...file, old_path: contents.before.name, new_path: contents.after.name }];
      }
      return parsePatchFiles(patch ?? '', { throwOnError: true }).flatMap(({ files }) => files.map(toFile));
    } catch {
      return null;
    }
  }, [patch, contents]);
  return files ? <ChangeInventoryList {...props} files={files} /> : <div role="alert">File changes unavailable</div>;
}
