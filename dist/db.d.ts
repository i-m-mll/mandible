import Database from "better-sqlite3";
export type Db = Database.Database;
export declare function getDbPath(): string;
export declare function openDb(dbPath?: string): Db;
export declare function migrate(db: Db): void;
export declare function getDb(dbPath?: string): Db;
export declare function setDb(db: Db): void;
export type PrefixResult = {
    ok: true;
    id: string;
} | {
    ok: false;
    error: "not_found";
} | {
    ok: false;
    error: "ambiguous";
    count: number;
};
/**
 * Resolve a UUID prefix to a full ID. If the prefix is already a full UUID
 * (36 chars), does an exact match. Otherwise, does a prefix match with LIKE.
 *
 * Returns the resolved full ID, or an error indicating not_found / ambiguous.
 */
export declare function resolvePrefix(db: Db, table: string, idColumn: string, prefix: string): PrefixResult;
