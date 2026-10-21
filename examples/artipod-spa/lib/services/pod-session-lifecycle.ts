/** A pending workspace owns its place in the global mount/proc lifecycle. */
export type SessionOpening<T> = Promise<T> & { close(): Promise<void> };

/** Disposal could not be verified; reusing global mounts/providers is unsafe. */
export class SessionDisposalError extends Error {
  constructor(cause: unknown) { super('Workspace disposal failed; reload before opening another workspace', { cause }); }
}

/** Attempt every independent release even if an earlier release throws. */
export function disposeSessionResources(actions: Array<() => void>): void {
  const failures: unknown[] = [];
  for (const action of actions) { try { action(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new SessionDisposalError(new AggregateError(failures, 'Workspace resources did not all dispose'));
}

export class SessionLifecycle<Request, Session extends { close(): Promise<void> }> {
  private tail: Promise<unknown> = Promise.resolve();
  private current: SessionOpening<Session> | undefined;

  constructor(private readonly boot: (request: Request) => Promise<Session>, private readonly isFlushOnlyFailure: (error: unknown) => boolean = () => false) {}

  private retainTail(result: Promise<unknown>, closing = false): void {
    this.tail = result.catch(error => {
      if (closing && !this.isFlushOnlyFailure(error)) throw error instanceof SessionDisposalError ? error : new SessionDisposalError(error);
      if (error instanceof SessionDisposalError) throw error;
    });
    // Keep a blocking rejection handled even if no new route is requested.
    void this.tail.catch(() => {});
  }

  open(request: Request): SessionOpening<Session> {
    // Reserve the prior teardown NOW, even if its caller registered a deferred
    // storage teardown or its boot has not returned a session yet.
    void this.current?.close();
    let cancelled = false;
    let closing: Promise<void> | undefined;
    let dispose: (() => Promise<void>) | undefined;
    const opened = this.tail.then(async () => {
      if (cancelled) throw new Error('Workspace opening was cancelled');
      const session = await this.boot(request);
      dispose = session.close.bind(session);
      session.close = close;
      return session;
    }) as SessionOpening<Session>;
    const close = (): Promise<void> => {
      cancelled = true;
      if (!closing) {
        closing = opened.then(() => dispose!(), error => { if (error instanceof SessionDisposalError) throw error; });
        // A failed final flush can advance only after verified disposal.
        // Unknown cleanup failures keep the global lifecycle blocked.
        this.retainTail(closing, true);
        if (this.current === opened) this.current = undefined;
      }
      return closing;
    };
    opened.close = close;
    this.retainTail(opened);
    this.current = opened;
    return opened;
  }
}
