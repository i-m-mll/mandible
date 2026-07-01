import { Worker } from "node:worker_threads";

export const ARTIFACT_CONTENT_WORKER_MIN_BYTES = 16 * 1024;

type ArtifactContentWorkerRequest =
  | { kind: "format-json"; text: string }
  | { kind: "sha256-file"; filePath: string };

type ArtifactContentWorkerResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const WORKER_SOURCE = `
const crypto = require("node:crypto");
const fs = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");

try {
  const request = workerData;
  if (request.kind === "format-json") {
    try {
      parentPort.postMessage({ ok: true, value: JSON.stringify(JSON.parse(request.text), null, 2) });
    } catch {
      parentPort.postMessage({ ok: true, value: null });
    }
  } else if (request.kind === "sha256-file") {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(request.filePath)).digest("hex");
    parentPort.postMessage({ ok: true, value: hash });
  } else {
    parentPort.postMessage({ ok: false, error: "unknown artifact content worker request" });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
`;

export async function formatJsonPreviewOffThread(text: string): Promise<string | null> {
  return runArtifactContentWorker<string | null>({ kind: "format-json", text });
}

export async function hashFileSha256OffThread(filePath: string): Promise<string> {
  return runArtifactContentWorker<string>({ kind: "sha256-file", filePath });
}

function runArtifactContentWorker<T>(request: ArtifactContentWorkerRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: request,
    });

    worker.once("message", (message: ArtifactContentWorkerResponse<T>) => {
      if (message.ok) {
        resolve(message.value);
      } else {
        reject(new Error(message.error));
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`artifact content worker exited with code ${code}`));
    });
  });
}
