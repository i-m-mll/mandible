// Unattributed-write telemetry: the deprecation ratchet toward strict mode.
//
// In compat mode every mutation that arrives without a resolved client identity
// is allowed (nothing breaks) but counted here. A tail of zero unattributed
// writes is the operator's signal that flipping to strict mode is safe. Counters
// are process-lifetime and in memory only (no schema, no persistence) — the
// coordinator's constraint. They are surfaced through /api/health and the
// client-auth status route.

export interface UnattributedWriteContext {
  method: string;
  pathname: string;
  transport: "http" | "file-rpc";
  category?: string | null;
}

export interface ClientAuthTelemetrySnapshot {
  unattributed_writes_total: number;
  by_transport: Record<string, number>;
  by_category: Record<string, number>;
  last_unattributed_write_at: number | null;
  last_unattributed_write?: {
    method: string;
    pathname: string;
    transport: "http" | "file-rpc";
    category: string | null;
  };
}

export class ClientAuthTelemetry {
  private total = 0;
  private readonly byTransport: Record<string, number> = {};
  private readonly byCategory: Record<string, number> = {};
  private lastAt: number | null = null;
  private last: ClientAuthTelemetrySnapshot["last_unattributed_write"] | undefined;

  recordUnattributedWrite(ctx: UnattributedWriteContext, now: number = Date.now()): void {
    this.total += 1;
    this.byTransport[ctx.transport] = (this.byTransport[ctx.transport] ?? 0) + 1;
    const category = ctx.category ?? "uncategorized";
    this.byCategory[category] = (this.byCategory[category] ?? 0) + 1;
    this.lastAt = now;
    this.last = {
      method: ctx.method,
      pathname: ctx.pathname,
      transport: ctx.transport,
      category: ctx.category ?? null,
    };
  }

  snapshot(): ClientAuthTelemetrySnapshot {
    return {
      unattributed_writes_total: this.total,
      by_transport: { ...this.byTransport },
      by_category: { ...this.byCategory },
      last_unattributed_write_at: this.lastAt,
      ...(this.last ? { last_unattributed_write: { ...this.last } } : {}),
    };
  }

  /** Test/reset hook. Not used in production. */
  reset(): void {
    this.total = 0;
    for (const key of Object.keys(this.byTransport)) delete this.byTransport[key];
    for (const key of Object.keys(this.byCategory)) delete this.byCategory[key];
    this.lastAt = null;
    this.last = undefined;
  }
}
