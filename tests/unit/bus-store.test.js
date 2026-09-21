import test from 'node:test';
import assert from 'node:assert/strict';
import { Bus, bus } from '../../js/core/bus.js';
import { Store, makeMemoryStorage } from '../../js/core/store.js';

test('bus delivers to listeners and returns an unsubscribe', () => {
  const b = new Bus();
  const seen = [];
  const off = b.on('ping', (p) => seen.push(p));
  assert.equal(b.emit('ping', 1), true);
  off();
  b.emit('ping', 2);
  assert.deepEqual(seen, [1]);
});

test('bus wildcard listeners see everything, in order', () => {
  const b = new Bus();
  const order = [];
  b.on('*', (payload, event) => order.push(`*:${event}`));
  b.on('a', () => order.push('a'));
  b.on('b', () => order.push('b'));
  b.emit('a');
  b.emit('b');
  assert.deepEqual(order, ['a', '*:a', 'b', '*:b']);
});

test('a throwing listener never breaks the emitter', () => {
  const b = new Bus();
  const errs = [];
  const origError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  b.on('boom', () => {
    throw new Error('listener exploded');
  });
  let reached = false;
  b.on('boom', () => (reached = true));
  const clean = b.emit('boom', {});
  console.error = origError;
  assert.equal(clean, false);
  assert.equal(reached, true, 'later listeners still run');
  assert.match(errs.join(), /listener exploded/);
});

test('once() fires exactly one time and off() is idempotent', () => {
  const b = new Bus();
  let n = 0;
  b.once('go', () => n++);
  b.emit('go');
  b.emit('go');
  assert.equal(n, 1);
  assert.doesNotThrow(() => b.off('never-registered', () => {}));
});

test('bus history is capped and countable', () => {
  const b = new Bus();
  b.historyLimit = 3;
  for (let i = 0; i < 6; i++) b.emit('x', i);
  assert.equal(b.history.length, 3);
  assert.equal(b.history.at(-1).payload, 5);
  b.clear();
  assert.equal(b.history.length, 0);
});

test('the shared bus singleton exists and is a Bus', () => {
  assert.ok(bus instanceof Bus);
});

test('store round-trips values and namespaces keys', () => {
  const storage = makeMemoryStorage();
  const store = new Store({ storage });
  store.set('settings', { pack: 'deku' });
  assert.deepEqual(store.get('settings'), { pack: 'deku' });
  assert.ok(storage.getItem('pip.settings'));
  assert.deepEqual(store.keys(), ['settings']);
});

test('store.push appends with a cap', () => {
  const store = new Store({ storage: makeMemoryStorage() });
  for (let i = 0; i < 12; i++) store.push('signals', { i }, 5);
  const arr = store.get('signals');
  assert.equal(arr.length, 5);
  assert.equal(arr.at(-1).i, 11);
});

test('store.update mutates through a function', () => {
  const store = new Store({ storage: makeMemoryStorage() });
  store.update('n', 0, (v) => v + 1);
  store.update('n', 0, (v) => v + 1);
  assert.equal(store.get('n'), 2);
});

test('store survives a hostile storage backend (quota / privacy mode)', () => {
  const broken = {
    get length() {
      return 0;
    },
    key: () => null,
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  };
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  const store = new Store({ storage: broken });
  assert.doesNotThrow(() => store.set('a', 1));
  console.warn = orig;
  assert.equal(store.get('a'), 1, 'value is still available from memory');
  assert.match(warnings.join(), /write failed/);
});

test('store export/import round-trips and can merge', () => {
  const a = new Store({ storage: makeMemoryStorage() });
  a.set('x', 1);
  a.set('y', [1, 2]);
  const dump = a.export();
  assert.equal(dump.v, 1);

  const b = new Store({ storage: makeMemoryStorage() });
  b.import(dump);
  assert.equal(b.get('x'), 1);
  assert.deepEqual(b.get('y'), [1, 2]);

  b.import({ data: { z: 9 } }, { merge: true });
  assert.equal(b.get('x'), 1);
  assert.equal(b.get('z'), 9);

  b.import({ data: { only: true } });
  assert.equal(b.get('x'), null, 'non-merge import replaces everything');
  assert.throws(() => b.import({}), /bad payload/);
});

test('store subscribers are notified and errors do not propagate', () => {
  const store = new Store({ storage: makeMemoryStorage() });
  const seen = [];
  store.subscribe((key) => seen.push(key));
  store.subscribe(() => {
    throw new Error('bad subscriber');
  });
  const orig = console.error;
  console.error = () => {};
  store.set('k', 1);
  console.error = orig;
  assert.deepEqual(seen, ['k']);
});

test('store.remove deletes a key and size() reports bytes', () => {
  const store = new Store({ storage: makeMemoryStorage() });
  store.set('big', 'x'.repeat(100));
  assert.ok(store.size() > 100);
  store.remove('big');
  assert.equal(store.get('big'), null);
  assert.deepEqual(store.keys(), []);
});

test('store.clearAll wipes everything', () => {
  const store = new Store({ storage: makeMemoryStorage() });
  store.set('a', 1);
  store.set('b', 2);
  store.clearAll();
  assert.deepEqual(store.keys(), []);
});
