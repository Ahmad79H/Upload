import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../../js/memory.js';
import { makeStore, fakeClock, makePool } from '../helpers.mjs';

const setup = (opts = {}) => {
  const store = makeStore();
  const clock = fakeClock();
  const memory = new Memory({ store, clock, ...opts });
  return { store, clock, memory };
};

test('remember stores, dedupes and normalises whitespace', () => {
  const { memory } = setup();
  const first = memory.remember('I love mangoes', { tag: 'fact' });
  assert.ok(first.id.startsWith('mem_'));
  assert.equal(memory.all().length, 1);

  const dupe = memory.remember('  i   love   MANGOES ', { tag: 'fact' });
  assert.equal(dupe.merged, true);
  assert.equal(memory.all().length, 1, 'near-duplicates merge instead of stacking up');
  assert.equal(memory.all()[0].hits, 2);

  assert.equal(memory.remember(''), null);
  assert.equal(memory.remember(null), null);
  assert.equal(memory.all().length, 1);
});

test('profile extraction learns the important facts', () => {
  const { memory } = setup();
  memory.remember('my name is Ahmad', { tag: 'fact' });
  memory.remember('i live in Taunsa', { tag: 'fact' });
  memory.remember('i like biryani and coding', { tag: 'fact' });
  memory.remember('i hate loud noises', { tag: 'fact' });
  memory.remember('my birthday is 12 March', { tag: 'fact' });
  memory.remember('i work at a software house', { tag: 'fact' });
  const profile = memory.profile();
  assert.equal(profile.name, 'Ahmad');
  assert.equal(profile.city, 'Taunsa');
  assert.ok(profile.likes.some((l) => /biryani/.test(l)));
  assert.ok(profile.dislikes.some((l) => /loud/.test(l)));
  assert.match(profile.birthday, /12 March/);
  assert.ok(profile.work);
  assert.ok(profile.lastSeen);
});

test('search ranks by lexical overlap and honours limit/minScore', async () => {
  const { memory } = setup();
  memory.remember('I love mangoes from Multan', { tag: 'fact', importance: 0.9 });
  memory.remember('My favourite anime is My Hero Academia', { tag: 'fact', importance: 0.8 });
  memory.remember('I wake up at 7am on weekdays', { tag: 'habit' });
  const hits = await memory.search('mangoes', { limit: 2 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /mangoes/);
  assert.ok(hits[0].score >= 0.12);
  const none = await memory.search('quantum tunnelling', { minScore: 0.5 });
  assert.deepEqual(none, []);
  assert.deepEqual(await memory.search('', {}), []);
});

test('embeddings are used when a pool is available, with graceful fallback', async () => {
  const pool = makePool();
  let embedCalls = 0;
  const orig = pool.embed.bind(pool);
  pool.embed = async (...a) => {
    embedCalls++;
    return orig(...a);
  };
  const { memory } = setup({ pool });
  memory.remember('I am learning to play the guitar', { importance: 0.7 });
  memory.remember('My sister is a doctor', { importance: 0.7 });
  const hits = await memory.search('who plays guitar', { limit: 1 });
  assert.equal(embedCalls, 1);
  assert.ok(hits.length >= 1);

  const broken = makePool();
  broken.embed = async () => {
    throw new Error('embedder down');
  };
  const { memory: m2 } = setup({ pool: broken });
  m2.remember('I am learning to play the guitar');
  const fallback = await m2.search('guitar');
  assert.ok(fallback.length >= 1, 'lexical search still works when embeddings fail');
});

test('contextBlock is compact and includes the profile', async () => {
  const { memory } = setup();
  memory.remember('my name is Ahmad');
  memory.remember('I love mangoes');
  memory.remember('I wake up at 7am');
  const block = await memory.contextBlock('mangoes', { limit: 3 });
  assert.match(block, /user name: Ahmad/);
  assert.match(block, /likes: mangoes/);
  assert.match(block, /mangoes/);
  assert.ok(block.split('\n').length <= 8);
});

test('forget by id and fuzzy query both work', () => {
  const { memory } = setup();
  const a = memory.remember('I live in Taunsa');
  memory.remember('I love mangoes');
  assert.equal(memory.forgetById(a.id), 1);
  assert.equal(memory.all().length, 1);
  assert.equal(memory.forget('mangoes'), 1);
  assert.equal(memory.all().length, 0);
  assert.equal(memory.forget('nothing like this'), 0);
});

test('memory survives a reload through the store and stays capped', () => {
  const store = makeStore();
  const clock = fakeClock();
  const memory = new Memory({ store, clock, maxEntries: 5 });
  for (let i = 0; i < 12; i++) memory.remember(`fact number ${i}`);
  assert.equal(memory.entries.length, 12);
  const reloaded = new Memory({ store, clock, maxEntries: 5 });
  assert.ok(reloaded.entries.length <= 5, `store should be trimmed, got ${reloaded.entries.length}`);
  assert.match(reloaded.entries.at(-1).text, /fact number 11/);
});

test('clear wipes the notebook but not the learned profile', () => {
  const { memory } = setup();
  memory.remember('my name is Ahmad');
  memory.clear();
  assert.deepEqual(memory.all(), []);
  assert.equal(memory.profile().name, 'Ahmad');
});

test('memory is local: no fetch is needed to remember or search', async () => {
  const store = makeStore();
  const memory = new Memory({ store, clock: fakeClock(), pool: null });
  memory.remember('I have a cat named Mochi');
  const hits = await memory.search('cat');
  assert.match(hits[0].text, /Mochi/);
});
