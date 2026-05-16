import type { Db } from "./db.js";
import type { ArtifactRecord, GraphAction, GraphEdge, GraphMode, GraphNode, ProviderManifestRecord, ProviderRecord } from "./types.js";
type JsonRecord = Record<string, unknown>;
interface ProviderInput {
    id?: string;
    provider_id?: string;
    display_name?: string;
    name?: string;
    version?: string;
    status?: string;
    transport?: string;
    endpoint?: string;
    capabilities?: JsonRecord;
    actions?: GraphAction[];
    source?: string;
}
interface ArtifactInput {
    provider_id?: string;
    manifest_id?: string;
    role?: string;
    media_type?: string;
    filename?: string;
    metadata?: JsonRecord;
    pinned?: boolean;
    content?: string;
    content_base64?: string;
    json?: unknown;
}
interface ManifestInput {
    provider_id?: string;
    provider?: ProviderInput;
    manifest?: JsonRecord;
    manifest_type?: string;
    version?: string;
    source?: string;
}
export interface IndexedGraphOptions {
    mode: GraphMode;
    providerId?: string;
    root?: string;
    limit?: number;
}
export interface IndexedGraphResult {
    nodes: GraphNode[];
    edges: GraphEdge[];
}
export declare function getArtifactRoot(): string;
export declare function registerProvider(db: Db, input: ProviderInput, now?: number): ProviderRecord;
export declare function ingestArtifact(db: Db, input: ArtifactInput, now?: number, artifactRoot?: string): ArtifactRecord;
export declare function ingestProviderManifest(db: Db, input: ManifestInput, now?: number, artifactRoot?: string): ProviderManifestRecord;
export declare function listProviders(db: Db): ProviderRecord[];
export declare function getProvider(db: Db, id: string): ProviderRecord | null;
export declare function getArtifact(db: Db, id: string): ArtifactRecord | null;
export declare function getProviderManifest(db: Db, id: string): ProviderManifestRecord | null;
export declare function getProviderDetail(db: Db, id: string): {
    provider: ProviderRecord;
    manifests: ProviderManifestRecord[];
    artifacts: ArtifactRecord[];
} | null;
export declare function getIndexedGraph(db: Db, options: IndexedGraphOptions): IndexedGraphResult;
export declare function getIndexedGraphCount(db: Db, mode: GraphMode): number;
export {};
