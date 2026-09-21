import test from 'node:test';
import assert from 'node:assert/strict';
import { Perception } from '../../js/perception.js';
import { Bus } from '../../js/core/bus.js';
import { makeStore, fakeClock } from '../helpers.mjs';

/** A fake window/navigator/document pair that behaves like a phone. */
function fakePhone({ camera = 'ok', battery = true, geo = 'ok', motion = true } = {}) {
  const listeners = new Map();
  const win = {
    innerWidth: 390,
    innerHeight: 844,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, payload) {
      for (const fn of listeners.get(type) || []) fn({ type, ...payload });
    },
  };
  const video = { play: async () => {}, srcObject: null, muted: false, playsInline: false };
  const canvas = { width: 0, height: 0, getContext: () => null, toDataURL: () => 'data:,' };
  const doc = {
    visibilityState: 'visible',
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    createElement: (tag) => (tag === 'video' ? video : canvas),
    getElementById: () => null,
  };
  const batteryObj = {
    level: 0.4,
    charging: false,
    addEventListener() {},
  };
  const nav = {
    onLine: true,
    connection: { effectiveType: '4g', type: 'wifi' },
    mediaDevices: {
      getUserMedia: async (constraints) => {
        if (camera === 'denied') throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        if (camera === 'broken') throw new Error('hardware exploded');
        return { getTracks: () => [{ stop() {} }] };
      },
    },
    getBattery: battery ? async () => batteryObj : undefined,
    geolocation: {
      getCurrentPosition: (ok, fail) => (geo === 'ok' ? ok({ coords: { latitude: 30.7123, longitude: 70.6489 } }) : fail(new Error('denied by user'))),
    },
  };
  win.navigator = nav;
  if (motion) win.DeviceMotionEvent = function DeviceMotionEvent() {};
  return { win, doc, nav, video, canvas, batteryObj, listeners };
}

test('lifecycle listeners emit the right signals', () => {
  const { win, doc, nav } = fakePhone();
  const store = makeStore();
  const bus = new Bus();
  const signals = [];
  bus.on('perception:signal', (s) => signals.push(s.type));
  const perception = new Perception({ win, doc, nav, store, bus, clock: fakeClock() });
  perception.start();
  doc.visibilityState = 'hidden';
  win.dispatch('visibilitychange');
  doc.visibilityState = 'visible';
  win.dispatch('visibilitychange');
  win.dispatch('online');
  assert.deepEqual(signals, ['screen_off', 'screen_on']);
  assert.ok(store.get('signals').length >= 2);
  perception.markInteraction();
  assert.equal(perception.idleMs(), 0);
  perception.dispose();
});

test('privacy invariants are enforced no matter what the camera does', async () => {
  const { win, doc, nav } = fakePhone();
  const perception = new Perception({ win, doc, nav, clock: fakeClock(), store: makeStore() });
  const res = await perception.startCamera({ fps: 30 });
  assert.equal(res.ok, true);
  assert.equal(perception.cameraState, 'on');
  perception.frameCount = 42; // pretend frames were analysed
  const inv = perception.privacyInvariants();
  assert.equal(inv.ok, true);
  assert.equal(inv.framesStored, 0);
  assert.equal(inv.uploads, 0);
  assert.equal(inv.analysisResolution, '32x24');
  assert.equal(perception._video.srcObject === null, false, 'the raw stream stays inside the perception module');
  perception.stopCamera();
  assert.equal(perception.cameraState, 'off');
  assert.equal(perception._stream, null, 'camera track is released on stop');
});

test('camera permission denial is handled gracefully', async () => {
  const { win, doc, nav } = fakePhone({ camera: 'denied' });
  const perception = new Perception({ win, doc, nav, clock: fakeClock(), store: makeStore() });
  const res = await perception.startCamera();
  assert.equal(res.ok, false);
  assert.equal(perception.cameraState, 'denied');
  const broken = new Perception({ win, doc, nav: { ...nav, mediaDevices: { getUserMedia: async () => { throw new Error('nope'); } } }, clock: fakeClock() });
  assert.equal((await broken.startCamera()).ok, false);
  const unsupported = new Perception({ win, doc, nav: { mediaDevices: {} }, clock: fakeClock() });
  assert.equal((await unsupported.startCamera()).ok, false);
  assert.equal(unsupported.cameraState, 'unsupported');
});

test('sampleFrame returns numbers only, and null when the canvas is unusable', async () => {
  const { win, doc, nav } = fakePhone();
  const perception = new Perception({ win, doc, nav, clock: fakeClock() });
  await perception.startCamera({ fps: 4 });
  assert.equal(perception.sampleFrame(), null, 'jsdom has no canvas — must not throw');
  // now give it a working canvas that reports luma differences
  let frame = 0;
  perception._canvas.getContext = () => ({
    drawImage() {},
    getImageData: () => {
      frame++;
      const data = new Uint8ClampedArray(32 * 24 * 4);
      for (let i = 0; i < data.length; i += 4) {
        const v = frame === 1 ? 10 : 200;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
      return { data };
    },
  });
  const first = perception.sampleFrame();
  assert.ok(first && typeof first.motion === 'number');
  assert.equal(first.motion, 0, 'first frame has nothing to compare against');
  const second = perception.sampleFrame();
  assert.ok(second.motion > 0.5, `motion should spike, got ${second.motion}`);
  assert.ok(!('data' in second) && !('pixels' in second), 'pixels never leave sampleFrame');
  perception.stopCamera();
});

test('motion sensor counts steps with debouncing', () => {
  const { win, doc, nav } = fakePhone({ motion: true });
  const clock = fakeClock();
  const perception = new Perception({ win, doc, nav, clock, store: makeStore() });
  const seconds = perception.startMotion({ threshold: 12, debounceMs: 300 });
  assert.equal(seconds.ok, true);
  win.dispatch('devicemotion', { accelerationIncludingGravity: { x: 0, y: 0, z: 20 } });
  win.dispatch('devicemotion', { accelerationIncludingGravity: { x: 0, y: 0, z: 21 } });
  assert.equal(perception.steps, 1, 'debounce stops double counting');
  clock.advance(400);
  win.dispatch('devicemotion', { accelerationIncludingGravity: { x: 0, y: 0, z: 25 } });
  assert.equal(perception.steps, 2);
  perception.stopMotion();
  win.dispatch('devicemotion', { accelerationIncludingGravity: { x: 0, y: 0, z: 30 } });
  assert.equal(perception.steps, 2, 'listener is removed');
  const unsupported = new Perception({ win: {}, doc, nav, clock });
  assert.equal(unsupported.startMotion().ok, false);
});

test('battery, network and geolocation degrade politely', async () => {
  const { win, doc, nav } = fakePhone();
  const perception = new Perception({ win, doc, nav, clock: fakeClock(), store: makeStore() });
  perception.start();
  await new Promise((r) => setTimeout(r, 5));
  const bat = perception.battery();
  assert.equal(bat.supported, true);
  assert.equal(bat.level, 0.4);
  assert.equal(perception.network().effectiveType, '4g');
  const geo = await perception.requestGeo();
  assert.equal(geo.ok, true);
  assert.equal(perception.location.lat, 30.712);
  assert.equal(perception.geoState, 'granted');

  const denied = new Perception({ win, doc, nav, clock: fakeClock(), store: makeStore() });
  nav.geolocation = { getCurrentPosition: (ok, fail) => fail(new Error('nope')) };
  assert.equal((await denied.requestGeo()).ok, false);
  assert.equal(denied.geoState, 'denied');
  const none = new Perception({ win, doc, nav: {}, clock: fakeClock() });
  assert.equal((await none.requestGeo()).ok, false);
  assert.equal(none.battery().supported, false);
  assert.equal(none.network().online, null);
});

test('wake lock is requested and released without exploding', async () => {
  const released = [];
  const { win, doc, nav } = fakePhone();
  nav.wakeLock = { request: async () => ({ release: () => released.push(1) }) };
  const perception = new Perception({ win, doc, nav, clock: fakeClock() });
  assert.equal((await perception.keepAwake()).ok, true);
  perception.releaseAwake();
  assert.equal(released.length, 1);
  const none = new Perception({ win, doc, nav: {}, clock: fakeClock() });
  assert.equal((await none.keepAwake()).ok, false);
});

test('snapshot is JSON-safe and describes the senses', async () => {
  const { win, doc, nav } = fakePhone();
  const perception = new Perception({ win, doc, nav, clock: fakeClock(), store: makeStore() });
  await perception.startCamera({ fps: 2 });
  const snap = perception.snapshot();
  assert.equal(snap.camera, 'on');
  assert.equal(snap.watching, true);
  assert.equal(typeof snap.framesAnalysed, 'number');
  assert.equal(snap.analysisResolution, undefined);
  assert.ok(JSON.stringify(snap).length > 50);
  assert.equal(JSON.parse(JSON.stringify(snap)).camera, 'on');
  perception.stopCamera();
});
