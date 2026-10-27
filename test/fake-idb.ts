/**
 * A hand-rolled in-memory `indexedDB`, in the spirit of
 * `packages/hotline-ng/test/fake-wire.ts`'s `memoryStorage()`: not a
 * mocking library, just enough of the real, callback-based IndexedDB
 * surface for `src/identity/storage.ts` to run against in Vitest's
 * `node` environment, which has no IndexedDB at all.
 *
 * The one subtlety worth writing down: `storage.ts` never issues a new
 * request on a transaction after `fn(tx)`'s own promise has resolved —
 * some callers await each request in turn, others (`ensureActiveDevice`)
 * fire two `put()`s back to back without awaiting either, but none
 * issue one *after* `fn` returns. So by the time `withDb` calls
 * `txDone()`, every request that transaction will ever issue has
 * already been created, whether or not it has fired `onsuccess` yet.
 * `FakeTransaction` leans on exactly that: `oncomplete` fires once
 * pending reaches zero *and* a listener has been attached, in whichever
 * order those two happen — not by trying to simulate IndexedDB's real
 * auto-commit timing.
 */

class FakeRequest<T> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeTransaction {
  private pending = 0;
  private readyToComplete = false;
  private fired = false;
  private _oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor(private readonly stores: Map<string, FakeObjectStore>) {}

  get oncomplete(): (() => void) | null {
    return this._oncomplete;
  }
  set oncomplete(fn: (() => void) | null) {
    this._oncomplete = fn;
    if (this.readyToComplete && fn && !this.fired) {
      this.fired = true;
      queueMicrotask(fn);
    }
  }

  objectStore(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (!store) throw new Error(`no such object store: ${name}`);
    return store.bindTo(this);
  }

  run<T>(op: () => T): FakeRequest<T> {
    const req = new FakeRequest<T>();
    this.pending++;
    queueMicrotask(() => {
      try {
        req.result = op();
      } catch (e) {
        req.error = e instanceof Error ? e : new Error(String(e));
      }
      this.pending--;
      if (req.error) req.onerror?.();
      else req.onsuccess?.();
      if (this.pending === 0) {
        this.readyToComplete = true;
        if (this._oncomplete && !this.fired) {
          this.fired = true;
          queueMicrotask(this._oncomplete);
        }
      }
    });
    return req;
  }
}

class FakeObjectStore {
  private data = new Map<string, unknown>();
  private tx: FakeTransaction | null = null;

  constructor(private readonly keyPath: string | null) {}

  bindTo(tx: FakeTransaction): FakeObjectStore {
    const bound = Object.create(this) as FakeObjectStore;
    bound.tx = tx;
    bound.data = this.data; // share the backing map across binds
    bound.indexes = this.indexes;
    return bound;
  }

  private indexes = new Map<string, string>();

  createIndex(name: string, keyPath: string): void {
    this.indexes.set(name, keyPath);
  }

  /** The primary keys of the values whose `keyPath` falls in `range`. */
  index(name: string): { getAllKeys(range: FakeKeyRange): FakeRequest<string[]> } {
    const keyPath = this.indexes.get(name);
    if (keyPath === undefined) throw new Error(`no such index: ${name}`);
    return {
      getAllKeys: (range) =>
        this.tx!.run(() =>
          [...this.data].filter(([, v]) => range.includes((v as Record<string, unknown>)?.[keyPath])).map(([k]) => k),
        ),
    };
  }

  private keyOf(value: unknown, explicitKey: unknown): string {
    if (explicitKey !== undefined) return String(explicitKey);
    if (this.keyPath === null) throw new Error('an out-of-line store needs an explicit key');
    return String((value as Record<string, unknown>)[this.keyPath]);
  }

  get(key: unknown): FakeRequest<unknown> {
    return this.tx!.run(() => this.data.get(String(key)));
  }

  getAll(): FakeRequest<unknown[]> {
    return this.tx!.run(() => [...this.data.values()]);
  }

  put(value: unknown, key?: unknown): FakeRequest<void> {
    return this.tx!.run(() => {
      this.data.set(this.keyOf(value, key), value);
    });
  }

  /** A key, or a range of string keys as `IDBKeyRange.bound` makes one. */
  delete(key: unknown): FakeRequest<void> {
    return this.tx!.run(() => {
      if (key instanceof FakeKeyRange) {
        for (const k of [...this.data.keys()]) if (key.includes(k)) this.data.delete(k);
      } else {
        this.data.delete(String(key));
      }
    });
  }
}

class FakeKeyRange {
  constructor(
    readonly lower: string | number | undefined,
    readonly upper: string | number,
    readonly upperOpen = false,
  ) {}

  includes(key: unknown): boolean {
    if (typeof key !== typeof this.upper) return false;
    const k = key as string | number;
    return (this.lower === undefined || k >= this.lower) && (this.upperOpen ? k < this.upper : k <= this.upper);
  }
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  constructor(
    private readonly stores: Map<string, FakeObjectStore>,
    private readonly closed: () => void,
  ) {}

  createObjectStore(name: string, opts?: { keyPath?: string }): FakeObjectStore {
    const store = new FakeObjectStore(opts?.keyPath ?? null);
    this.stores.set(name, store);
    return store;
  }

  transaction(_storeNames: string | string[], _mode: IDBTransactionMode): FakeTransaction {
    return new FakeTransaction(this.stores);
  }

  close(): void {
    this.closed();
  }
}

/** Installs a fresh, empty `indexedDB` on `globalThis` — one database
 *  worth of state per call, so tests that want isolation call this in
 *  `beforeEach`. */
export function installFakeIndexedDB(): void {
  const databases = new Map<string, Map<string, FakeObjectStore>>();
  const versions = new Map<string, number>();

  const open = new Map<string, number>();

  (globalThis as any).IDBKeyRange = {
    bound: (lower: string, upper: string) => new FakeKeyRange(lower, upper),
    upperBound: (upper: number, upperOpen = false) => new FakeKeyRange(undefined, upper, upperOpen),
  };
  (globalThis as any).indexedDB = {
    open(name: string, version: number) {
      const req = new FakeRequest<FakeDatabase>();
      queueMicrotask(() => {
        const upgrade = (versions.get(name) ?? 0) < version;
        // A real upgrade waits, blocked, on every handle left open.
        if (upgrade && (open.get(name) ?? 0) > 0) {
          req.error = new Error(`upgrading ${name} is blocked by a handle left open`);
          return req.onerror?.();
        }
        if (upgrade) versions.set(name, version);
        const stores = databases.get(name) ?? new Map<string, FakeObjectStore>();
        databases.set(name, stores);
        open.set(name, (open.get(name) ?? 0) + 1);
        const db = new FakeDatabase(stores, () => open.set(name, open.get(name)! - 1));
        req.result = db;
        if (upgrade) (req as any).onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}
