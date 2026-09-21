/**
 * Minimal synchronous event bus. Everything in Pip talks through this so the
 * UI, the puppet, the brain and the tests can stay decoupled.
 */
export class Bus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    this.history = [];
    this.historyLimit = 200;
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(event, fn) {
    const set = this.listeners.get(event);
    if (set) set.delete(fn);
  }

  /** Emit to exact event plus wildcard listeners ('*'). Never throws into callers. */
  emit(event, payload) {
    this.history.push({ event, payload, t: Date.now() });
    if (this.history.length > this.historyLimit) this.history.shift();
    const errors = [];
    for (const key of [event, '*']) {
      const set = this.listeners.get(key);
      if (!set) continue;
      for (const fn of [...set]) {
        try {
          fn(payload, event);
        } catch (err) {
          errors.push({ event, err });
        }
      }
    }
    for (const e of errors) console.error(`[bus] listener for "${e.event}" failed:`, e.err);
    return errors.length === 0;
  }

  count(event) {
    return this.history.filter((h) => h.event === event).length;
  }

  clear() {
    this.listeners.clear();
    this.history = [];
  }
}

export const bus = new Bus();
