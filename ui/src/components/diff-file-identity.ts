export type DiffFileIdentity = { oldPath: string | null; newPath: string | null };

export function diffFileKey(file: DiffFileIdentity): string {
  return JSON.stringify([file.oldPath, file.newPath]);
}
