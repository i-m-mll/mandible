export interface TransformOptions {
    content: string;
    prompt: string;
    /** Timeout in milliseconds. Default: 5 min for small, 10 min for large. */
    timeoutMs?: number;
}
export interface TransformResult {
    output: string;
    duration_ms: number;
}
export declare function transformContent(options: TransformOptions): Promise<TransformResult>;
