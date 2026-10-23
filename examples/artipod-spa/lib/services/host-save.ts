/** Host work can enqueue filesystem writes after a storage-only flush returns. */
export class HostSaveCoordinator {
  private revision = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failures = new Map<() => Promise<unknown>, unknown>();
  private readonly attempts = new WeakMap<() => Promise<unknown>, number>();
  private readonly retired = new WeakSet<() => Promise<unknown>>();
  private readonly scheduled = new Map<() => Promise<unknown>, { timer: ReturnType<typeof setTimeout>; onError: (error: unknown) => void }>();

  run<T>(work: () => Promise<T>): Promise<T> {
    this.revision += 1;
    const attempt = (this.attempts.get(work) ?? 0) + 1;
    this.attempts.set(work, attempt);
    const operation = Promise.resolve().then(work);
    this.pending.add(operation);
    const current = () => this.attempts.get(work) === attempt && !this.retired.has(work);
    void operation.then(() => { if (current()) this.failures.delete(work); }, error => { if (current()) this.failures.set(work, error); })
      .finally(() => this.pending.delete(operation));
    return operation;
  }

  /** A disposed producer no longer owns a save obligation in the next session. */
  forget(work: () => Promise<unknown>): void {
    const scheduled = this.scheduled.get(work);
    if (scheduled) clearTimeout(scheduled.timer);
    this.scheduled.delete(work);
    this.failures.delete(work);
    this.retired.add(work);
    this.revision += 1;
  }

  /** Debounced persistence stays visible to save(), which runs it immediately. */
  schedule(work: () => Promise<void>, delay: number, onError: (error: unknown) => void): () => void {
    const previous = this.scheduled.get(work);
    if (previous) clearTimeout(previous.timer);
    this.revision += 1;
    const entry = { timer: setTimeout(() => {
      this.scheduled.delete(work);
      void this.run(work).catch(onError);
    }, delay), onError };
    this.scheduled.set(work, entry);
    return () => {
      if (this.scheduled.get(work) !== entry) return;
      clearTimeout(entry.timer);
      this.scheduled.delete(work);
      this.revision += 1;
    };
  }

  /**
   * Reach an idle host queue, then flush service state and storage. If that
   * flush admits more work, drain again before reporting completion. Work
   * started after this promise resolves belongs to a later save.
   */
  async save(flush: () => Promise<void>): Promise<void> {
    for (;;) {
      const revision = this.revision;
      for (const [work, entry] of this.scheduled) {
        clearTimeout(entry.timer);
        this.scheduled.delete(work);
        void this.run(work).catch(entry.onError);
      }
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      if (this.failures.size) throw this.failures.values().next().value;
      await flush();
      if (revision === this.revision && !this.pending.size && !this.scheduled.size) return;
    }
  }
}

export const hostSave = new HostSaveCoordinator();
