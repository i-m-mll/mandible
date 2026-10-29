export const detailKeys = {
  issues: ['issue-detail'] as const,
  issue: (id: string | null, repo?: string) => {
    const ref = id?.trim().replace(/^issue:/i, '') ?? null;
    return ['issue-detail', ref, ref && /^[a-f0-9]{64}$/i.test(ref) ? null : repo ?? null] as const;
  },
  artifacts: ['artifact'] as const,
  resolution: (ref: string | null) => ['artifact', 'resolution', ref] as const,
  versions: (ref: string | null) => ['artifact', 'versions', ref] as const,
  record: (id: string | null) => ['artifact', 'record', id] as const,
  content: (id: string | null) => ['artifact', 'content', id] as const,
  backrefs: (id: string | null) => ['artifact', 'backrefs', id] as const,
  list: (params: object) => ['artifact', 'list', params] as const,
};

export function detailKeysForEvent(type: string) {
  const families: (typeof detailKeys.issues | typeof detailKeys.artifacts)[] = [];
  if (/^(ledger:|session:|console:session:|work:|push:|conversation:|space:|artifact:|briefing:|auth:)/.test(type) && type !== 'auth:output') {
    families.push(detailKeys.issues);
  }
  if (type.startsWith('artifact:') || type === 'briefing:round-published') families.push(detailKeys.artifacts);
  return families;
}
