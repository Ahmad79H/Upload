import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayPool, GATEWAY_CATALOG, hashEmbedding, normalizeToolCalls, mergeToolCallDeltas, buildCatalog, freeGatewayIds } from '../../js/gateways.js';
import { fakeClock, fetchStub, jsonResponse, chatOk, sseBody, makeStore } from '../helpers.mjs';

const messages = [{ role: 'user', content: 'hello' }];

test('catalog has several keyless gateways and no obvious junk', () => {
  const keyless = GATEWAY_CATALOG.filter((g) => g.keyless && !g.local);
  assert.ok(keyless.length >= 4, `expected >=4 keyless gateways, got ${keyless.length}`);
  assert.deepEqual(freeGatewayIds().slice(0, 4), ['pollinations', 'llm7', 'ovh', 'kilo']);
  for (const gw of GATEWAY_CATALOG) {
    assert.match(gw.base, /^https?:\/\//);
    assert.ok(gw.models.length > 0);
    assert.ok(gw.label && gw.notes);
  }
  // a private copy is handed out so callers cannot mutate the shared catalog
  const copy = buildCatalog();
  copy[0].models.push('hacked');
  assert.notEqual(GATEWAY_CATALOG[0].models.length, copy[0].models.length);
});

test('keyless gateway needs no key but keyed ones are skipped without one', () => {
  const pool = new GatewayPool({ fetchImpl: fetchStub(() => chatOk()), clock: fakeClock() });
  const ids = pool.order().map((g) => g.id);
  assert.ok(ids.includes('pollinations'));
  assert.ok(!ids.includes('groq'), 'keyed gateway must not be used without a key');
  pool.setKey('groq', 'gsk_test');
  assert.ok(pool.order().map((g) => g.id).includes('groq'));
  // a keyed gateway also wins priority over keyless ones
  assert.equal(pool.order()[0].id, 'groq');
});

test('private mode blocks the network completely', async () => {
  const stub = fetchStub(() => chatOk());
  const pool = new GatewayPool({ fetchImpl: stub, clock: fakeClock() });
  pool.setPrivateMode(true);
  await assert.rejects(pool.chat(messages), /private mode/);
  assert.equal(stub.count(), 0);
});

test('a good gateway answer streams tokens and is returned', async () => {
  const stub = fetchStub(() => chatOk('Plus Ultra!'));
  const pool = new GatewayPool({ fetchImpl: stub, clock: fakeClock(), store: makeStore() });
  const tokens = [];
  const res = await pool.chat(messages, { onToken: (t) => tokens.push(t) });
  assert.equal(res.text, 'Plus Ultra!');
  assert.equal(res.gateway, 'pollinations');
  assert.deepEqual(tokens, ['Plus Ultra!']);
  assert.equal(pool.status().find((g) => g.id === 'pollinations').ok, 1);
});

test('streaming SSE chunks are assembled', async () => {
  const stub = fetchStub(() => jsonResponse(sseBody('Hello there hero'), { stream: true }));
  const pool = new GatewayPool({ fetchImpl: stub, clock: fakeClock() });
  const tokens = [];
  const res = await pool.chat(messages, { onToken: (t) => tokens.push(t) });
  assert.equal(res.text, 'Hello there hero');
  assert.ok(tokens.length > 1);
});

test('failover walks to the next free gateway when one breaks', async () => {
  let call = 0;
  const stub = fetchStub(() => {
    call++;
    if (call === 1) return jsonResponse('rate limited', { status: 429 });
    if (call === 2) return { throw: 'network down' };
    return chatOk('second gateway wins');
  });
  const pool = new GatewayPool({ fetchImpl: stub, clock: fakeClock(), hedgeAfterMs: 5, timeoutMs: 200 });
  const res = await pool.chat(messages);
  assert.equal(res.text, 'second gateway wins');
  assert.ok(stub.count() >= 3, `expected >=3 attempts, got ${stub.count()}`);
  const status = pool.status();
  assert.ok(status.some((g) => g.fail > 0), 'the broken gateway is remembered as failing');
});

test('hedging starts a second gateway when the first is slow', async () => {
  const clock = fakeClock();
  const stub = fetchStub(async (url, init, n) => {
    if (n === 1) {
      await new Promise((r) => setTimeout(r, 120));
      return chatOk('slow first');
    }
    return chatOk('fast second');
  });
  const pool = new GatewayPool({ fetchImpl: stub, clock, hedgeAfterMs: 10, timeoutMs: 500 });
  const res = await pool.chat(messages);
  assert.equal(res.text, 'fast second');
});

test('when every free gateway fails the error is aggregated and typed', async () => {
  const pool = new GatewayPool({ fetchImpl: fetchStub(() => ({ throw: 'boom' })), clock: fakeClock(), maxHops: 3, hedgeAfterMs: 1, timeoutMs: 60 });
  await assert.rejects(pool.chat(messages), (err) => {
    assert.equal(err.code, 'ALL_GATEWAYS_FAILED');
    assert.ok(err.errors.length >= 1);
    return true;
  });
});

test('rate limits trigger a cooldown and the gateway is skipped afterwards', async () => {
  const clock = fakeClock();
  const stub = fetchStub(() => jsonResponse('nope', { status: 429 }));
  const pool = new GatewayPool({ fetchImpl: stub, clock, maxHops: 1, hedgeAfterMs: 1, timeoutMs: 50 });
  await pool.chat(messages).catch(() => {});
  const status = pool.status().find((g) => g.id === 'pollinations');
  assert.ok(status.coolingFor > 0, 'expected a cooldown after 429');
  assert.ok(pool.isCooling('pollinations'));
  clock.advance(16 * 60 * 1000);
  assert.equal(pool.isCooling('pollinations'), false);
});

test('health survives a reload through the store', async () => {
  const store = makeStore();
  const clock = fakeClock();
  const pool = new GatewayPool({ fetchImpl: fetchStub(() => ({ throw: 'x' })), clock, store, maxHops: 1, hedgeAfterMs: 1, timeoutMs: 40 });
  await pool.chat(messages).catch(() => {});
  const reloaded = new GatewayPool({ fetchImpl: fetchStub(() => chatOk()), clock, store });
  assert.ok(reloaded.h('pollinations').fail >= 1);
});

test('probe reports per gateway results and never throws', async () => {
  let n = 0;
  const stub = fetchStub(() => (++n % 2 ? chatOk('ready') : jsonResponse('bad', { status: 500 })));
  const pool = new GatewayPool({ fetchImpl: stub, clock: fakeClock() });
  const seen = [];
  const results = await pool.probe({ limit: 3, onProgress: (r) => seen.push(r) });
  assert.equal(results.length, 3);
  assert.equal(seen.length, 3);
  assert.ok(results.some((r) => r.ok));
  for (const r of results) assert.equal(typeof r.ms, 'number');
});

test('embeddings fall back to the local hash when the free embedder is down', async () => {
  const pool = new GatewayPool({ fetchImpl: fetchStub(() => ({ throw: 'offline' })), clock: fakeClock() });
  const { vectors, gateway } = await pool.embed(['hero notebook', 'weather today']);
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0].length, 256);
  assert.equal(gateway, 'local-hash-256');
  const v = hashEmbedding('hero notebook');
  const dot = v.reduce((a, b) => a + b * b, 0);
  assert.ok(Math.abs(dot - 1) < 1e-6, 'hash embeddings must be normalised');
});

test('transcription uses the keyless whisper endpoint and never leaks private mode', async () => {
  const stub = fetchStub(() => jsonResponse({ text: ' hello pip ' }));
  const pool = new GatewayPool({ fetchImpl: stub, clock: fakeClock() });
  const out = await pool.transcribe({ size: 10, type: 'audio/webm' });
  assert.equal(out.text, 'hello pip');
  assert.equal(out.gateway, 'ovh-whisper');
  pool.setPrivateMode(true);
  await assert.rejects(pool.transcribe({ size: 1 }), /private mode/);
});

test('tool call normalisation handles both OpenAI shapes and streamed deltas', () => {
  const openai = normalizeToolCalls([{ id: 'a', function: { name: 'get_weather', arguments: '{"location":"Lahore"}' } }]);
  assert.deepEqual(openai, [{ id: 'a', name: 'get_weather', arguments: { location: 'Lahore' } }]);
  const flat = normalizeToolCalls([{ name: 'get_time', arguments: {} }]);
  assert.equal(flat[0].name, 'get_time');
  assert.deepEqual(normalizeToolCalls([]), []);
  assert.deepEqual(normalizeToolCalls(null), []);
  const merged = mergeToolCallDeltas([], [
    { index: 0, id: 'c1', function: { name: 'get_', arguments: '{"loc' } },
    { index: 0, function: { name: 'weather', arguments: 'ation":"X"}' } },
  ]);
  const norm = normalizeToolCalls(merged);
  assert.equal(norm[0].name, 'get_weather');
  assert.deepEqual(norm[0].arguments, { location: 'X' });
});

test('needle bridge falls back to its chat endpoint when /run is missing', async () => {
  const urls = [];
  const stub = fetchStub((url) => {
    urls.push(url);
    if (url.endsWith('/run')) return jsonResponse('not found', { status: 404 });
    if (url.endsWith('/v1/chat/completions')) return jsonResponse({ choices: [{ message: { content: '{"function_calls":[]}' } }], function_calls: [{ name: 'get_time', arguments: '{}' }] });
    return jsonResponse('x', { status: 500 });
  });
  const pool = new GatewayPool({ fetchImpl: stub, clock: fakeClock() });
  pool.setEndpoints({ needle: 'http://127.0.0.1:8000' });
  const needle = pool.catalog.find((g) => g.id === 'needle');
  assert.equal(needle.enabled, true);
  const res = await pool.callGateway(needle, { messages, tools: [] });
  assert.equal(res.gateway, 'needle');
  assert.equal(res.toolCalls[0].name, 'get_time');
  assert.ok(urls.some((u) => u.includes('/run')));
});

test('a model answer that is only whitespace counts as a failure', async () => {
  const pool = new GatewayPool({ fetchImpl: fetchStub(() => chatOk('   ')), clock: fakeClock(), maxHops: 1, hedgeAfterMs: 1, timeoutMs: 80 });
  await assert.rejects(pool.chat(messages), /empty completion|ALL_GATEWAYS_FAILED/);
});
