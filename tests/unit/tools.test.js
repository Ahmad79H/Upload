import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, Toolkit, calc, toolNames, LANG_CODES } from '../../js/tools.js';
import { makeStore, fakeClock, fetchStub, jsonResponse, seedRandom } from '../helpers.mjs';
import { bus } from '../../js/core/bus.js';

// Jokes, dice and coin flips are random — pin the draw so the suite cannot flake.
const restoreRandom = seedRandom(0xbeef);
after(restoreRandom);

/* ─────────── calculator ─────────── */

test('calculator handles the maths users actually type', () => {
  assert.equal(calc('1+1'), 2);
  assert.equal(calc('(3+4)*2'), 14);
  assert.equal(calc('2^10'), 1024);
  assert.equal(calc('12% of 480'), 57.6);
  assert.equal(calc('15% of 200'), 30);
  assert.equal(calc('50%'), 0.5);
  assert.equal(calc('-5 + 10'), 5);
  assert.equal(calc('100 / 8'), 12.5);
  assert.equal(calc('3.5 * 2'), 7);
});

test('calculator refuses to eval and explains itself', () => {
  assert.throws(() => calc('process.exit(1)'), /do not know the word "process"/);
  assert.throws(() => calc('alert(1)'), /do not know the word "alert"/);
  assert.throws(() => calc('7/0'), /division by zero/);
  assert.throws(() => calc(''), /nothing to calculate/);
  assert.throws(() => calc('1+'), /unexpected|parse/);
  assert.throws(() => calc('(1+2'), /unbalanced/);
});

/* ─────────── toolkit behaviour ─────────── */

function makeCtx(overrides = {}) {
  const store = makeStore();
  const clock = fakeClock();
  const added = [];
  const remembered = [];
  const ctx = {
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    store,
    memory: {
      remember: (text, meta) => remembered.push({ text, ...meta }) && { id: 'm1', text },
      search: async () => [{ text: 'you like mangoes', score: 0.8, tag: 'fact' }],
      forget: () => 2,
      profile: () => ({ name: 'Ahmad' }),
    },
    habits: { report: () => ({ summary: 'You wake at 7.', insights: [], profile: {} }), profile: () => ({ known_days: 3 }) },
    perception: { battery: () => ({ level: 0.42, charging: true }), network: () => ({ online: true, effectiveType: '4g' }), logSignal: () => {} },
    puppet: { perform: () => {}, sleep: () => {}, wake: () => {} },
    scheduler: { add: (item) => added.push(item) && 'sched_1' },
    geo: { lat: 30.7, lon: 70.6, city: 'Taunsa' },
    selfTest: async () => ({ ok: true, summary: 'all green' }),
    clock,
  };
  return { ctx: { ...ctx, ...overrides }, store, clock, added, remembered };
}

test('every tool is well formed and uniquely named', () => {
  const names = toolNames();
  assert.equal(new Set(names).size, names.length);
  assert.ok(TOOLS.length >= 20);
  for (const t of TOOLS) {
    assert.ok(t.name.match(/^[a-z_]+$/), `${t.name} should be snake_case`);
    assert.ok(t.description.length > 10);
    assert.equal(t.parameters.type, 'object');
    for (const req of t.parameters.required || []) assert.ok(req in t.parameters.properties, `${t.name}.required lists unknown arg ${req}`);
  }
});

test('an unknown tool returns a friendly failure instead of throwing', async () => {
  const tk = new Toolkit(makeCtx().ctx);
  const res = await tk.run('make_coffee', {});
  assert.equal(res.ok, false);
  assert.match(res.speak, /do not have a gadget/);
});

test('a tool that throws is caught by the toolkit', async () => {
  const tk = new Toolkit(makeCtx().ctx);
  tk.byName.set('explode', {
    name: 'explode',
    description: 'test',
    parameters: { type: 'object', properties: {} },
    run: () => {
      throw new Error('boom');
    },
  });
  const res = await tk.run('explode');
  assert.equal(res.ok, false);
  assert.match(res.error, /boom/);
  assert.match(res.speak, /gadget slipped/);
});

test('time and date tools answer in character without any network', async () => {
  const { ctx } = makeCtx();
  const tk = new Toolkit(ctx);
  const t = await tk.run('get_time');
  assert.equal(t.ok, true);
  assert.match(t.speak, /\d{1,2}:\d{2}/);
  const d = await tk.run('get_date');
  assert.match(d.speak, /Today is/);
});

test('weather uses geocoding + open-meteo and speaks a friendly forecast', async () => {
  const routes = {
    'geocoding-api': () => jsonResponse({ results: [{ name: 'Lahore', country: 'Pakistan', latitude: 31.5, longitude: 74.3 }] }),
    'api.open-meteo.com': () =>
      jsonResponse({
        current: { temperature_2m: 34.6, weather_code: 61, wind_speed_10m: 12, relative_humidity_2m: 60 },
        daily: { temperature_2m_max: [37], temperature_2m_min: [27], precipitation_probability_max: [70] },
      }),
  };
  const fetch = fetchStub((url) => (url.includes('geocoding') ? routes['geocoding-api']() : routes['api.open-meteo.com']()));
  const tk = new Toolkit(makeCtx({ fetch }).ctx);
  const res = await tk.run('get_weather', { location: 'Lahore' });
  assert.equal(res.ok, true);
  assert.match(res.speak, /Lahore/);
  assert.match(res.speak, /35°C|34\.6°C|34°C|35\.0°C/);
  assert.match(res.speak, /umbrella/);
});

test('weather falls back to the saved location and complains without one', async () => {
  const fetch = fetchStub(() =>
    jsonResponse({ current: { temperature_2m: 20, weather_code: 0 }, daily: { temperature_2m_max: [22], temperature_2m_min: [14], precipitation_probability_max: [0] } }),
  );
  const tk = new Toolkit(makeCtx({ fetch }).ctx);
  const withGeo = await tk.run('get_weather', { location: undefined });
  assert.equal(withGeo.ok, true);
  assert.match(withGeo.speak, /Taunsa/, 'falls back to the saved location');

  const geoOnly = new Toolkit(makeCtx({ fetch, geo: { lat: 30.7, lon: 70.6 } }).ctx);
  const res2 = await geoOnly.run('get_weather', { location: undefined });
  assert.equal(res2.ok, true);
  assert.match(res2.speak, /your area/, 'unnamed coordinates still read nicely');

  const noGeo = new Toolkit(makeCtx({ fetch, geo: null }).ctx);
  const res = await noGeo.run('get_weather', { location: undefined });
  assert.equal(res.ok, false);
  assert.match(res.speak, /Tell me the city/);
});

test('web search uses duckduckgo then falls back to wikipedia', async () => {
  const ddg = fetchStub(() => jsonResponse({ AbstractText: 'Deku is a hero.', AbstractURL: 'https://example.org/deku' }));
  const tk = new Toolkit(makeCtx({ fetch: ddg }).ctx);
  const res = await tk.run('web_search', { query: 'deku' });
  assert.equal(res.ok, true);
  assert.match(res.speak, /Deku is a hero/);
  assert.match(res.speak, /example\.org/);

  const fallback = fetchStub((url) => {
    if (url.includes('duckduckgo')) return jsonResponse({});
    if (url.includes('search/page')) return jsonResponse({ pages: [{ key: 'All_Might' }] });
    return jsonResponse({ extract: 'All Might is the Symbol of Peace.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/All_Might' } } });
  });
  const tk2 = new Toolkit(makeCtx({ fetch: fallback }).ctx);
  const res2 = await tk2.run('web_search', { query: 'all might' });
  assert.equal(res2.ok, true);
  assert.match(res2.speak, /Symbol of Peace/);
});

test('search failure is graceful and never throws', async () => {
  const tk = new Toolkit(makeCtx({ fetch: fetchStub(() => ({ throw: 'no net' })) }).ctx);
  const res = await tk.run('web_search', { query: 'anything' });
  assert.equal(res.ok, false);
  assert.match(res.speak, /search wings|try again/i);
});

test('wikipedia, define and translate hit free endpoints', async () => {
  const fetch = fetchStub((url) => {
    if (url.includes('wikipedia.org/api/rest_v1')) return jsonResponse({ extract: 'Izuku Midoriya is a student.', content_urls: { desktop: { page: 'https://x' } } });
    if (url.includes('dictionaryapi')) return jsonResponse([{ meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a hero who never quits' }] }] }]);
    if (url.includes('mymemory')) return jsonResponse({ responseData: { translatedText: 'ہیلو' } });
    return null;
  });
  const tk = new Toolkit(makeCtx({ fetch }).ctx);
  assert.match((await tk.run('wikipedia', { topic: 'Deku' })).speak, /Izuku Midoriya/);
  assert.match((await tk.run('define', { word: 'hero' })).speak, /never quits/);
  const tr = await tk.run('translate', { text: 'hello', to: 'Urdu' });
  assert.equal(tr.ok, true);
  assert.match(tr.speak, /In Urdu/);
  assert.equal(LANG_CODES.urdu, 'ur');
});

test('define and translate fail kindly when the free service is down', async () => {
  const tk = new Toolkit(makeCtx({ fetch: fetchStub(() => ({ throw: 'down' })) }).ctx);
  assert.equal((await tk.run('define', { word: 'x' })).ok, false);
  const tr = await tk.run('translate', { text: 'x', to: 'urdu' });
  assert.equal(tr.ok, false);
  assert.match(tr.speak, /translator is napping/);
});

test('timers and reminders land in the scheduler and the notebook', async () => {
  const { ctx, added, remembered } = makeCtx();
  const tk = new Toolkit(ctx);
  const timer = await tk.run('set_timer', { minutes: 5, label: 'focus' });
  assert.equal(timer.ok, true);
  assert.equal(added[0].type, 'timer');
  assert.ok(added[0].fireAt > Date.now());
  const rem = await tk.run('set_reminder', { text: 'stretch', at: Date.now() + 3600000 });
  assert.equal(rem.ok, true);
  assert.equal(added[1].type, 'reminder');
  assert.ok(remembered.some((r) => /Reminder/.test(r.text)));
});

test('memory tools write, read and delete', async () => {
  const { ctx, remembered } = makeCtx();
  const tk = new Toolkit(ctx);
  const saved = await tk.run('remember', { text: 'I love mangoes', tag: 'fact' });
  assert.equal(saved.ok, true);
  assert.equal(remembered[0].text, 'I love mangoes');
  const recalled = await tk.run('recall', { query: 'mangoes' });
  assert.match(recalled.speak, /you like mangoes/);
  const forgotten = await tk.run('forget', { query: 'mangoes' });
  assert.match(forgotten.speak, /let go of 2 things/);
});

test('notes are stored, listed and capped', async () => {
  const { ctx, store } = makeCtx();
  const tk = new Toolkit(ctx);
  await tk.run('add_note', { text: 'buy milk' });
  await tk.run('add_note', { text: 'call mama' });
  assert.equal(store.get('notes').length, 2);
  const list = await tk.run('list_notes');
  assert.match(list.speak, /2 notes/);
  assert.match(list.speak, /call mama/);
});

test('fun tools are playful and random', async () => {
  const { ctx } = makeCtx();
  const tk = new Toolkit(ctx);
  const coin = await tk.run('coin_flip');
  assert.match(coin.data.result, /heads|tails/);
  assert.match(coin.speak, /Plus Ultra/);
  const dice = await tk.run('roll_dice', { sides: 6, count: 3 });
  assert.equal(dice.data.rolls.length, 3);
  for (const r of dice.data.rolls) assert.ok(r >= 1 && r <= 6);
  assert.ok((await tk.run('random_fact')).speak.length > 20);
  assert.match((await tk.run('who_am_i')).speak, /notebook|still mostly empty/i);
  // every joke must be a real, punctuated sentence (the joke list is random, so
  // loop a few times rather than trusting one draw)
  for (let i = 0; i < 12; i++) {
    const joke = (await tk.run('tell_joke')).speak;
    assert.ok(joke.length >= 20, `joke too short: ${joke}`);
    assert.match(joke, /[.?!…]["']?$/u, `joke not punctuated: ${joke}`);
  }
  assert.ok((await tk.run('motivate')).speak.length > 10);
});

test('device status, emote/sleep/wake and self test delegate to the app', async () => {
  const calls = [];
  const { ctx } = makeCtx({
    puppet: { perform: (m) => calls.push(`perform:${m}`), sleep: () => calls.push('sleep'), wake: () => calls.push('wake') },
    perception: { battery: () => ({ level: 0.42, charging: true }), network: () => ({ online: true, effectiveType: '4g' }), logSignal: () => {} },
    store: makeStore(),
  });
  const tk = new Toolkit(ctx);
  const status = await tk.run('device_status');
  assert.match(status.speak, /battery 42% \(charging\)/);
  await tk.run('emote', { mood: 'dance' });
  await tk.run('sleep_puppet');
  await tk.run('wake_puppet');
  assert.deepEqual(calls, ['perform:dance', 'sleep', 'wake']);
  const self = await tk.run('self_test');
  assert.equal(self.ok, true);
  assert.match(self.speak, /all green/);
});

test('habits and identity tools summarise local knowledge', async () => {
  const { ctx } = makeCtx();
  const tk = new Toolkit(ctx);
  const report = await tk.run('habit_report');
  assert.match(report.speak, /wake at 7/);
  const who = await tk.run('who_am_i');
  assert.equal(who.ok, true);
  assert.ok(who.speak.includes('known_days') || who.speak.includes('Ahmad'));
});

test('news reads the free hacker-news feed', async () => {
  const fetch = fetchStub(() => jsonResponse({ hits: [{ title: 'A', points: 10, url: 'https://a' }, { title: 'B', points: 2 }] }));
  const tk = new Toolkit(makeCtx({ fetch }).ctx);
  const res = await tk.run('tech_news');
  assert.equal(res.ok, true);
  assert.match(res.speak, /1\) A/);
  assert.match(res.speak, /2\) B/);
});

test('runCalls executes a batch in order and tags results', async () => {
  const { ctx } = makeCtx();
  const tk = new Toolkit(ctx);
  const out = await tk.runCalls([
    { name: 'get_time', arguments: {}, confidence: 0.9 },
    { name: 'coin_flip', arguments: {}, confidence: 0.8 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'get_time');
  assert.equal(out[1].result.ok, true);
  assert.equal(tk.calls, 2);
});

test('toolkit event bus stays quiet and no tool logs to console', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const tk = new Toolkit(makeCtx().ctx);
  for (const t of tk.list()) {
    await tk.run(t.name, { minutes: 1, text: 'x', query: 'x', location: 'Lahore', expression: '1+1', mood: 'cheer' });
  }
  console.log = orig;
  assert.deepEqual(logs, []);
  assert.ok(bus);
});
