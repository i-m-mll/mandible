import type { SessionRegistry } from "./registry.js";
import type { Logger } from "./types.js";
export declare class NavMetadataEnricher {
    private readonly registry;
    private readonly logger;
    private timer;
    private running;
    constructor(registry: SessionRegistry, logger: Logger);
    start(): void;
    stop(): void;
    private tick;
    private resolveSession;
    private recordFailure;
    private describeError;
}
