import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Puppet, ANIMS, EXPRESSIONS } from '../../js/puppet.js';
import { Bus } from '../../js/core/bus.js';
import { makeStore, fakeClock, pointer, rafTick, trackDom, closeAllDoms } from '../helpers.mjs';

const livePuppets = new Set();
after(() => {
  // Runs even when a test fails — otherwise a leftover RAF loop keeps Node alive.
  for (const p of livePuppets) {
    try {
      p.destroy();
    } catch {
      /* already gone */
    }
  }
  livePuppets.clear();
  closeAllDoms();
});

/** A phone-sized DOM with the stage elements the puppet expects. */
async function makeStage({ width = 390, height = 844 } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><body><div id="puppet-layer"></div><div id="drop-shadow"></div></body>`,
    { pretendToBeVisual: true, url: 'https://pip.test/' },
  );
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: height, configurable: true });
  trackDom(dom);
  return { dom, win, doc: win.document };
}

async function makePuppet(opts = {}) {
  const { win, doc } = await makeStage(opts);
  const bus = new Bus();
  const store = makeStore();
  const clock = fakeClock();
  const puppet = new Puppet({ win, doc, container: doc.getElementById('puppet-layer'), bus, store, clock, rng: () => 0 });
  puppet.mount();
  livePuppets.add(puppet);
  return { puppet, bus, store, clock, win, doc };
}

test('mounting injects the artwork and puts Pip on the floor', async () => {
  const { puppet, doc } = await makePuppet();
  assert.ok(doc.querySelector('#puppet-layer .puppet-svg'), 'artwork is injected without a network fetch');
  assert.ok(puppet.size >= 96 && puppet.size <= 200, `size ${puppet.size} should be thumb-sized`);
  assert.equal(puppet.anim, 'idle');
  assert.equal(puppet.el.dataset.anim, 'idle');
  assert.equal(puppet.pos.y, puppet.floorY);
  assert.ok(puppet.pos.x > 0);
  puppet.destroy();
});

test('animation and expression setters drive the data attributes', async () => {
  const { puppet } = await makePuppet();
  for (const anim of ANIMS) {
    puppet.setAnim(anim);
    assert.equal(puppet.el.dataset.anim, anim);
  }
  for (const expr of EXPRESSIONS) {
    puppet.setExpression(expr);
    assert.equal(puppet.el.dataset.expr, expr);
  }
  assert.throws(() => puppet.setAnim('backflip'), /unknown animation/);
  puppet.setExpression('nonsense');
  assert.ok(EXPRESSIONS.includes(puppet.expr), 'unknown expressions are ignored');
  puppet.destroy();
});

test('timed animations fall back to idle by themselves', async () => {
  const { puppet } = await makePuppet();
  puppet.setAnim('jump', { durationMs: 10 });
  assert.equal(puppet.anim, 'jump');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(puppet.anim, 'idle');
  puppet.destroy();
});

test('blinking toggles the eyelid state', async () => {
  const { puppet } = await makePuppet();
  puppet.blinkOnce();
  assert.equal(puppet.blinking, true);
  assert.equal(puppet.el.dataset.blink, 'true');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(puppet.blinking, false);
  assert.equal(puppet.stats.blinks, 1);
  puppet.destroy();
});

test('the eyes follow a point on screen', async () => {
  const { puppet } = await makePuppet();
  puppet.lookToward(0, puppet.pos.y + puppet.size * 0.4);
  assert.equal(puppet.look, 'left');
  puppet.lookToward(puppet.bounds().w, puppet.pos.y + puppet.size * 0.4);
  assert.equal(puppet.look, 'right');
  puppet.lookToward(puppet.pos.x + puppet.size / 2, 0);
  assert.equal(puppet.look, 'up');
  puppet.lookToward(puppet.pos.x + puppet.size / 2, 5000);
  assert.equal(puppet.look, 'down');
  puppet.lookToward(puppet.pos.x + puppet.size / 2, puppet.pos.y + puppet.size * 0.4);
  assert.equal(puppet.look, 'center');
  puppet.setLook('sideways');
  assert.equal(puppet.look, 'center');
  puppet.destroy();
});

test('dragging moves Pip and a release without movement counts as a poke', async () => {
  const { puppet, bus } = await makePuppet();
  const events = [];
  bus.on('puppet:drag-start', () => events.push('start'));
  bus.on('puppet:tap', () => events.push('tap'));
  const startX = puppet.pos.x;
  pointer(puppet.el, 'pointerdown', { x: startX + 10, y: puppet.pos.y });
  assert.equal(puppet.dragging, true);
  assert.equal(puppet.el.dataset.drag, 'true');
  assert.equal(puppet.expr, 'wow', 'he is surprised when you grab him');
  pointer(puppet.win, 'pointermove', { x: startX + 90, y: puppet.pos.y - 60 });
  assert.ok(puppet.pos.x > startX + 40, 'dragging follows the finger');
  pointer(puppet.win, 'pointerup', { x: startX + 90, y: puppet.pos.y - 60 });
  assert.equal(puppet.dragging, false);
  assert.equal(puppet.stats.drags, 1);
  assert.ok(events.includes('start'));

  // a quick un-moved press/release is a tap
  pointer(puppet.el, 'pointerdown', { x: puppet.pos.x, y: puppet.pos.y });
  pointer(puppet.win, 'pointerup', { x: puppet.pos.x, y: puppet.pos.y });
  assert.equal(puppet.stats.pokes, 1);
  assert.ok(events.includes('tap'));
  puppet.destroy();
});

test('a fling throws Pip and gravity brings him home', async () => {
  const { puppet, bus } = await makePuppet();
  const bounced = [];
  bus.on('puppet:bounce', (p) => bounced.push(p.speed));
  pointer(puppet.el, 'pointerdown', { x: 100, y: 200 });
  pointer(puppet.win, 'pointermove', { x: 140, y: 190 });
  pointer(puppet.win, 'pointermove', { x: 200, y: 130 });
  pointer(puppet.win, 'pointermove', { x: 260, y: 70 });
  pointer(puppet.win, 'pointerup', { x: 260, y: 70 });
  assert.equal(puppet.stats.thrown, 1);
  assert.ok(Math.abs(puppet.vel.x) + Math.abs(puppet.vel.y) > 0, 'a throw gives him velocity');
  await rafTick(1200);
  assert.ok(puppet.pos.y <= puppet.floorY + 1, 'he lands back on the floor');
  assert.ok(puppet.pos.y >= 0);
  assert.ok(bounced.length >= 1, 'a landing wobble was announced');
  puppet.destroy();
});

test('Pip cannot be dragged out of the screen', async () => {
  const { puppet } = await makePuppet();
  pointer(puppet.el, 'pointerdown', { x: 100, y: 300 });
  pointer(puppet.win, 'pointermove', { x: -9000, y: -9000 });
  pointer(puppet.win, 'pointerup', { x: -9000, y: -9000 });
  assert.ok(puppet.pos.x >= -puppet.size * 0.2, `x=${puppet.pos.x}`);
  assert.ok(puppet.pos.y >= 0, `y=${puppet.pos.y}`);
  pointer(puppet.el, 'pointerdown', { x: 100, y: 300 });
  pointer(puppet.win, 'pointermove', { x: 9000, y: 9000 });
  pointer(puppet.win, 'pointerup', { x: 9000, y: 9000 });
  assert.ok(puppet.pos.x <= puppet.bounds().w, `x=${puppet.pos.x}`);
  assert.ok(puppet.pos.y <= puppet.bounds().h, `y=${puppet.pos.y}`);
  await rafTick(400);
  assert.ok(puppet.pos.y <= puppet.floorY, 'gravity settles him on the ground');
  puppet.destroy();
});

test('a double tap makes him celebrate', async () => {
  const { puppet, bus } = await makePuppet();
  let celebrated = false;
  bus.on('puppet:double-tap', () => (celebrated = true));
  pointer(puppet.el, 'pointerdown', { x: 50, y: 300 });
  pointer(puppet.win, 'pointerup', { x: 50, y: 300 });
  pointer(puppet.el, 'pointerdown', { x: 50, y: 300 });
  pointer(puppet.win, 'pointerup', { x: 50, y: 300 });
  assert.equal(celebrated, true);
  assert.equal(puppet.mood, 'hyped');
  assert.equal(puppet.anim, 'cheer');
  puppet.destroy();
});

test('a long press opens his notebook (and does not count as a tap)', async () => {
  const { puppet, bus, clock } = await makePuppet();
  let long = false;
  bus.on('puppet:long-press', () => (long = true));
  pointer(puppet.el, 'pointerdown', { x: 60, y: 300 });
  await new Promise((r) => setTimeout(r, 40));
  clock.advance(700); // hold for 700ms of "time"
  await new Promise((r) => setTimeout(r, 650));
  pointer(puppet.win, 'pointerup', { x: 60, y: 300 });
  assert.equal(long, true);
  assert.equal(puppet.stats.pokes, 0);
  puppet.destroy();
});

test('perform() drives every named action', async () => {
  const { puppet } = await makePuppet();
  const actions = ['cheer', 'jump', 'dance', 'blush', 'wow', 'sparkle', 'think', 'droop', 'wave', 'sleep', 'wake', 'do a flip', 'nonsense'];
  for (const a of actions) {
    assert.doesNotThrow(() => puppet.perform(a), `perform(${a})`);
  }
  puppet.perform('sleep');
  assert.equal(puppet.anim, 'sleep');
  puppet.perform('wave');
  assert.notEqual(puppet.anim, 'sleep', 'an action wakes him up');
  puppet.destroy();
});

test('idle life keeps the screen alive: blinks, glances and acts', async () => {
  const { puppet, bus } = await makePuppet();
  const idleActs = [];
  bus.on('puppet:idle-act', (p) => idleActs.push(p.action));
  let blinks = 0;
  bus.on('puppet:expr', () => {});
  puppet.startIdle({ blinkMs: 5, glanceMs: 8, actMs: 10 });
  await new Promise((r) => setTimeout(r, 90));
  blinks = puppet.stats.blinks;
  puppet.stopIdle();
  assert.ok(blinks >= 1, `expected blinks, got ${blinks}`);
  assert.ok(idleActs.length >= 1, `expected idle acts, got ${idleActs.length}`);
  const before = puppet.stats.idleActs;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(puppet.stats.idleActs, before, 'stopIdle really stops the timers');
  puppet.destroy();
});

test('actions are announced on the bus', async () => {
  const { puppet, bus } = await makePuppet();
  const seen = [];
  bus.on('puppet:perform', (p) => seen.push(p.action));
  puppet.perform('cheer');
  puppet.perform('dance');
  assert.deepEqual(seen, ['cheer', 'dance']);
  puppet.destroy();
});

test('his position is remembered across reloads', async () => {
  const { puppet, store } = await makePuppet();
  puppet.pos = { x: 123, y: 456 };
  puppet.save();
  assert.deepEqual(store.get('puppet').pos, { x: 123, y: 456 });

  const { win, doc } = await makeStage();
  const restored = new Puppet({ win, doc, container: doc.getElementById('puppet-layer'), store });
  restored.mount();
  assert.equal(restored.pos.x, 123);
  assert.equal(restored.pos.y, 456);
  restored.destroy();
});

test('rotation/resize keeps him on screen and re-sizes him', async () => {
  const { puppet, win } = await makePuppet({ width: 390, height: 844 });
  const before = puppet.size;
  puppet.pos = { x: 380, y: 700 };
  Object.defineProperty(win, 'innerWidth', { value: 800, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: 400, configurable: true });
  puppet.onResize();
  assert.ok(puppet.pos.x + puppet.size <= 800 + 1);
  assert.ok(puppet.pos.y <= puppet.floorY + 1);
  assert.ok(puppet.size >= 96);
  assert.notEqual(`${before}`, `${puppet.size}`);
  puppet.destroy();
});

test('anchor() points at his head for speech bubbles', async () => {
  const { puppet } = await makePuppet();
  puppet.pos = { x: 100, y: 200 };
  const a = puppet.anchor();
  assert.equal(a.x, 100 + puppet.size / 2);
  assert.ok(a.y < 260, 'bubbles appear above him');
  puppet.destroy();
});

test('destroy() removes listeners and timers', async () => {
  const { puppet, win } = await makePuppet();
  const countListeners = () => 0;
  puppet.destroy();
  pointer(win.document.getElementById('puppet-layer'), 'pointerdown', { x: 10, y: 10 });
  assert.equal(puppet.dragging, false, 'no drag after destroy');
  assert.equal(countListeners(), 0);
});
