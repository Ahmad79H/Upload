import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, lerp, round, uid, safeJson, withTimeout, retry, mean, median, ewma,
  tokenize, cosine, parseWhen, humanDuration, humanDay, partOfDay, dayKey, hourOf,
  pick, pickMany, throttle, debounce, escapeHtml, bagOfWords, bagVector, minutesOfDay,
} from '../../js/core/util.js';

test('clamp / lerp / round basics', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-2, 0, 3), 0);
  assert.equal(clamp(1.5, 0, 3), 1.5);
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(round(1.23456, 2), 1.23);
  assert.equal(round(1.005, 1), 1);
});

test('uid is unique and prefixed', () => {
  const ids = new Set(Array.from({ length: 500 }, () => uid('t')));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^t_/);
});

test('safeJson survives real model output', () => {
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.deepEqual(safeJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(safeJson('Sure! here you go: {"a":3} hope that helps'), { a: 3 });
  assert.deepEqual(safeJson('not json at all', { fallback: true }), { fallback: true });
  assert.equal(safeJson(null, 'x'), 'x');
  assert.deepEqual(safeJson({ already: 'object' }), { already: 'object' });
});

test('withTimeout rejects slow work and resolves fast work', async () => {
  await assert.doesNotReject(withTimeout(Promise.resolve('ok'), 100, 'fast'));
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'slow'), /slow after 20ms/);
});

test('retry backs off then succeeds', async () => {
  let attempts = 0;
  const value = await retry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error('flaky');
      return 'finally';
    },
    { tries: 5, base: 1, max: 2 },
  );
  assert.equal(value, 'finally');
  assert.equal(attempts, 3);
  await assert.rejects(retry(async () => { throw new Error('always'); }, { tries: 2, base: 1 }), /always/);
});

test('statistics helpers', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(ewma(null, 10), 10);
  assert.equal(ewma(10, 20, 0.5), 15);
});

test('tokenize strips punctuation and keeps urdu', () => {
  assert.deepEqual(tokenize('Hello, WORLD!!'), ['hello', 'world']);
  assert.deepEqual(tokenize('میں ٹھیک ہوں'), ['میں', 'ٹھیک', 'ہوں']);
  assert.deepEqual(tokenize(''), []);
});

test('cosine similarity behaves', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], [1]), 0);
  assert.ok(Math.abs(cosine([1, 2], [2, 4]) - 1) < 1e-9);
});

test('bag of words vectors line up with the vocab', () => {
  const bag = bagOfWords('pip is a puppet pip', ['pip', 'puppet', 'hero']);
  assert.deepEqual(bagVector(bag, ['pip', 'puppet', 'hero']), [2, 1, 0]);
});

test('parseWhen understands relative and clock times', () => {
  const base = new Date('2026-09-21T10:00:00Z').getTime();
  const in20 = parseWhen('in 20 minutes', base);
  assert.equal(in20.getTime() - base, 20 * 60000);
  const fiveH = parseWhen('in 5 hours', base);
  assert.equal(fiveH.getTime() - base, 5 * 3600000);
  const half = parseWhen('in half an hour', base);
  assert.equal(half.getTime() - base, 30 * 60000);
  const hourUnit = parseWhen('in 1 hour', base);
  assert.equal(hourUnit.getTime() - base, 3600000);
  const at = parseWhen('at 7:30', base);
  assert.equal(new Date(at).getMinutes(), 30);
  assert.equal(new Date(parseWhen('at 7 pm', base)).getHours(), 19);
  assert.equal(new Date(parseWhen('at 7 am', base)).getHours(), 7);
  assert.equal(parseWhen('tomorrow', base).getTime() > base, true);
  assert.equal(parseWhen('banana', base), null);
  assert.equal(parseWhen('', base), null);
});

test('humanDuration / humanDay / partOfDay', () => {
  assert.equal(humanDuration(0), '0m');
  assert.equal(humanDuration(90 * 1000), '2m');
  assert.equal(humanDuration(2 * 3600 * 1000 + 5 * 60000), '2h 5m');
  assert.equal(humanDuration(26 * 3600 * 1000), '1d 2h');
  assert.equal(humanDuration(-5), '0m');
  assert.equal(humanDay(Date.now()), 'today');
  assert.equal(partOfDay(new Date('2026-09-21T07:00:00').getTime()), 'morning');
  assert.equal(partOfDay(new Date('2026-09-21T14:00:00').getTime()), 'afternoon');
  assert.equal(partOfDay(new Date('2026-09-21T19:00:00').getTime()), 'evening');
  assert.equal(partOfDay(new Date('2026-09-21T02:00:00').getTime()), 'night');
});

test('dayKey and hourOf are local-time consistent', () => {
  const ts = new Date('2026-09-21T15:30:00').getTime();
  assert.equal(dayKey(ts), '2026-09-21');
  assert.equal(hourOf(ts), 15);
  assert.equal(minutesOfDay(ts), 15 * 60 + 30);
});

test('pick / pickMany respect the injected RNG', () => {
  assert.equal(pick(['a', 'b', 'c'], () => 0), 'a');
  assert.equal(pick(['a', 'b', 'c'], () => 0.99), 'c');
  const many = pickMany(['a', 'b', 'c'], 2, () => 0);
  assert.equal(many.length, 2);
  assert.equal(new Set(many).size, 2);
  assert.deepEqual(pickMany([], 3), []);
});

test('throttle and debounce limit calls', async () => {
  let n = 0;
  const t = throttle(() => n++, 30);
  t(); t(); t();
  assert.equal(n, 1);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(n, 2);
  let d = 0;
  const deb = debounce(() => d++, 10);
  deb(); deb(); deb();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(d, 1);
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});
