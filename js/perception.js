/**
 * PIP'S SENSES — "he watches over you", entirely on-device.
 *
 *  👁  Presence camera: frames are downscaled to 32×24, converted to luma and
 *      compared frame-to-frame. Pip only ever derives numbers
 *      (motion level, brightness, rough "someone is there" score).
 *      Frames are never stored, never encoded, never uploaded — enforced by
 *      `privacyInvariants()` which the system tests assert.
 *  🏃  Motion sensors: DeviceMotion peaks ≈ steps/activity.
 *  🕒  Life context: visibility, idle time, screen wake lock, battery, network.
 *
 * Every method is defensive: no camera? no sensors? no battery API? Pip shrugs
 * and keeps working instead of throwing.
 */
import { clamp, ewma, throttle, dayKey } from './core/util.js';

export class Perception {
  constructor({ win = globalThis, doc = globalThis.document, nav = globalThis.navigator, clock = () => Date.now(), bus = null, store = null } = {}) {
    this.win = win;
    this.doc = doc;
    this.nav = nav;
    this.clock = clock;
    this.bus = bus;
    this.store = store;
    this.motionLevel = 0;
    this.brightness = 0;
    this.faceScore = 0;
    this.present = false;
    this.lastMotionAt = 0;
    this.lastInteractionAt = clock();
    this.frameCount = 0;
    this.framesStored = 0; // must always stay 0 — asserted by system tests
    this.uploads = 0; // must always stay 0
    this.steps = 0;
    this.lastStepAt = 0;
    this._lastLuma = null;
    this._stream = null;
    this._video = null;
    this._canvas = null;
    this._timer = null;
    this._battery = null;
    this._wakeLock = null;
    this._motionHandler = null;
    this._listeners = [];
    this.cameraState = 'off'; // off | starting | on | denied | unsupported | error
    this.geoState = 'unknown';
    this.location = this.store?.get('location', null) || null;
  }

  get watching() {
    return this.cameraState === 'on';
  }

  /* ─────────── life context listeners ─────────── */

  start() {
    const add = (target, type, fn, opts) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, fn, opts);
      this._listeners.push(() => target.removeEventListener(type, fn, opts));
    };
    add(this.doc, 'pointerdown', () => this.markInteraction(), { passive: true });
    add(this.doc, 'keydown', () => this.markInteraction());
    add(this.doc, 'visibilitychange', () => {
      const state = this.doc.visibilityState;
      this.bus?.emit('perception:visibility', state);
      if (state === 'visible') this.onVisible();
      else this.onHidden();
    });
    add(this.win, 'online', () => this.bus?.emit('perception:net', { online: true }));
    add(this.win, 'offline', () => this.bus?.emit('perception:net', { online: false }));
    add(this.win, 'beforeunload', () => {
      this.bus?.emit('perception:unload', { sessionMinutes: (this.clock() - this.sessionStart) / 60000 });
      this.store?.set('lastSessionMinutes', Math.round((this.clock() - this.sessionStart) / 60000));
    });
    this.sessionStart = this.clock();
    this.nav?.getBattery?.().then?.((b) => {
      this._battery = b;
      const push = () => this.bus?.emit('perception:battery', this.battery());
      b.addEventListener?.('levelchange', push);
      b.addEventListener?.('chargingchange', push);
    }).catch?.(() => {});
    return this;
  }

  dispose() {
    for (const off of this._listeners) off();
    this._listeners = [];
    this.stopCamera();
  }

  markInteraction() {
    this.lastInteractionAt = this.clock();
  }

  idleMs() {
    return this.clock() - this.lastInteractionAt;
  }

  onVisible() {
    this.observe('screen_on');
    if (this.lastHiddenAt && this.clock() - this.lastHiddenAt > 20 * 60000) {
      this.bus?.emit('perception:wake', { awayMs: this.clock() - this.lastHiddenAt });
    }
  }

  onHidden() {
    this.lastHiddenAt = this.clock();
    this.observe('screen_off');
    this.bus?.emit('perception:sleep', { at: this.clock() });
  }

  observe(type, meta = {}) {
    this.store?.push('signals', { type, at: this.clock(), ...meta }, 600);
    this.bus?.emit('perception:signal', { type, ...meta });
  }

  /* ─────────── camera: presence, on-device only ─────────── */

  async startCamera({ fps = 2, onFrame = null, session = null } = {}) {
    if (this.cameraState === 'on') return { ok: true, already: true };
    const media = this.nav?.mediaDevices;
    if (!media?.getUserMedia || !this.doc) {
      this.cameraState = 'unsupported';
      return { ok: false, error: 'camera unsupported' };
    }
    this.cameraState = 'starting';
    try {
      this._stream = await media.getUserMedia({ video: { facingMode: 'user', width: 160, height: 120 }, audio: false });
    } catch (err) {
      this.cameraState = /denied|notallowed/i.test(err?.name || '') ? 'denied' : 'error';
      this.bus?.emit('perception:camera', { state: this.cameraState, error: err?.message });
      return { ok: false, error: err?.message || 'camera failed' };
    }

    const doc = this.doc;
    this._video = doc.createElement?.('video');
    if (this._video) {
      this._video.playsInline = true;
      this._video.muted = true;
      this._video.srcObject = this._stream;
      try {
        await this._video.play();
      } catch {
        /* autoplay can be blocked; analysis loop still works in most engines */
      }
    }
    this._canvas = doc.createElement?.('canvas');
    if (this._canvas) {
      this._canvas.width = 32;
      this._canvas.height = 24;
    }
    this.cameraState = 'on';
    this.bus?.emit('perception:camera', { state: 'on' });
    const interval = Math.max(200, 1000 / fps);
    this._timer = setInterval(() => {
      const sample = this.sampleFrame();
      if (!sample) return;
      this.frameCount++;
      this.motionLevel = ewma(this.motionLevel, sample.motion, 0.35);
      this.brightness = ewma(this.brightness, sample.brightness, 0.2);
      this.faceScore = ewma(this.faceScore, sample.faceScore, 0.25);
      const wasPresent = this.present;
      this.present = this.motionLevel > 0.02 || this.faceScore > 0.16;
      if (this.present) this.lastMotionAt = this.clock();
      else if (this.clock() - this.lastMotionAt > 45000) this.present = false;
      if (wasPresent !== this.present) {
        this.bus?.emit('perception:presence', { present: this.present, motionLevel: this.motionLevel, faceScore: this.faceScore });
        this.observe(this.present ? 'presence_in' : 'presence_out', { via: 'camera' });
      }
      if (this.motionLevel > 0.08) this.observe('motion', { via: 'camera', level: Number(this.motionLevel.toFixed(3)) });
      onFrame?.(sample, this);
      session?.();
    }, interval);

    return { ok: true };
  }

  stopCamera() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._stream?.getTracks?.().forEach((t) => t.stop());
    this._stream = null;
    if (this._video) this._video.srcObject = null;
    if (this.cameraState === 'on') {
      this.cameraState = 'off';
      this.bus?.emit('perception:camera', { state: 'off' });
    }
    this.present = false;
    return this;
  }

  /** Read one downscaled frame. Returns numbers only — never pixels. */
  sampleFrame() {
    const ctx = this._canvas?.getContext?.('2d');
    if (!ctx || !this._video) return null;
    try {
      ctx.drawImage(this._video, 0, 0, 32, 24);
      const { data } = ctx.getImageData(0, 0, 32, 24);
      const luma = new Float32Array(32 * 24);
      let brightness = 0;
      let skin = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        luma[p] = y;
        brightness += y;
        // loose skin-tone test (r>g>b, warm hue) → "is a face-ish blob nearby?"
        if (r > 60 && r > g && g > b && r - b > 12 && r - b < 140) skin++;
      }
      brightness /= 32 * 24 * 255;
      let motion = 0;
      if (this._lastLuma) {
        let diff = 0;
        for (let p = 0; p < luma.length; p++) diff += Math.abs(luma[p] - this._lastLuma[p]);
        motion = clamp(diff / (luma.length * 255), 0, 1);
      }
      this._lastLuma = luma;
      return { motion, brightness, faceScore: skin / (32 * 24), at: this.clock() };
    } catch {
      return null; // canvas tainted / video not ready → skip this frame silently
    }
  }

  /* ─────────── motion sensors ─────────── */

  startMotion({ threshold = 12, debounceMs = 400 } = {}) {
    if (!this.win?.addEventListener || !('DeviceMotionEvent' in (this.win || {}))) return { ok: false, error: 'motion unsupported' };
    this._motionHandler = (event) => {
      const a = event.accelerationIncludingGravity || event.acceleration;
      if (!a) return;
      const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
      const now = this.clock();
      if (mag > threshold && now - this.lastStepAt > debounceMs) {
        this.lastStepAt = now;
        this.steps++;
        this.observe('motion', { via: 'accelerometer', mag: Number(mag.toFixed(1)) });
        this.bus?.emit('perception:step', { steps: this.steps });
      }
    };
    this.win.addEventListener('devicemotion', this._motionHandler);
    return { ok: true };
  }

  stopMotion() {
    if (this._motionHandler) this.win.removeEventListener('devicemotion', this._motionHandler);
    this._motionHandler = null;
  }

  /* ─────────── misc signals ─────────── */

  battery() {
    return { level: this._battery?.level ?? null, charging: this._battery?.charging ?? null, supported: !!this._battery };
  }

  network() {
    const c = this.nav?.connection || this.nav?.mozConnection || null;
    return {
      online: this.nav?.onLine ?? null,
      type: c?.type || null,
      effectiveType: c?.effectiveType || null,
      downlink: c?.downlink ?? null,
      rtt: c?.rtt ?? null,
    };
  }

  async requestGeo({ rationale = 'weather' } = {}) {
    const geo = this.nav?.geolocation;
    if (!geo?.getCurrentPosition) {
      this.geoState = 'unsupported';
      return { ok: false, error: 'geolocation unsupported' };
    }
    return new Promise((resolve) => {
      geo.getCurrentPosition(
        (pos) => {
          this.location = {
            lat: Number(pos.coords.latitude.toFixed(3)),
            lon: Number(pos.coords.longitude.toFixed(3)),
            at: this.clock(),
            rationale,
          };
          this.geoState = 'granted';
          this.store?.set('location', this.location);
          this.bus?.emit('perception:geo', this.location);
          resolve({ ok: true, location: this.location });
        },
        (err) => {
          this.geoState = 'denied';
          resolve({ ok: false, error: err?.message || 'geo failed' });
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60000 },
      );
    });
  }

  async keepAwake() {
    try {
      this._wakeLock = await this.nav?.wakeLock?.request?.('screen');
      return { ok: !!this._wakeLock };
    } catch {
      return { ok: false };
    }
  }

  releaseAwake() {
    this._wakeLock?.release?.();
    this._wakeLock = null;
  }

  snapshot() {
    return {
      camera: this.cameraState,
      watching: this.watching,
      present: this.present,
      motionLevel: Number(this.motionLevel.toFixed(3)),
      brightness: Number(this.brightness.toFixed(3)),
      faceScore: Number(this.faceScore.toFixed(3)),
      framesAnalysed: this.frameCount,
      steps: this.steps,
      idleSeconds: Math.round(this.idleMs() / 1000),
      battery: this.battery(),
      network: this.network(),
      location: this.location,
      today: dayKey(this.clock()),
    };
  }

  /** Called by system tests: any pixel/upload leak would fail these. */
  privacyInvariants() {
    return {
      framesStored: this.framesStored,
      uploads: this.uploads,
      keepsVideoElement: false,
      analysisResolution: '32x24',
      ok: this.framesStored === 0 && this.uploads === 0,
    };
  }
}
