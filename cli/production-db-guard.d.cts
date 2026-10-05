export const PRODUCTION_DB_PATH: string;
export const LEGACY_PRODUCTION_DB_PATH: string;
export const PRODUCTION_OPERATIONAL_LOG_DB_PATH: string;
export const PRODUCTION_DB_PATHS: readonly string[];
export function resolvesToProductionDbPath(dbPath: string, productionPath?: string): boolean;
export function resolvesToAnyProductionDbPath(dbPath: string, productionPaths?: readonly string[]): string | null;
export function assertNotProductionDbUnderTest(dbPath: string, productionPaths?: readonly string[] | string): void;
