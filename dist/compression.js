// Gzip compression helpers for conversation_blocks.content storage.
// Bug: e5a945d — reduce DB size by ~76% via transparent content compression.
import { gzipSync, gunzipSync, gzip } from "node:zlib";
import { promisify } from "node:util";
const gzipAsync = promisify(gzip);
/**
 * Compress a text string to a gzipped Buffer for storage as a BLOB.
 * Uses compression level 6 (default) — good balance of speed and ratio.
 */
export function compressContent(text) {
    return gzipSync(Buffer.from(text, "utf-8"), { level: 6 });
}
/**
 * Async variant of compressContent — avoids blocking the event loop.
 * Use this outside db.transaction() calls to pre-compress before writing.
 */
export async function compressContentAsync(text) {
    return gzipAsync(Buffer.from(text, "utf-8"), { level: 6 });
}
/**
 * Decompress content from a conversation_blocks row.
 * Handles both compressed (Buffer) and uncompressed (string) data transparently.
 */
export function decompressContent(data, isCompressed) {
    if (!isCompressed || typeof data === "string") {
        return typeof data === "string" ? data : data.toString("utf-8");
    }
    return gunzipSync(data).toString("utf-8");
}
