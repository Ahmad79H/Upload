import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../js/scheduler.js';
import { Bus } from '../../js/core/bus.js';
import { makeStore, fakeClock } from '../helpers.mjs';

const setup = (onFire = () => {}) => {
  const store = makeStore();
  const clock = fakeClock();
  const bus = new Bus();
  const scheduler = new Scheduler({ store, clock, bus, onFire });
  return { store, clock, bus, scheduler };
};

test('add() queues an item and returns an id', () => {
  const { scheduler, clock } = setup();
  const id = scheduler.add({ type: 'timer', fireAt: clock() + 60000, label: 'tea' });
  assert.match(id, /^timer_/);
  const list = scheduler.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'tea');
  assert.equal(list[0].type, 'timer');
});

test('tick() fires only what is due and removes one-shot items', () => {
  const fired = [];
  const { scheduler, clock } = setup((item) => fired.push(item.label));
  scheduler.add({ type: 'timer', fireAt: clock() + 1000, label: 'soon' });
  scheduler.add({ type: 'reminder', fireAt: clock() + 600000, label: 'later' });
  assert.deepEqual(scheduler.tick(), [], 'nothing is due yet');
  clock.advance(2000);
  const due = scheduler.tick();
  assert.equal(due.length, 1);
  assert.deepEqual(fired, ['soon']);
  assert.deepEqual(scheduler.list().map((i) => i.label), ['later'], 'fired one-shot is removed');
});

test('repeating items stay queued and reschedule themselves', () => {
  const fired = [];
  const { scheduler, clock } = setup((i) => fired.push(i.label));
  scheduler.add({ type: 'nudge', fireAt: clock() + 1000, label: 'drink water', repeatMs: 60000 });
  clock.advance(1000);
  scheduler.tick();
  scheduler.tick();
  assert.deepEqual(fired, ['drink water'], 'the same occurrence is not fired twice');
  clock.advance(60000);
  scheduler.tick();
  assert.deepEqual(fired, ['drink water', 'drink water']);
  assert.equal(scheduler.list().length, 1);
});

test('recurring reminders can add a follow-up nag', () => {
  const fired = [];
  const { scheduler, clock } = setup((i) => fired.push(i.label));
  scheduler.add({ type: 'reminder', fireAt: clock() + 500, label: 'stand up', payload: { nagAfterMs: 60000 } });
  clock.advance(600);
  scheduler.tick();
  assert.deepEqual(fired, ['stand up']);
  assert.equal(scheduler.list().length, 1, 'the follow-up is queued');
  clock.advance(60000);
  scheduler.tick();
  assert.deepEqual(fired, ['stand up', 'stand up (follow-up)']);
  assert.equal(scheduler.list().length, 0, 'the nag does not nag forever');
});

test('cancel() removes exactly one item', () => {
  const { scheduler, clock } = setup();
  const a = scheduler.add({ type: 'timer', fireAt: clock() + 1000, label: 'a' });
  scheduler.add({ type: 'timer', fireAt: clock() + 1000, label: 'b' });
  assert.equal(scheduler.cancel(a), 1);
  assert.deepEqual(scheduler.list().map((i) => i.label), ['b']);
  assert.equal(scheduler.cancel('nope'), 0);
});

test('a broken onFire callback cannot break the scheduler', () => {
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const { scheduler, clock } = setup(() => {
    throw new Error('callback died');
  });
  scheduler.add({ type: 'timer', fireAt: clock() + 1, label: 'x' });
  clock.advance(10);
  assert.doesNotThrow(() => scheduler.tick());
  console.error = origError;
  assert.match(errors.join(), /onFire failed/);
});

test('queue survives a reload, including items that came due while closed', () => {
  const store = makeStore();
  const clock = fakeClock();
  const first = new Scheduler({ store, clock });
  first.add({ type: 'reminder', fireAt: clock() + 3 * 3600000, label: 'prayer' });
  first.add({ type: 'timer', fireAt: clock() + 10, label: 'missed while closed' });
  clock.advance(2 * 3600000);
  const fired = [];
  const second = new Scheduler({ store, clock, onFire: (i) => fired.push(i.label) });
  second.start();
  second.stop();
  assert.deepEqual(fired, ['missed while closed'], 'overdue items fire on wake');
  assert.deepEqual(second.list().map((i) => i.label), ['prayer']);
});

test('start() ticks on an interval and stop() halts it', async () => {
  const fired = [];
  const { scheduler, clock } = setup((i) => fired.push(i.label));
  scheduler.tickMs = 5;
  scheduler.add({ type: 'timer', fireAt: clock() + 1, label: 'tick' });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 15));
  clock.advance(10);
  await new Promise((r) => setTimeout(r, 30));
  scheduler.stop();
  assert.ok(fired.length >= 1);
  assert.equal(scheduler._timer, null);
});

test('describe() is human readable and bus events are emitted', () => {
  const { scheduler, clock, bus } = setup();
  const events = [];
  bus.on('*', (_p, e) => events.push(e));
  scheduler.add({ type: 'timer', fireAt: clock() + 60000, label: 'tea' });
  clock.advance(70000);
  scheduler.tick();
  assert.ok(events.includes('schedule:added'));
  assert.ok(events.includes('schedule:fire'));
  assert.ok(scheduler.describe().length === 0);
});

test('the saved queue is capped so localStorage cannot explode', () => {
  const { scheduler, clock, store } = setup();
  for (let i = 0; i < 250; i++) scheduler.add({ type: 'timer', fireAt: clock() + i * 1000, label: `t${i}` });
  assert.ok(scheduler.queue.length >= 200, 'in memory it keeps everything for this session');
  assert.ok(store.get('schedule').length <= 200, 'but never persists more than 200 items');
});
