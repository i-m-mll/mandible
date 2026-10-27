import { Component, h, type ComponentChildren } from 'preact';
import { vi } from 'vitest';

export interface FixtureRequest {
  url: URL;
  method: string;
  input: RequestInfo | URL;
  init?: RequestInit;
  json: () => Promise<unknown>;
}

export interface FixtureHandler {
  name: string;
  method: string;
  path: string | RegExp;
  respond: (request: FixtureRequest) => Response | typeof PENDING_RESPONSE | Promise<Response | typeof PENDING_RESPONSE>;
}

export const PENDING_RESPONSE = Symbol('controlled pending fixture response');

export function jsonFixture(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const installed = new Set<StrictUiFixture>();
let active: StrictUiFixture | undefined;

export function guardFixtureWork<T>(work: () => Promise<T>): Promise<T> {
  return active ? active.wait(work) : work();
}

export function finishUiFixtures(): void {
  let fault: unknown;
  for (const fixture of [...installed]) {
    try { fixture.finish(); } catch (error) { fault ??= error; }
  }
  if (fault) throw fault;
}

class FixtureRenderBoundary extends Component<{ fixture: StrictUiFixture; children?: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };
  componentDidCatch(cause: unknown): void {
    this.props.fixture.fail('render failed', cause);
    this.setState({ failed: true });
  }
  render(): ComponentChildren { return this.state.failed ? null : this.props.children; }
}

export function fixtureView(view: ComponentChildren): ComponentChildren {
  return active ? h(FixtureRenderBoundary, { fixture: active }, view) : view;
}

/** A fixture fault survives application catches and is checked again at test completion. */
export class StrictUiFixture {
  readonly requested: string[] = [];
  private readonly contexts = new Set<string>();
  private fault?: Error;
  private readonly failure: Promise<Error>;
  private signalFailure!: (error: Error) => void;
  private readonly disposers = new Set<() => void>();
  private closed = false;
  private previousFetch?: typeof fetch;
  private installedFetch?: typeof fetch;
  inflight = 0;

  constructor(readonly owner: string, readonly handlers: FixtureHandler[]) {
    this.failure = new Promise(resolve => { this.signalFailure = resolve; });
  }

  install(): this {
    if (active) throw new Error(`UI fixture ${active.owner} is already installed`);
    installed.add(this);
    active = this;
    this.previousFetch = globalThis.fetch;
    this.installedFetch = vi.fn(this.fetch);
    vi.stubGlobal('fetch', this.installedFetch);
    return this;
  }

  onDispose(dispose: () => void): void { this.disposers.add(dispose); }

  /** An intentional unresolved response, released on abort, failure, or test completion. */
  private pending(request: FixtureRequest): Promise<Response> {
    const signal = request.init?.signal ?? (request.input instanceof Request ? request.input.signal : undefined);
    return new Promise<Response>((_resolve, reject) => {
      const cancel = () => {
        signal?.removeEventListener('abort', cancel);
        this.disposers.delete(cancel);
        reject(new DOMException('Fixture request disposed', 'AbortError'));
      };
      this.disposers.add(cancel);
      if (signal?.aborted || this.closed || this.fault) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), window.location.href);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const context = `${method} ${url.href}`;
    this.requested.push(`${method} ${url.pathname}${url.search}`);
    const handler = this.handlers.find(candidate => candidate.method.toUpperCase() === method && (
      typeof candidate.path === 'string' ? candidate.path === url.pathname : (
        candidate.path.lastIndex = 0, candidate.path.test(url.pathname)
      )
    ));
    if (!handler) throw this.fail(`unhandled request ${context}`);
    this.contexts.add(`${handler.name}: ${context}`);
    this.assertHealthy();
    const normalized: FixtureRequest = {
      input, init, url, method,
      json: async () => init?.body !== undefined ? JSON.parse(String(init.body)) : request?.clone().json(),
    };
    this.inflight += 1;
    try {
      const response = await handler.respond(normalized);
      return response === PENDING_RESPONSE ? this.pending(normalized) : response;
    } catch (cause) {
      throw this.fail(`handler ${handler.name} failed for ${context}`, cause);
    } finally {
      this.inflight -= 1;
    }
  };

  fail(message: string, cause?: unknown): Error {
    if (!this.fault) {
      this.fault = new Error(`[${this.owner}] ${message}\nFixture requests:\n${[...this.contexts].join('\n')}`, { cause });
      this.signalFailure(this.fault);
      this.disposeWork();
    }
    return this.fault;
  }

  assertHealthy(): void { if (this.fault) throw this.fault; }

  async guard<T>(work: Promise<T>): Promise<T> {
    const value = await Promise.race([work, this.failure.then(error => { throw error; })]);
    this.assertHealthy();
    return value;
  }

  /** Testing Library has no cancellation API. Own the resources it installs synchronously. */
  wait<T>(work: () => Promise<T>): Promise<T> {
    const timeout = globalThis.setTimeout;
    const interval = globalThis.setInterval;
    const Observer = globalThis.MutationObserver;
    const resources = new Set<() => void>();
    const dispose = () => { for (const release of resources) release(); resources.clear(); };
    this.disposers.add(dispose);
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const handle = timeout(...args);
      resources.add(() => clearTimeout(handle));
      return handle;
    }) as typeof setTimeout;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = interval(...args);
      resources.add(() => clearInterval(handle));
      return handle;
    }) as typeof setInterval;
    globalThis.MutationObserver = class extends Observer {
      constructor(callback: MutationCallback) {
        super(callback);
        resources.add(() => this.disconnect());
      }
    };
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (error) {
      dispose();
      this.disposers.delete(dispose);
      throw error;
    } finally {
      globalThis.setTimeout = timeout;
      globalThis.setInterval = interval;
      globalThis.MutationObserver = Observer;
    }
    if (this.fault || this.closed) dispose();
    return this.guard(pending).finally(() => {
      dispose();
      this.disposers.delete(dispose);
    });
  }

  private disposeWork(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
  }

  finish(): void {
    this.closed = true;
    this.disposeWork();
    installed.delete(this);
    if (active === this) active = undefined;
    if (globalThis.fetch === this.installedFetch && this.previousFetch) globalThis.fetch = this.previousFetch;
    this.assertHealthy();
  }
}
