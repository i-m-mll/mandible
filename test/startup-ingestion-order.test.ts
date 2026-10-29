import { describe, expect, it, vi } from "vitest";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startDaemon, startIngestionAfterStartupWorkScan, type DaemonHandle } from "../src/index.js";
import { WorkScanner } from '../src/work-scanner.js';
import { mintApiToken } from '../src/client-auth/tokens.js';
import { setupOperator } from '../src/users/store.js';
import { isDaemonReady, setDaemonReady } from '../src/lifecycle.js';
import { getUserHome } from '../src/platform-paths.js';
import { healthDocumentError } from '../scripts/local-runtime.mjs';
import { waitUntil } from './helpers/wait-until.js';
import { createAuthCheckRepo } from './helpers/auth-queue-fixtures.js';

describe("startup ingestion ordering", () => {
  it('serves authenticated ledger reads and mutations while the startup scan is pending, then scans and ingests normally', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-scan-'));
    fs.cpSync(createAuthCheckRepo(), path.join(root, 'repo'), { recursive: true });
    const transcriptDir = path.join(getUserHome(), '.claude/projects/readiness');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcript = path.join(transcriptDir, 'readiness-session.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'ready-user', sessionId: 'readiness-session',
      timestamp: new Date().toISOString(), cwd: root, message: { role: 'user', content: 'Ready before repository scanning finishes.' } })}\n`);
    vi.stubEnv('MANDIBLE_SOCKET', path.join(root, 'api.sock'));
    vi.stubEnv('MANDIBLE_WORK_SCANNER_ROOTS', JSON.stringify([root]));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalScan = WorkScanner.prototype.scanAllAsync;
    let scan!: ReturnType<WorkScanner['scanAllAsync']>;
    const pendingScan = vi.spyOn(WorkScanner.prototype, 'scanAllAsync').mockImplementationOnce(function (options) {
      scan = gate.then(() => originalScan.call(this, options));
      return scan;
    });
    let daemon: DaemonHandle | undefined;
    try {
      daemon = await startDaemon({ port: 0, dbPath: path.join(root, 'ledger.db'), pidFilePath: path.join(root, 'daemon.pid'),
        clientAuthDir: path.join(root, 'auth'), handleSignals: false });
      expect(pendingScan).toHaveBeenCalledOnce();
      const origin = `http://127.0.0.1:${daemon.port}`;
      const before = await (await fetch(`${origin}/api/health`)).json();
      expect(before).toMatchObject({ status: 'ok', ready: true, warm: false });
      expect(healthDocumentError(before, { installationId: before.instance.installation_id,
        publicOrigin: before.instance.public_origin, generation: before.instance.backend_generation })).toBeNull();
      const operator = setupOperator(daemon.db, { display_name: 'Readiness fixture' });
      const pepper = fs.readFileSync(path.join(root, 'auth/pepper'), 'utf8').trim();
      const token = mintApiToken(daemon.db, pepper, operator.id, { label: 'readiness-fixture' }).token;
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      expect((await fetch(`${origin}/api/settings`)).status).toBe(401);
      const written = await fetch(`${origin}/api/settings/readiness_fixture`, { method: 'PUT', headers, body: JSON.stringify({ value: 'served' }) });
      expect(written.status).toBe(200);
      expect(await (await fetch(`${origin}/api/settings/readiness_fixture`, { headers })).json()).toMatchObject({ value: 'served' });
      expect(daemon.db.prepare('SELECT id FROM conversations').get()).toBeUndefined();
      release();
      await expect(scan).resolves.toMatchObject({ scanned_repos: 1, missing_repos: [] });
      await waitUntil(() => daemon!.db.prepare('SELECT id FROM conversations').get(), 'startup conversation ingestion after the work scan');
      expect(await (await fetch(`${origin}/api/health`)).json()).toMatchObject({ ready: true, warm: true });
    } finally {
      release();
      if (daemon) await daemon.close();
      pendingScan.mockRestore(); vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it('does not report ready when critical database startup fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-failure-'));
    try {
      setDaemonReady(true);
      await expect(startDaemon({ port: 0, dbPath: root, handleSignals: false })).rejects.toThrow();
      expect(isDaemonReady()).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("starts ingestion only after the initial work scan settles, including failure", async () => {
    let resolveScan: (() => void) | undefined;
    const scan = new Promise<void>((resolve) => { resolveScan = resolve; });
    const start = vi.fn();
    const logger = vi.fn();
    startIngestionAfterStartupWorkScan(scan, start, logger);
    expect(start).not.toHaveBeenCalled();

    resolveScan?.();
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();

    const failure = new Error("scanner unavailable");
    const failedStart = vi.fn();
    const failedLogger = vi.fn();
    startIngestionAfterStartupWorkScan(Promise.reject(failure), failedStart, failedLogger);
    await Promise.resolve();
    await Promise.resolve();
    expect(failedStart).toHaveBeenCalledOnce();
    expect(failedLogger).toHaveBeenCalledWith("warn", "startup_work_scan_failed", {
      error: String(failure),
    });
  });

  it("does not start ingestion after daemon shutdown cancels the pending scan", async () => {
    let resolveScan: (() => void) | undefined;
    const scan = new Promise<void>((resolve) => { resolveScan = resolve; });
    const start = vi.fn();
    const cancel = startIngestionAfterStartupWorkScan(scan, start, vi.fn());

    cancel();
    resolveScan?.();
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
  });
});
