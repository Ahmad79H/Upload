/**
 * PIP REMEMBERS TO NUDGE YOU — timers, reminders and habit nudges.
 *
 * Pure JS: no push servers, no notifications permission required (Pip just
 * talks). Uses a single interval and a small sorted queue, and the clock is
 * injectable so tests can jump through time instantly.
 */
import { uid } from './core/util.js';

export class Scheduler {
  constructor({ clock = () => Date.now(), onFire = () => {}, bus = null, store = null, tickMs = 1000 } = {}) {
    this.clock = clock;
    this.onFire = onFire;
    this.bus = bus;
    this.store = store;
    this.tickMs = tickMs;
    this.queue = store?.get('schedule', []) || [];
    this._timer = null;
    this.fired = [];
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this.tick(), this.tickMs);
    // fire anything that came due while Pip was closed
    this.tick();
    return this;
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  /** @returns {string} id */
  add({ type = 'timer', fireAt, label = '', payload = {}, repeatMs = 0 } = {}) {
    const item = { id: uid(type), type, fireAt: Number(fireAt) || this.clock() + 60000, label, payload, repeatMs, createdAt: this.clock() };
    this.queue.push(item);
    this.persist();
    this.bus?.emit('schedule:added', item);
    return item.id;
  }

  cancel(id) {
    const before = this.queue.length;
    this.queue = this.queue.filter((i) => i.id !== id);
    this.persist();
    return before - this.queue.length;
  }

  list({ type } = {}) {
    return this.queue.filter((i) => (type ? i.type === type : true)).sort((a, b) => a.fireAt - b.fireAt);
  }

  persist() {
    this.store?.set('schedule', this.queue.slice(-200));
    return this.queue.length;
  }

  /** Fire everything that is due. Returns the fired items. */
  tick(now = this.clock()) {
    const due = this.queue.filter((i) => i.fireAt <= now);
    if (!due.length) return [];
    const out = [];
    for (const item of due) {
      out.push(item);
      this.fired.push({ ...item, firedAt: now });
      this.bus?.emit('schedule:fire', item);
      try {
        this.onFire(item, now);
      } catch (err) {
        console.error('[scheduler] onFire failed', err);
      }
      if (item.repeatMs > 0) item.fireAt = now + item.repeatMs;
      else this.queue = this.queue.filter((i) => i.id !== item.id);
      // extra nudges for habit-driven reminders
      if (item.payload?.nagAfterMs && !item.payload?.nagged) {
        this.queue.push({
          ...item,
          id: uid(item.type),
          fireAt: now + item.payload.nagAfterMs,
          label: `${item.label} (follow-up)`,
          payload: { ...item.payload, nagged: true },
        });
      }
    }
    this.persist();
    return out;
  }

  /** Human list for the chat log / tests. */
  describe() {
    return this.list().map((i) => `${i.type}: ${i.label} at ${new Date(i.fireAt).toLocaleTimeString()}`);
  }
}
