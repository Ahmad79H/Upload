import { safeJson } from './util.js';

/**
 * Tiny namespaced persistent store.
 * - Everything stays on-device (localStorage by default).
 * - Storage backend is injectable so Node tests can run without a browser.
 * - Quota-safe: a failed write degrades to memory instead of throwing.
 */
export class Store {
  constructor({ storage = globalThis.localStorage ?? null, prefix = 'pip.', clock = () => Date.now() } = {}) {
    this.prefix = prefix;
    this.clock = clock;
    this.memory = new Map();
    this.storage = storage && typeof storage.getItem === 'function' ? storage : null;
    this.subscribers = new Set();
    this.writes = 0;
    this.failures = 0;
  }

  key(key) {
    return `${this.prefix}${key}`;
  }

  raw(key, fallback = null) {
    try {
      const v = this.storage ? this.storage.getItem(this.key(key)) : this.memory.get(this.key(key));
      return v == null ? fallback : v;
    } catch {
      return this.memory.get(this.key(key)) ?? fallback;
    }
  }

  get(key, fallback = null) {
    const raw = this.raw(key, null);
    if (raw == null) return fallback;
    const parsed = safeJson(typeof raw === 'string' ? raw : raw, undefined);
    return parsed === undefined ? fallback : parsed;
  }

  set(key, value) {
    const payload = JSON.stringify(value ?? null);
    this.memory.set(this.key(key), payload);
    try {
      this.storage?.setItem(this.key(key), payload);
      this.writes++;
    } catch (err) {
      this.failures++;
      console.warn('[store] write failed, kept in memory only:', err?.message);
    }
    this.notify(key, value);
    return value;
  }

  update(key, fallback, fn) {
    const next = fn(this.get(key, fallback));
    this.set(key, next);
    return next;
  }

  /** Append to a capped array. */
  push(key, item, cap = 500) {
    return this.update(key, [], (arr) => {
      const next = Array.isArray(arr) ? [...arr, item] : [item];
      return next.length > cap ? next.slice(next.length - cap) : next;
    });
  }

  remove(key) {
    this.memory.delete(this.key(key));
    try {
      this.storage?.removeItem(this.key(key));
    } catch {
      /* ignore */
    }
    this.notify(key, undefined);
  }

  keys() {
    const out = new Set();
    try {
      if (this.storage) {
        for (let i = 0; i < this.storage.length; i++) {
          const k = this.storage.key(i);
          if (k?.startsWith(this.prefix)) out.add(k.slice(this.prefix.length));
        }
      }
    } catch {
      /* ignore */
    }
    for (const k of this.memory.keys()) if (k.startsWith(this.prefix)) out.add(k.slice(this.prefix.length));
    return [...out];
  }

  all() {
    const out = {};
    for (const k of this.keys()) out[k] = this.get(k);
    return out;
  }

  clearAll() {
    for (const k of this.keys()) this.remove(k);
    this.memory.clear();
  }

  export() {
    return { v: 1, exportedAt: this.clock(), data: this.all() };
  }

  import(payload, { merge = false } = {}) {
    const data = payload?.data ?? payload;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) throw new Error('import: bad payload');
    if (!merge) this.clearAll();
    for (const [k, v] of Object.entries(data)) this.set(k, v);
    return this.keys().length;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  notify(key, value) {
    for (const fn of this.subscribers) {
      try {
        fn(key, value);
      } catch (err) {
        console.error('[store] subscriber failed', err);
      }
    }
  }

  /** Rough on-device footprint in bytes (for the settings screen). */
  size() {
    return this.keys().reduce((n, k) => n + String(this.raw(k, '')).length + k.length, 0);
  }
}

/** In-memory backend used by tests. */
export function makeMemoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}
