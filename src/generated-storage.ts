import { fileURLToPath } from 'node:url';
import { runSupervisedCommand } from '../scripts/process-group-supervisor.mjs';

/** Coalesced lifecycle hints; retries reconcile cleanup alone, never replay delivery. */
export class GeneratedStorageMaintenance {
  private active: Promise<void> | null = null;
  private pending = false;
  private stopped = false;
  private cursors: unknown = {};
  private readonly controller = new AbortController();
  constructor(private readonly home: string, private readonly db: string, private readonly failed: (error: unknown) => void) {}

  enqueue(): void {
    if (this.stopped) return;
    this.pending = true;
    if (this.active) return;
    this.active = Promise.resolve().then(async () => {
      while (this.pending && !this.stopped) {
        this.pending = false;
        try {
          const { stdout } = await runSupervisedCommand(process.execPath, ['--no-install', fileURLToPath(new URL('../scripts/generated-storage.mjs', import.meta.url)),
            '--apply', '--home', this.home, '--db', this.db, '--cursor', JSON.stringify(this.cursors)], { capture: true, timeout: 7000, graceMs: 500, signal: this.controller.signal });
          const result = JSON.parse(stdout);
          this.cursors = result.cursors;
          const failures = [...result.scratch, ...result.releases].filter((item: { action: string }) => item.action === 'cleanup-pending');
          if (failures.length) this.failed(failures);
        } catch (error) { if (!this.stopped) this.failed(error); }
      }
    }).finally(() => { this.active = null; });
  }

  async stop(): Promise<void> { this.stopped = true; this.controller.abort(); await this.active; }
}
