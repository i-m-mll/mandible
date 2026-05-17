import type { Db } from "../db.js";
import type { LedgerNamespacePolicy, LedgerProject, LedgerProjectCheckout } from "./types.js";
export interface ResolveProjectInput {
    root: string;
    name?: string;
    workRepoId?: string | null;
    defaultBranch?: string;
    remoteUrl?: string | null;
    upstreamUrl?: string | null;
    namespacePolicy?: LedgerNamespacePolicy;
}
export interface ResolvedLedgerProject {
    project: LedgerProject;
    checkout: LedgerProjectCheckout;
}
export declare function normalizeRemoteIdentity(remoteUrl: string | null | undefined): string;
export declare function readOriginRemote(root: string): string;
export declare function resolveProjectForCheckout(db: Db, input: ResolveProjectInput, now?: number): ResolvedLedgerProject;
