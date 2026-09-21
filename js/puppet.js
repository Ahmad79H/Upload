/**
 * PIP'S BODY CONTROL — animation state machine, drag physics, gestures, idle life.
 *
 *  • The SVG lives in puppet-art.js and is injected here (no runtime fetch →
 *    works offline, from file://, and in jsdom unit tests).
 *  • `data-anim`, `data-expr`, `data-look`, `data-mood`, `data-drag`, `data-blink`
 *    attributes are the single source of truth for what Pip looks like; CSS
 *    turns those into motion, and the tests assert them directly.
 *  • Idle life: he blinks, glances around, mutters, stretches and cheers on his
 *    own every few seconds, so the screen is never static.
 *  • Drag: pointer (touch *and* mouse) dragging with velocity tracking, gravity,
 *    wall clamps, floor bounce, squash-and-stretch and a landing wobble.
 *
 * Nothing here touches the network. All randomness is injectable for tests.
 */
import { clamp, pick, uid } from './core/util.js';
import { PUPPET_SVG } from './puppet-art.js';

export const ANIMS = ['idle', 'talk', 'think', 'jump', 'cheer', 'droop', 'sleep', 'dance'];
export const EXPRESSIONS = ['happy', 'curious', 'sad', 'wow', 'determined', 'blush'];

const PHYS = { gravity: 2600, damping: 0.72, friction: 0.86, wallBounce: 0.6, minSpeed: 14 };

/** The art's viewBox (js/puppet-art.js). His feet sit at the very bottom of it. */
const ART = { w: 200, h: 280 };
/** `.ground` is 26vh tall, so the grass line is at 74% of the viewport height. */
const GROUND_FRACTION = 0.74;

export class Puppet {
  constructor({ win = globalThis, doc = globalThis.document, container = null, bus = null, store = null, rng = Math.random, clock = () => Date.now(), size = null } = {}) {
    this.win = win;
    this.doc = doc;
    this.container = container;
    this.bus = bus;
    this.store = store;
    this.rng = rng;
    this.clock = clock;
    this.size = size || this.computeSize();
    this.el = null;
    this.pos = { x: 0, y: 0 };
    this.vel = { x: 0, y: 0 };
    this.floorY = 0;
    this.dragging = false;
    this.landed = false;
    this.anim = 'idle';
    this.expr = 'happy';
    this.mood = 'normal';
    this.look = 'center';
    this.blinking = false;
    this.timers = new Set();
    this.listeners = [];
    this.stats = { pokes: 0, drags: 0, thrown: 0, idleActs: 0, blinks: 0 };
    this._animTimer = null;
    this._raf = null;
    this._pointer = { active: false, id: null, startX: 0, startY: 0, lastX: 0, lastY: 0, lastT: 0, moved: 0, startedAt: 0, trail: [] };
    this._tapCount = 0;
    this._lastTapAt = 0;
    this._pressTimer = null;
    this.destroyed = false;
  }

  computeSize() {
    const w = this.win?.innerWidth || 390;
    const h = this.win?.innerHeight || 844;
    return Math.round(clamp(Math.min(w, h) * 0.34, 96, 200));
  }

  /* ─────────── lifecycle ─────────── */

  mount() {
    if (!this.container) throw new Error('Puppet needs a container element');
    const restored = this.store?.get('puppet', null);
    this.container.innerHTML = PUPPET_SVG;
    this.el = this.container.querySelector('.puppet-svg');
    if (!this.el) throw new Error('puppet art failed to mount');
    this.rootEl = this.container;
    this.rootEl.style.setProperty('--puppet-size', `${this.size}px`);
    const bounds = this.bounds();
    this.artHeight = Math.round((this.size * ART.h) / ART.w);
    this.groundLine = Math.round(bounds.h * GROUND_FRACTION);
    // Resting position: feet exactly on the grass line, never above the top edge.
    this.floorY = Math.max(0, this.groundLine - this.artHeight);
    this.pos = restored?.pos && Number.isFinite(restored.pos.x)
      ? { x: clamp(restored.pos.x, 0, Math.max(0, bounds.w - this.size)), y: clamp(restored.pos.y, 0, this.floorY) }
      : { x: Math.round(bounds.w / 2 - this.size / 2), y: this.floorY };
    this.vel = { x: 0, y: 0 };
    this.render();
    this.attachInput();
    this.startIdle();
    const seen = this.measure();
    if (!seen.ok) {
      // A stale service-worker cache or a browser quirk left him with no pixels.
      // Harden the inline styles so he is visible anyway, and tell the app.
      this.harden();
      this.bus?.emit('puppet:hidden', seen);
    }
    this.bus?.emit('puppet:mounted', { size: this.size, pos: { ...this.pos }, visible: seen.ok });
    return this;
  }

  bounds() {
    const w = this.win?.innerWidth || 390;
    const h = this.win?.innerHeight || 844;
    return { w, h };
  }

  /**
   * Did the art actually get pixels? Headless test DOMs (jsdom) never lay out,
   * so they are excused — everywhere else a zero-size puppet means a real bug.
   */
  measure() {
    const el = this.el;
    if (!el?.getBoundingClientRect) return { ok: false, reason: 'no element', laidOut: false };
    const laidOut = (this.doc?.body?.clientWidth || 0) > 0;
    let rect = { x: 0, y: 0, w: 0, h: 0 };
    try {
      const r = el.getBoundingClientRect();
      rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } catch {
      return { ok: false, reason: 'rect unavailable', laidOut };
    }
    return { ok: !laidOut || (rect.w > 0 && rect.h > 0), laidOut, rect, size: this.size };
  }

  /** Last-resort inline styles so Pip is on screen even if the stylesheet did not load. */
  harden() {
    if (!this.el) return false;
    const art = { position: 'absolute', left: '0', top: '0', display: 'block' };
    for (const [k, v] of Object.entries(art)) this.el.style[k] = v;
    this.el.style.width = `${this.size}px`;
    this.el.style.height = `${Math.round((this.size * ART.h) / ART.w)}px`;
    this.rootEl.style.transform = `translate3d(${Math.round(this.pos.x)}px, ${Math.round(this.pos.y)}px, 0)`;
    return true;
  }

  render() {
    if (!this.rootEl) return;
    this.rootEl.style.transform = `translate3d(${Math.round(this.pos.x)}px, ${Math.round(this.pos.y)}px, 0)`;
    this.el.dataset.anim = this.anim;
    this.el.dataset.expr = this.expr;
    this.el.dataset.mood = this.mood;
    this.el.dataset.look = this.look;
    this.el.dataset.drag = String(this.dragging);
    this.el.dataset.blink = String(this.blinking);
    this.el.classList.toggle('is-landed', this.landed);
    // Explicit px box: never rely on intrinsic SVG sizing for the puppet to be seen.
    this.el.style.width = `${this.size}px`;
    this.el.style.height = `${this.artHeight || Math.round((this.size * ART.h) / ART.w)}px`;
    this.el.style.transform = this.dragging ? 'rotate(-3deg)' : '';
    const shadow = this.doc?.getElementById?.('drop-shadow');
    if (shadow) {
      const air = clamp((this.floorY - this.pos.y) / 260, 0, 1);
      shadow.style.left = `${this.pos.x + this.size / 2}px`;
      shadow.style.top = `${this.groundLine ?? this.bounds().h * GROUND_FRACTION}px`;
      shadow.style.opacity = String(clamp(0.55 - air * 0.4, 0.08, 0.6));
      const scale = clamp(1 - air * 0.35, 0.5, 1);
      shadow.style.transform = `translate(-50%,-50%) scale(${scale})`;
    }
    return this;
  }

  /** Where speech bubbles should point (top-centre of his head). */
  anchor() {
    return { x: this.pos.x + this.size / 2, y: Math.max(56, this.pos.y + this.size * 0.06) };
  }

  /* ─────────── state ─────────── */

  setAnim(name, { durationMs = 0, force = false } = {}) {
    if (!ANIMS.includes(name)) throw new Error(`unknown animation "${name}"`);
    if (this.anim === 'sleep' && name !== 'sleep' && name !== 'idle' && !force) this.wake();
    this.anim = name;
    clearTimeout(this._animTimer);
    if (durationMs) {
      this._animTimer = this._after(() => this.setAnim('idle'), durationMs);
      this.timers.add(this._animTimer);
    }
    this.render();
    this.bus?.emit('puppet:anim', { anim: name });
    return this;
  }

  setExpression(expr) {
    if (!EXPRESSIONS.includes(expr)) return this;
    this.expr = expr;
    this.render();
    this.bus?.emit('puppet:expr', { expr });
    return this;
  }

  setMood(mood) {
    this.mood = mood;
    this.render();
    return this;
  }

  setLook(dir) {
    this.look = ['left', 'right', 'up', 'down', 'center'].includes(dir) ? dir : 'center';
    this.render();
    return this;
  }

  /** Pupils follow a screen coordinate (drag, pointer, or the user's face). */
  lookToward(x, y) {
    const cx = this.pos.x + this.size / 2;
    const cy = this.pos.y + this.size * 0.4;
    const dx = x - cx;
    const dy = y - cy;
    if (Math.abs(dx) < this.size * 0.25 && Math.abs(dy) < this.size * 0.25) return this.setLook('center');
    if (Math.abs(dx) > Math.abs(dy)) return this.setLook(dx < 0 ? 'left' : 'right');
    return this.setLook(dy < 0 ? 'up' : 'down');
  }

  blinkOnce() {
    this.blinking = true;
    this.stats.blinks++;
    this.render();
    setTimeout(() => {
      this.blinking = false;
      this.render();
    }, 110);
    return this;
  }

  /** A named little performance: cheer, jump, dance, blush, sparkle, think, droop. */
  perform(action = 'cheer') {
    const a = String(action).toLowerCase();
    const map = {
      cheer: () => {
        this.setExpression('wow');
        this.setMood('hyped');
        this.setAnim('cheer', { durationMs: 1600 });
        this._sparkle();
      },
      celebrate: () => this.perform('cheer'),
      jump: () => {
        this.setExpression('determined');
        this.setAnim('jump', { durationMs: 620 });
        this.airHop(58);
      },
      'do a flip': () => this.perform('jump'),
      dance: () => {
        this.setExpression('happy');
        this.setMood('hyped');
        this.setAnim('dance', { durationMs: 2600 });
        this._dance();
      },
      blush: () => {
        this.setExpression('blush');
        this.setAnim('idle', { durationMs: 1400 });
      },
      wow: () => this.setExpression('wow'),
      sparkle: () => this._sparkle(),
      think: () => this.setAnim('think', { durationMs: 2200 }),
      droop: () => {
        this.setExpression('sad');
        this.setAnim('droop', { durationMs: 2000 });
      },
      wave: () => {
        this.setExpression('happy');
        this._wave();
      },
      sleep: () => this.sleep(),
      wake: () => this.wake(),
    };
    (map[a] || map.cheer)();
    this.bus?.emit('puppet:perform', { action: a });
    return this;
  }

  _sparkle() {
    if (!this.el) return;
    this.el.classList.add('is-sparkling');
    this._after(() => this.el?.classList.remove('is-sparkling'), 1800);
  }

  _wave() {
    this.setAnim('talk', { durationMs: 1200 });
  }

  _dance() {
    const beats = 6;
    for (let i = 0; i < beats; i++) {
      const t = this._after(() => {
        this.look = i % 2 ? 'left' : 'right';
        this.setExpression(i % 3 === 0 ? 'wow' : 'happy');
        this.render();
      }, i * 380);
      this.timers.add(t);
    }
    const end = this._after(() => this.setLook('center'), beats * 380 + 100);
    this.timers.add(end);
  }

  sleep() {
    this.setAnim('sleep', { force: true });
    this.setExpression('happy');
    this.bus?.emit('puppet:sleep', {});
    return this;
  }

  wake() {
    this.setAnim('idle', { force: true });
    this.setExpression('happy');
    this.perform('jump');
    this.bus?.emit('puppet:wake', {});
    return this;
  }

  /* ─────────── idle life ─────────── */

  startIdle({ blinkMs = 3200, glanceMs = 8000, actMs = 15000 } = {}) {
    this.stopIdle();
    this._blinkLoop(blinkMs);
    this._glanceLoop(glanceMs);
    this._actLoop(actMs);
    return this;
  }

  /** setTimeout that (a) is tracked for destroy() and (b) never fires after destroy(). */
  _after(fn, ms) {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      if (this.destroyed) return;
      fn();
    }, ms);
    this.timers.add(handle);
    return handle;
  }

  _every(fn, ms) {
    const id = setInterval(() => {
      if (this.destroyed) return;
      if (this.anim === 'sleep' && fn.name !== 'blink') return;
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  _blinkLoop(ms) {
    const schedule = () => {
      if (this.destroyed) return;
      const delay = ms * (0.55 + this.rng() * 0.9);
      const t = setTimeout(() => {
        this.timers.delete(t);
        if (this.destroyed) return;
        if (this.anim !== 'sleep') this.blinkOnce();
        schedule();
      }, delay);
      this.timers.add(t);
    };
    schedule();
  }

  _glanceLoop(ms) {
    this._every(() => {
      if (this.dragging) return;
      this.setLook(pick(['left', 'right', 'up', 'center'], this.rng));
      const t = this._after(() => !this.dragging && this.setLook('center'), 1600 + this.rng() * 1200);
      this.timers.add(t);
    }, ms);
  }

  _actLoop(ms) {
    this._every(() => {
      if (this.dragging || this.anim === 'talk' || this.anim === 'think') return;
      this.stats.idleActs++;
      const acts = ['think', 'cheer', 'jump', 'blush', 'wave', 'sparkle'];
      const action = pick(acts, this.rng);
      if (action === 'think') {
        this.setAnim('think', { durationMs: 2000 });
        this.bus?.emit('puppet:idle-act', { action, line: null });
      } else if (action === 'wave') {
        this.perform('wave');
        this.bus?.emit('puppet:idle-act', { action });
      } else {
        this.perform(action);
        this.bus?.emit('puppet:idle-act', { action });
      }
    }, ms);
  }

  stopIdle() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
    return this;
  }

  /* ─────────── input: drag, fling, poke ─────────── */

  attachInput() {
    if (!this.el?.addEventListener) return this;
    const onDown = (event) => this.onPointerDown(event);
    const onMove = (event) => this.onPointerMove(event);
    const onUp = (event) => this.onPointerUp(event);
    this.el.addEventListener('pointerdown', onDown);
    this.win?.addEventListener?.('pointermove', onMove, { passive: false });
    this.win?.addEventListener?.('pointerup', onUp);
    this.win?.addEventListener?.('pointercancel', onUp);
    this.win?.addEventListener?.('resize', () => this.onResize());
    this.listeners.push(
      () => this.el?.removeEventListener('pointerdown', onDown),
      () => this.win?.removeEventListener?.('pointermove', onMove),
      () => this.win?.removeEventListener?.('pointerup', onUp),
      () => this.win?.removeEventListener?.('pointercancel', onUp),
    );
    return this;
  }

  pointFrom(event) {
    return { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
  }

  onPointerDown(event) {
    const p = this.pointFrom(event);
    const now = this.clock();
    this._pointer = { active: true, id: event?.pointerId ?? 1, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, lastT: now, moved: 0, startedAt: now, trail: [{ x: p.x, y: p.y, t: now }] };
    this.dragging = true;
    this.stats.drags++;
    this.vel = { x: 0, y: 0 };
    this.el?.classList.add('is-dragging');
    this.setAnim('idle');
    this.setExpression('wow');
    this.render();
    this.bus?.emit('puppet:drag-start', { at: p });
    this._pressTimer = this._after(() => {
      if (this._pointer.moved < 8) {
        this.bus?.emit('puppet:long-press', {});
        this.perform('think');
      }
    }, 620);
    this.timers.add(this._pressTimer);
    event?.preventDefault?.();
  }

  onPointerMove(event) {
    if (!this._pointer.active) return;
    const p = this.pointFrom(event);
    if (event?.pointerId != null && this._pointer.id != null && event.pointerId !== this._pointer.id) return;
    const dx = p.x - this._pointer.lastX;
    const dy = p.y - this._pointer.lastY;
    this._pointer.moved += Math.hypot(dx, dy);
    this._pointer.lastX = p.x;
    this._pointer.lastY = p.y;
    const bounds = this.bounds();
    this.pos.x = clamp(this.pos.x + dx, -this.size * 0.2, bounds.w - this.size * 0.8);
    this.pos.y = clamp(this.pos.y + dy, 40, bounds.h - this.size * 0.6);
    const now = this.clock();
    this._pointer.trail.push({ x: p.x, y: p.y, t: now });
    if (this._pointer.trail.length > 8) this._pointer.trail.shift();
    this._pointer.lastT = now;
    this.lookToward(p.x, p.y);
    if (this._pointer.moved > 26) clearTimeout(this._pressTimer);
    this.render();
  }

  onPointerUp() {
    if (!this._pointer.active) return;
    clearTimeout(this._pressTimer);
    const now = this.clock();
    const duration = now - this._pointer.startedAt;
    const moved = this._pointer.moved;
    this._pointer.active = false;
    this.dragging = false;
    this.el?.classList.remove('is-dragging');

    if (moved < 8 && duration < 340) {
      this.onTap();
    } else if (moved >= 8) {
      // fling with the pointer's recent velocity
      const trail = this._pointer.trail;
      const a = trail[0];
      const b = trail[trail.length - 1];
      const dt = Math.max(16, b.t - a.t);
      this.vel.x = clamp(((b.x - a.x) / dt) * 900, -1600, 1600);
      this.vel.y = clamp(((b.y - a.y) / dt) * 900, -1800, 1800);
      this.stats.thrown++;
      this.startPhysics();
      this.bus?.emit('puppet:fling', { vel: { ...this.vel } });
    } else {
      this.settle();
    }
    this.render();
    this.save();
  }

  onTap() {
    const now = this.clock();
    const isDouble = now - this._lastTapAt < 360;
    this._lastTapAt = now;
    this._tapCount = isDouble ? this._tapCount + 1 : 1;
    this.stats.pokes++;
    if (isDouble) {
      this.perform('cheer');
      this.bus?.emit('puppet:double-tap', {});
    } else {
      this.setExpression(pick(['happy', 'curious', 'wow'], this.rng));
      this.setAnim('jump', { durationMs: 420 });
      this.airHop(26);
      this.bus?.emit('puppet:tap', {});
    }
    return this;
  }

  /** Fun little hop that does not move the logical position. */
  airHop(height = 40) {
    const start = this.pos.y;
    const t0 = this.clock();
    const step = () => {
      const t = (this.clock() - t0) / 420;
      if (t >= 1) {
        this.pos.y = start;
        this.render();
        return;
      }
      this.pos.y = start - Math.sin(Math.PI * t) * height;
      this.render();
      this._raf = this.requestFrame(step);
    };
    step();
    return this;
  }

  requestFrame(fn) {
    if (typeof this.win?.requestAnimationFrame === 'function') return this.win.requestAnimationFrame(fn);
    return setTimeout(fn, 16);
  }

  cancelFrame(id) {
    if (typeof this.win?.cancelAnimationFrame === 'function' && this.win?.requestAnimationFrame) this.win.cancelAnimationFrame(id);
    else clearTimeout(id);
  }

  /** Gravity + bounce after a fling. */
  startPhysics() {
    this.cancelPhysics();
    let vy = this.vel.y;
    let vx = this.vel.x;
    const bounds = this.bounds();
    const minX = -this.size * 0.2;
    const maxX = bounds.w - this.size * 0.8;
    const dt = 1 / 60;
    const step = () => {
      vy += PHYS.gravity * dt;
      this.pos.y += vy * dt;
      this.pos.x += vx * dt;
      vx *= PHYS.friction;
      if (this.pos.x < minX) {
        this.pos.x = minX;
        vx = Math.abs(vx) * PHYS.wallBounce;
      }
      if (this.pos.x > maxX) {
        this.pos.x = maxX;
        vx = -Math.abs(vx) * PHYS.wallBounce;
      }
      if (this.pos.y < 4) {
        // bounce off the top of the screen instead of flying away
        this.pos.y = 4;
        vy = Math.abs(vy) * PHYS.wallBounce;
      }
      if (this.pos.y > this.floorY) {
        this.pos.y = this.floorY;
        vy = -vy * PHYS.damping;
        vx *= 0.9;
        if (Math.abs(vy) > 90) {
          this.landed = true;
          this.bus?.emit('puppet:bounce', { speed: Math.abs(vy) });
          setTimeout(() => {
            this.landed = false;
            this.render();
          }, 460);
        } else {
          vy = 0;
        }
      }
      this.render();
      if (Math.abs(vy) > PHYS.minSpeed || Math.abs(vx) > PHYS.minSpeed) {
        this._raf = this.requestFrame(step);
      } else {
        this.vel = { x: 0, y: 0 };
        this.settle();
      }
    };
    step();
    return this;
  }

  cancelPhysics() {
    if (this._raf != null) this.cancelFrame(this._raf);
    this._raf = null;
  }

  settle() {
    const bounds = this.bounds();
    this.pos.x = clamp(this.pos.x, 0, bounds.w - this.size);
    // keep him below the HUD, but never below the floor (tiny windows included)
    this.pos.y = clamp(this.pos.y, Math.min(40, this.floorY), this.floorY);
    this.setExpression(this.expr === 'wow' ? 'happy' : this.expr);
    this.render();
    this.save();
    return this;
  }

  onResize() {
    this.size = this.computeSize();
    const bounds = this.bounds();
    this.artHeight = Math.round((this.size * ART.h) / ART.w);
    this.groundLine = Math.round(bounds.h * GROUND_FRACTION);
    this.floorY = Math.max(0, this.groundLine - this.artHeight);
    this.pos.x = clamp(this.pos.x, 0, Math.max(0, bounds.w - this.size));
    this.pos.y = clamp(this.pos.y, 0, this.floorY);
    this.rootEl?.style.setProperty('--puppet-size', `${this.size}px`);
    this.render();
    return this;
  }

  save() {
    this.store?.set('puppet', { pos: { ...this.pos }, size: this.size, at: this.clock() });
  }

  state() {
    return { anim: this.anim, expr: this.expr, mood: this.mood, look: this.look, dragging: this.dragging, blinking: this.blinking, pos: { ...this.pos }, size: this.size, stats: { ...this.stats } };
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._animTimer);
    clearTimeout(this._pressTimer);
    this.stopIdle();
    this.cancelPhysics();
    for (const off of this.listeners) off();
    this.listeners = [];
    this.bus?.emit('puppet:destroyed', { id: uid('puppet') });
  }
}
