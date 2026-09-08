/**
 * A WebSocket the test drives, and a server on the other end of it.
 *
 * `Connection` owns a session across however many sockets it takes, so
 * almost everything worth testing about it — resume, replay, the resync
 * recovery, backoff — is about what happens when a socket dies and
 * another one opens. None of that is reachable without being able to
 * play the server, so this is the harness rather than a mock: tests
 * register handlers per request name and push events, and the transport
 * underneath behaves enough like a real one to be worth trusting
 * (replies arrive asynchronously, in order, on a socket that can be
 * closed out from under the client).
 */

export interface Frame {
  id: number;
  req: string;
  params: Record<string, unknown>;
}

export interface Reply {
  ok?: unknown;
  error?: { code: string; text: string };
}

type Handler = (params: Record<string, unknown>, frame: Frame) => Reply | Promise<Reply>;

let current: FakeServer | null = null;

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { reason: string; code: number }) => void) | null = null;

  constructor(readonly url: string) {
    const server = current;
    if (!server) throw new Error('installFakeWire() was not called');
    server.attach(this);
    // The handshake promise in `attach()` assigns `onopen` synchronously
    // after construction, so opening on a microtask is both realistic
    // and late enough to be heard.
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  send(raw: string): void {
    current?.received(this, raw);
  }

  close(reason = ''): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ reason, code: 1000 }));
  }
}

export class FakeServer {
  /** Every request frame the client has sent, across all its sockets. */
  readonly requests: Frame[] = [];
  /** Sockets the client has opened, oldest first. */
  readonly sockets: FakeSocket[] = [];
  private handlers = new Map<string, Handler>();
  private seq = 0;

  get socket(): FakeSocket | undefined {
    return this.sockets[this.sockets.length - 1];
  }

  /** Answer `req` with whatever `fn` returns. Later registrations win, so
   *  a test can change the server's mind between sockets. */
  on(req: string, fn: Handler): this {
    this.handlers.set(req, fn);
    return this;
  }

  /** Every request of this name the client has sent. */
  sent(req: string): Frame[] {
    return this.requests.filter((f) => f.req === req);
  }

  /** Push an event. `seq` defaults to the next one, which is what a real
   *  server guarantees and what `Connection` accounts against. */
  event(ev: string, data: unknown = {}, seq?: number): void {
    this.send({ seq: seq ?? ++this.seq, ev, data });
  }

  /** Move the server's own seq, for tests that hand out explicit ones. */
  setSeq(n: number): void {
    this.seq = n;
  }

  send(frame: unknown): void {
    this.socket?.onmessage?.({ data: JSON.stringify(frame) });
  }

  attach(socket: FakeSocket): void {
    this.sockets.push(socket);
  }

  received(socket: FakeSocket, raw: string): void {
    const frame = JSON.parse(raw) as Frame;
    this.requests.push(frame);
    const handler = this.handlers.get(frame.req);
    // Asynchronous on purpose: a client that only works when its replies
    // are synchronous is a client that will not work.
    void Promise.resolve()
      .then(() =>
        handler
          ? handler(frame.params ?? {}, frame)
          : { error: { code: 'unknown_method', text: `no handler for ${frame.req}` } },
      )
      .then((reply) => {
        if (socket.readyState !== FakeSocket.OPEN) return;
        socket.onmessage?.({ data: JSON.stringify({ reply: frame.id, ...reply }) });
      });
  }
}

/** Install the fake transport and the browser globals `Connection`
 *  reaches for. Returns the server the test drives. */
export function installFakeWire(): FakeServer {
  const server = new FakeServer();
  current = server;
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeSocket;
  // `Connection` uses `window.setTimeout` for its reconnect backoff, and
  // `sessionStorage` for resume-across-reloads. Both are reached for
  // behind guards in the source; supplying them is what makes the
  // guarded paths testable rather than skipped.
  g.window = { setTimeout, clearTimeout };
  g.sessionStorage = memoryStorage();
  return server;
}

export function uninstallFakeWire(): void {
  current = null;
  const g = globalThis as Record<string, unknown>;
  delete g.WebSocket;
  delete g.window;
  delete g.sessionStorage;
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

/** Let queued microtasks and timers settle. The client's own flow —
 *  reply, then hook, then a follow-up request — is several turns deep,
 *  and a test that asserts too early sees the middle of it. */
export function settle(turns = 6): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    const tick = (): void => {
      if (++n >= turns) return resolve();
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });
}
