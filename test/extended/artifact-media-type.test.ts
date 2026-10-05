import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_ARTIFACT_MEDIA_TYPE, mediaTypeForPath } from "../../src/artifact-media-type.js";

// Issue a28c479 — provider-artifacts.ts and repo-artifact-scanner.ts each had
// their own extension table and disagreed on .ipynb, .markdown and .log, so
// the media type an artifact got depended on which ingest route registered it.
describe("mediaTypeForPath", () => {
  it("resolves the previously contested extensions one way", () => {
    expect(mediaTypeForPath("/tmp/analysis.ipynb")).toBe("application/x-ipynb+json");
    expect(mediaTypeForPath("/tmp/notes.markdown")).toBe("text/markdown");
    expect(mediaTypeForPath("/tmp/daemon.log")).toBe("text/plain");
  });

  it("keeps the union of both former tables", () => {
    const expected: Record<string, string> = {
      "a.csv": "text/csv",
      "a.htm": "text/html",
      "a.html": "text/html",
      "a.json": "application/json",
      "a.jsonl": "application/json",
      "a.md": "text/markdown",
      "a.pdf": "application/pdf",
      "a.toml": "application/toml",
      "a.tsv": "text/tab-separated-values",
      "a.txt": "text/plain",
      "a.yaml": "application/yaml",
      "a.yml": "application/yaml",
    };
    for (const [name, mediaType] of Object.entries(expected)) {
      expect(mediaTypeForPath(name), name).toBe(mediaType);
    }
  });

  it("is case-insensitive and falls back for unknown or extensionless paths", () => {
    expect(mediaTypeForPath("/tmp/REPORT.MD")).toBe("text/markdown");
    expect(mediaTypeForPath("/tmp/model.safetensors")).toBe(DEFAULT_ARTIFACT_MEDIA_TYPE);
    expect(mediaTypeForPath("/tmp/Makefile")).toBe(DEFAULT_ARTIFACT_MEDIA_TYPE);
  });

});
