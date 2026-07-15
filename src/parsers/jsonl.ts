import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as readline from "node:readline";

export interface JsonlFileRecords<T> {
  records: T[];
  sourceHash: string;
}

function parseJsonlLine<T>(line: string, records: T[]): void {
  if (!line.trim()) return;
  try {
    records.push(JSON.parse(line) as T);
  } catch {
    // A provider may be interrupted halfway through its final JSONL row.
  }
}

/**
 * Parse JSONL without retaining a whole-file string or a second full line array.
 * Parsed records remain in memory because the provider parsers currently make
 * multiple ordered passes over them, but raw source bytes are released by the
 * stream as soon as each line is decoded.
 */
export async function readJsonlFileRecords<T>(filePath: string): Promise<JsonlFileRecords<T>> {
  const records: T[] = [];
  const sourceHash = crypto.createHash("sha256");
  const input = fs.createReadStream(filePath);
  input.on("data", (chunk) => {
    sourceHash.update(chunk);
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    parseJsonlLine<T>(line, records);
  }

  return { records, sourceHash: sourceHash.digest("hex") };
}

/** Parse an append-sized JSONL string without allocating an array of lines. */
export function parseJsonlStringRecords<T>(raw: string): T[] {
  const records: T[] = [];
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf("\n", start);
    const end = newline === -1 ? raw.length : newline;
    parseJsonlLine<T>(raw.slice(start, end), records);
    if (newline === -1) break;
    start = newline + 1;
  }
  return records;
}
