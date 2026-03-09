// Stub — will be replaced when P2 (feature/graphview__renderer) merges into integration branch
import type { JSX } from 'preact';
export type GraphNodeType = 'session' | 'issue' | 'auth_request' | 'branch';
export function GraphView(_props: {
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void;
  refreshToken?: number;
}): JSX.Element {
  return <div className="graph-view" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>Graph view loading…</div>;
}
