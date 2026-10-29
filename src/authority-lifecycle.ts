/** Admission and join for operations that share a live authority database. */
export class AuthorityLifecycle {
  private accepting = true;
  private readonly active = new Set<Promise<unknown>>();

  assertOpen(): void {
    if (!this.accepting) throw new Error("Authority is closing.");
  }

  stopAdmission(): void {
    this.accepting = false;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    let complete!: () => void;
    const active = new Promise<void>(resolve => { complete = resolve; });
    this.active.add(active);
    let pending: Promise<T>;
    try { pending = operation(); }
    catch (error) { pending = Promise.reject(error); }
    const finished = () => { this.active.delete(active); complete(); };
    void pending.then(finished, finished);
    return pending;
  }

  async join(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }
}
