import path from "node:path";

// Issue a28c479 — the two artifact ingest routes (provider-artifacts.ts for
// CLI/API ingest, repo-artifact-scanner.ts for repo scans) each carried their
// own extension→media-type switch and had drifted: the same file could be
// registered as `application/octet-stream` by one route and as a real media
// type by the other. This module is the single table both routes use; it takes
// no dependency beyond node:path so any ingest path can import it.
//
// Media types are stamped onto artifact rows at ingest time, so changing this
// table only affects artifacts registered from here on; existing rows keep the
// media type they were ingested with.
const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".htm": "text/html",
  ".html": "text/html",
  ".ipynb": "application/x-ipynb+json",
  ".json": "application/json",
  ".jsonl": "application/json",
  ".log": "text/plain",
  ".markdown": "text/markdown",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".toml": "application/toml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export const DEFAULT_ARTIFACT_MEDIA_TYPE = "application/octet-stream";

/**
 * Resolve the media type an artifact should be ingested with, from its file
 * extension. Unknown extensions fall back to the generic binary media type.
 */
export function mediaTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return MEDIA_TYPES_BY_EXTENSION[extension] ?? DEFAULT_ARTIFACT_MEDIA_TYPE;
}
