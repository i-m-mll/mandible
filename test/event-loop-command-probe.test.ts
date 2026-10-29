import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { useCommandProbe } from "./helpers/event-loop-blocking.js";

it("acknowledges every async invocation and preserves command arguments, streams and status", async () => {
  const probe = await useCommandProbe(["sh"]);
  const result = await probe.run(() => new Promise<{ stdout: string; stderr: string; code: number | string | undefined }>(resolve => {
    const child = execFile("sh", ["-c", 'cat; printf "%s" "$1"; printf diagnostic >&2; exit 7', "fixture", "an argument ' with spaces"], (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error?.code });
    });
    child.stdin!.end("input\n");
  }));
  expect(result).toEqual({ stdout: "input\nan argument ' with spaces", stderr: "diagnostic", code: 7 });
  await probe.run(() => new Promise<void>((resolve, reject) => {
    execFile("sh", ["-c", "exit 0"], error => error ? reject(error) : resolve());
  }));
});

it("fails a supervised synchronous invocation even when the caller consumes its error", async () => {
  const probe = await useCommandProbe({ fixture: 'touch "$1"' });
  const marker = path.join(probe.dir, "executed");
  const result = spawnSync("fixture", [marker], { encoding: "utf8", timeout: 2_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(124);
  expect(fs.existsSync(marker)).toBe(false);
  await expect(probe.close()).rejects.toThrow("event loop did not acknowledge invocation");
});

it("keeps cancellation on the caller's real command handle after acknowledgement", async () => {
  const probe = await useCommandProbe(["sh"]);
  await probe.run(() => new Promise<void>((resolve, reject) => {
    const child = execFile("sh", ["-c", 'printf ready; exec sleep 30'], error => {
      try {
        expect(error).toMatchObject({ signal: "SIGTERM", killed: true });
        resolve();
      } catch (failure) { reject(failure); }
    });
    child.stdout!.once("data", () => child.kill("SIGTERM"));
  }));
});

it("cancels a held handshake before deleting its journals and settles its operation", async () => {
  const probe = await useCommandProbe({ fixture: 'touch "$1"' }, { hold: true });
  await expect(probe.nextInvocation(Promise.reject(new Error("dispatch rejected")))).rejects.toThrow("dispatch rejected");
  const marker = path.join(probe.dir, "executed");
  const operation = new Promise<{ code: number | string | undefined; stderr: string }>(resolve => {
    execFile("fixture", [marker], (error, _stdout, stderr) => resolve({ code: error?.code, stderr }));
  });
  await probe.nextInvocation(operation);
  await expect(probe.close()).rejects.toThrow("Command probe failed");
  expect(await operation).toEqual({ code: 124, stderr: "Command probe: fixture: probe closed before acknowledgement\n" });
  expect(fs.existsSync(probe.dir)).toBe(false);
});
