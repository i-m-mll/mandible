/**
 * Compress a text string to a gzipped Buffer for storage as a BLOB.
 * Uses compression level 6 (default) — good balance of speed and ratio.
 */
export declare function compressContent(text: string): Buffer;
/**
 * Async variant of compressContent — avoids blocking the event loop.
 * Use this outside db.transaction() calls to pre-compress before writing.
 */
export declare function compressContentAsync(text: string): Promise<Buffer>;
/**
 * Decompress content from a conversation_blocks row.
 * Handles both compressed (Buffer) and uncompressed (string) data transparently.
 */
export declare function decompressContent(data: Buffer | string, isCompressed: boolean): string;
