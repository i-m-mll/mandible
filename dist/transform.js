// Transform service: spawns a Claude CLI process to transform exported
// conversation content (e.g., summarize, clean up, reformat).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
const SMALL_TIMEOUT_MS = 5 * 60 * 1000;
const LARGE_TIMEOUT_MS = 10 * 60 * 1000;
// Rough threshold: ~100k tokens at ~4 chars/token ≈ 400k chars
const LARGE_CONTENT_THRESHOLD = 400_000;
export async function transformContent(options) {
    const { content, prompt, timeoutMs } = options;
    const timeout = timeoutMs ?? (content.length > LARGE_CONTENT_THRESHOLD ? LARGE_TIMEOUT_MS : SMALL_TIMEOUT_MS);
    // Write content to temp file so we can reference it in the prompt
    const tmpDir = path.join(os.tmpdir(), "mandible-transform");
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${randomUUID()}.md`);
    await fs.promises.writeFile(tmpFile, content, "utf8");
    const startTime = Date.now();
    try {
        const fullPrompt = `${prompt}\n\nThe content to transform is in the file: ${tmpFile}\nRead the file and apply the transformation. Output ONLY the transformed content, nothing else.`;
        const output = await spawnClaude(fullPrompt, timeout);
        return {
            output: output.trim(),
            duration_ms: Date.now() - startTime,
        };
    }
    finally {
        // Clean up temp file
        try {
            await fs.promises.unlink(tmpFile);
        }
        catch {
            // ignore cleanup errors
        }
    }
}
function spawnClaude(prompt, timeoutMs) {
    return new Promise((resolve, reject) => {
        const proc = spawn("claude", ["-p", prompt, "--output-format", "text"], {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: timeoutMs,
            env: { ...process.env },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        proc.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        proc.on("close", (code) => {
            if (code === 0) {
                resolve(stdout);
            }
            else {
                reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
            }
        });
        proc.on("error", (error) => {
            reject(new Error(`Failed to spawn claude: ${error.message}`));
        });
    });
}
