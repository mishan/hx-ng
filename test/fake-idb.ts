/**
 * A hand-rolled in-memory `indexedDB`, in the spirit of
 * `packages/hotline-ng/test/fake-wire.ts`'s `memoryStorage()`: not a
 * mocking library, just enough of the real, callback-based IndexedDB
 * surface for `src/identity/storage.ts` to run against in Vitest's
 * `node` environment, which has no IndexedDB at all.
 *
 * The one subtlety worth writing down: `storage.ts` always awaits a
 * request before issuing the next one in the same transaction, so by the
 * time it calls `txDone()` (after its own `fn(tx)` has resolved), every
 * request that transaction will ever issue has already fired its
 * `onsuccess`. `FakeTransaction` leans on exactly that: it remembers
 * "pending reached zero" and fires `oncomplete` the moment a listener is
 * attached to it, rather than trying to simulate IndexedDB's real
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
    return bound;
  }

  createIndex(): void {
    // Nothing in `storage.ts` queries the fingerprint index yet; it only
    // has to exist so `createObjectStore` + `createIndex` don't throw
    // during the upgrade.
  }

  private keyOf(value: unknown, explicitKey: unknown): string {
    if (explicitKey !== undefined) return String(explicitKey);
    if (this.keyPath === null) throw new Error('an out-of-line store needs an explicit key');
    return String((value as Record<string, unknown>)[this.keyPath]);
  }

  get(key: unknown): FakeRequest<unknown> {
    return this.tx!.run(() => this.data.get(String(key)));
  }

  put(value: unknown, key?: unknown): FakeRequest<void> {
    return this.tx!.run(() => {
      this.data.set(this.keyOf(value, key), value);
    });
  }

  delete(key: unknown): FakeRequest<void> {
    return this.tx!.run(() => {
      this.data.delete(String(key));
    });
  }
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  constructor(private readonly stores: Map<string, FakeObjectStore>) {}

  createObjectStore(name: string, opts?: { keyPath?: string }): FakeObjectStore {
    const store = new FakeObjectStore(opts?.keyPath ?? null);
    this.stores.set(name, store);
    return store;
  }

  transaction(_storeNames: string | string[], _mode: IDBTransactionMode): FakeTransaction {
    return new FakeTransaction(this.stores);
  }

  close(): void {
    /* nothing to release */
  }
}

/** Installs a fresh, empty `indexedDB` on `globalThis` — one database
 *  worth of state per call, so tests that want isolation call this in
 *  `beforeEach`. */
export function installFakeIndexedDB(): void {
  const databases = new Map<string, Map<string, FakeObjectStore>>();

  (globalThis as any).indexedDB = {
    open(name: string, _version: number) {
      const req = new FakeRequest<FakeDatabase>();
      queueMicrotask(() => {
        const isNew = !databases.has(name);
        const stores = databases.get(name) ?? new Map<string, FakeObjectStore>();
        databases.set(name, stores);
        const db = new FakeDatabase(stores);
        req.result = db;
        if (isNew) (req as any).onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}
