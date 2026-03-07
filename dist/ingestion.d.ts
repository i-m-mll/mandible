import type { Logger } from "./types.js";
export declare function startIngestion(log: Logger): void;
export declare function stopIngestion(): void;
/** Manually trigger re-ingestion of all known sources. */
export declare function triggerFullIngest(): Promise<{
    processed: number;
    errors: number;
}>;
