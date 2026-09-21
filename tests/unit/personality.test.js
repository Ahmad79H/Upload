import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKS, PACK_IDS, systemPrompt, localReply, decorate, moodFromText, normalizeDials, idleLine, safetyScrub } from '../../js/personality.js';
import { TOOLS } from '../../js/tools.js';

test('the three persona packs are complete and consistent', () => {
  assert.deepEqual(PACK_IDS.sort(), ['calm', 'deku', 'hype']);
  for (const id of PACK_IDS) {
    const p = PACKS[id];
    assert.equal(p.id, id);
    for (const key of ['dials', 'address', 'mutters', 'catchphrases', 'thinking', 'greeted', 'praise', 'apologies', 'encourage', 'signoff']) {
      assert.ok(p[key], `${id} is missing ${key}`);
    }
    assert.ok(p.mutters.length >= 3);
    assert.ok(p.encourage.length >= 3);
    const dials = normalizeDials(p.dials);
    for (const v of Object.values(dials)) assert.ok(v >= 0 && v <= 100);
  }
  assert.ok(PACKS.deku.catchphrases.some((c) => /Plus Ultra/.test(c)), 'Deku pack shouts Plus Ultra');
  assert.equal(PACKS.deku.selfName, 'Pip');
});

test('the puppet never swears — even when asked to repeat swearing', () => {
  const dirty = 'what the fuck, this shit is bullshit you bastard, damn it, what the hell';
  const clean = safetyScrub(dirty);
  assert.ok(!/fuck|shit|bastard/i.test(clean), clean);
  assert.match(clean, /heck|darn|oof|yikes|gosh/);
  assert.equal(safetyScrub('Deku never gives up!'), 'Deku never gives up!');
  assert.equal(safetyScrub(''), '');
});

test('local replies are always in character, never empty and never swear', () => {
  const inputs = [
    '', 'hi', 'hey pip', 'good morning', 'good night', 'how are you', 'who are you', 'what can you do',
    'thank you so much', 'i love you', 'sorry', 'i am so sad and tired', 'i am bored', 'who is deku',
    'what is your quirk', 'plus ultra', 'are you real', 'bye', 'what is the meaning of life?',
    'skibidi toilet blah blah', '😀😀😀', 'fuck this shit',
  ];
  for (const input of inputs) {
    for (const id of PACK_IDS) {
      const res = localReply(input, { pack: PACKS[id], userName: 'Ahmad' });
      assert.ok(res.text && res.text.length > 5, `empty reply for "${input}" (${id})`);
      assert.ok(!/undefined|NaN|\[object/i.test(res.text), `junk in reply for "${input}": ${res.text}`);
      assert.ok(!/fuck|shit|bitch|asshole/i.test(res.text), `swearing in reply for "${input}"`);
      assert.equal(res.offline, true);
      assert.ok(res.mood);
    }
  }
});

test('local replies acknowledge the user by name and stay short', () => {
  const res = localReply('hello', { pack: PACKS.deku, userName: 'Ahmad' });
  assert.match(res.text, /Ahmad|partner|hero/i);
  assert.ok(res.text.length < 220);
});

test('decorate keeps answers short, scrubs language and adds muttering spice', () => {
  const long = `${'This is a long sentence about heroes. '.repeat(30)}`;
  const out = decorate(long, { pack: PACKS.deku, dials: PACKS.deku.dials, maxChars: 300 });
  assert.ok(out.length <= 320, `decorate returned ${out.length} chars`);
  assert.ok(out.endsWith('.') || out.endsWith('!') || out.endsWith('…'));

  const short = decorate('You have got this!', { pack: PACKS.deku, dials: PACKS.deku.dials });
  assert.match(short, /You have got this!/);

  const swears = decorate('what the fuck', { pack: PACKS.deku });
  assert.ok(!/fuck/i.test(swears));

  assert.equal(typeof decorate(''), 'string');
  assert.ok(decorate('').length > 0, 'decorate never returns an empty string');
});

test('moodFromText drives a sensible face', () => {
  assert.equal(moodFromText('PLUS ULTRA!!'), 'wow');
  assert.equal(moodFromText('sorry, I could not do that'), 'sad');
  assert.equal(moodFromText('Great job today!'), 'happy');
  assert.equal(moodFromText('How does this work?'), 'curious');
  assert.equal(moodFromText('I will focus on my goal'), 'determined');
});

test('normalizeDials clamps slider values', () => {
  assert.deepEqual(normalizeDials({ energy: 500, cheer: -20, mutter: '30', chatty: undefined }), { energy: 100, cheer: 0, mutter: 30, chatty: 50 });
  assert.deepEqual(normalizeDials(), { energy: 70, cheer: 80, mutter: 60, chatty: 50 });
});

test('system prompt is small, in character and carries the notebook', () => {
  const prompt = systemPrompt({
    pack: PACKS.deku,
    userName: 'Ahmad',
    profile: { city: 'Taunsa', likes: ['mangoes'] },
    gateway: 'Pollinations',
    tools: TOOLS,
    now: Date.UTC(2026, 8, 21, 15, 0),
  });
  assert.match(prompt, /Pip/);
  assert.match(prompt, /Deku/);
  assert.match(prompt, /Ahmad/);
  assert.match(prompt, /Taunsa/);
  assert.match(prompt, /Never swear/);
  assert.match(prompt, /get_weather|get_time/);
  assert.ok(prompt.length < 1800, `prompt is ${prompt.length} chars — small models choke on more`);
  assert.match(prompt, /never mention that you are a language model/i, 'the persona guard is part of the prompt');
  assert.ok(prompt.split('\n').length <= 14, 'prompt stays short for small models');
});

test('system prompt works with an empty profile (fresh install)', () => {
  const prompt = systemPrompt({});
  assert.match(prompt, /mostly blank/);
  assert.ok(prompt.length > 100);
});

test('idle lines are cute and never empty', () => {
  for (let i = 0; i < 25; i++) {
    const line = idleLine({ pack: PACKS.hype, userName: 'Ahmad' });
    assert.ok(line && line.length > 4);
  }
});
