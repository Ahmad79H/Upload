import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../../js/brain.js';
import { Toolkit } from '../../js/tools.js';
import { Memory } from '../../js/memory.js';
import { Habits } from '../../js/habits.js';
import { Bus } from '../../js/core/bus.js';
import { PACKS } from '../../js/personality.js';
import { makeStore, fakeClock, makePool } from '../helpers.mjs';

function makeBrain({ replies = [], fail = false, settings = {}, pool = null } = {}) {
  const store = makeStore();
  const clock = fakeClock();
  const bus = new Bus();
  const p = pool || makePool({ replies, fail, clock });
  const memory = new Memory({ store, clock, pool: p });
  const habits = new Habits({ store, clock, bus });
  const toolkit = new Toolkit({ store, memory, habits, scheduler: { add: () => 's1' }, clock });
  const cfg = { userName: 'Ahmad', pack: 'deku', dials: PACKS.deku.dials, privateMode: false, speak: true, ...settings };
  const brain = new Brain({ pool: p, toolkit, memory, habits, bus, store, clock, getSettings: () => cfg });
  return { brain, pool: p, memory, habits, store, bus, cfg, clock };
}

test('a gadget request is answered locally without wasting a gateway call', async () => {
  const { brain, pool, habits } = makeBrain({ replies: [{ text: 'should not be used' }] });
  const res = await brain.respond('what time is it');
  assert.equal(res.offline, false);
  assert.equal(res.gateway, null);
  assert.equal(res.toolResults.length, 1);
  assert.equal(res.toolResults[0].name, 'get_time');
  assert.equal(pool.chatCalls.length, 0, 'local routing must not call the model');
  assert.match(res.reply, /\d{1,2}:\d{2}/);
  assert.equal(habits.topTools(1)[0].name, 'get_time');
});

test('short single-tool requests skip the model entirely', async () => {
  const { brain, pool } = makeBrain({ replies: [{ text: 'narration' }] });
  const res = await brain.respond('flip a coin');
  assert.equal(pool.chatCalls.length, 0);
  assert.match(res.reply, /Heads|Tails/);
});

test('a question goes to the gateway and comes back in Pip voice', async () => {
  const { brain, pool, memory } = makeBrain({ replies: [{ text: 'Deku is a hero who never gives up.' }] });
  memory.remember('my name is Ahmad', { tag: 'fact' });
  const statuses = [];
  const res = await brain.respond('tell me about the hero Deku', { onStatus: (s) => statuses.push(s.status) });
  assert.equal(pool.chatCalls.length, 1);
  assert.equal(res.gateway, 'fake');
  assert.match(res.reply, /Deku is a hero/);
  assert.ok(statuses.includes('thinking'));
  const prompt = pool.chatCalls[0].messages[0].content;
  assert.match(prompt, /Ahmad/, 'the notebook is part of the prompt');
  assert.match(prompt, /Pip|Deku/);
});

test('streamed tokens reach the UI callback', async () => {
  const { brain } = makeBrain({ replies: [{ text: 'One for all!' }] });
  const tokens = [];
  await brain.respond('hello there friend', { onToken: (t) => tokens.push(t) });
  assert.deepEqual(tokens, ['One for all!']);
});

test('conversation history is passed but trimmed', async () => {
  const { brain, pool } = makeBrain({ replies: [{ text: 'ok' }] });
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'pip' : 'user', content: `turn ${i}` }));
  await brain.respond('and now?', { history });
  const sent = pool.chatCalls[0].messages;
  assert.ok(sent.length <= 9, `history should be trimmed, got ${sent.length} messages`);
  assert.equal(sent.at(-1).content, 'and now?');
  assert.equal(sent.at(-2).role, 'assistant', 'pip turns become assistant turns');
});

test('when every gateway dies Pip still answers from his own head', async () => {
  const { brain, bus } = makeBrain({ fail: true });
  let failed = null;
  bus.on('brain:gateway-failed', (p) => (failed = p));
  const res = await brain.respond('hello there, how are you today?');
  assert.equal(res.offline, true);
  assert.ok(res.reply.length > 5);
  assert.ok(!/error|failed|exception/i.test(res.reply), `reply leaked technical language: ${res.reply}`);
  assert.ok(failed);
});

test('private mode never touches the network but still answers', async () => {
  const { brain, pool, memory } = makeBrain({ replies: [{ text: 'secret answer' }], settings: { privateMode: true } });
  const res = await brain.respond('what is the weather in Lahore');
  assert.equal(pool.chatCalls.length, 0);
  assert.equal(res.offline, true);
  assert.ok(res.reply.length > 5);
  assert.ok(!/secret answer/.test(res.reply), 'the model is not consulted in private mode');
  assert.equal(memory.all().length >= 0, true);
});

test('gadget results are handed to the model for a natural answer', async () => {
  const { brain, pool } = makeBrain({ replies: [{ text: 'It is a lovely day in Lahore!' }] });
  const res = await brain.respond('what is the weather in Lahore');
  assert.equal(res.gateway, 'fake');
  const prompt = pool.chatCalls[0].messages[0].content;
  assert.match(prompt, /gadget get_weather|Gadget results/i);
});

test('native tool calls from the model are executed and narrated', async () => {
  const { brain, pool, habits } = makeBrain({
    replies: [
      { text: '', toolCalls: [{ id: 'c1', name: 'get_time', arguments: {} }] },
      { text: 'It is hero time!', toolCalls: [] },
    ],
  });
  const res = await brain.respond('could you check the clock for me please');
  assert.equal(pool.chatCalls.length, 2, 'a second round narrates the gadget result');
  assert.ok(res.toolResults.some((t) => t.name === 'get_time'));
  assert.match(res.reply, /hero time/);
  assert.ok(habits.topTools().length >= 1);
});

test('personal facts are written into the notebook automatically', async () => {
  const { brain, memory } = makeBrain({ replies: [{ text: 'Noted!' }] });
  await brain.respond('my name is Ahmad and i live in Taunsa, i love biryani');
  assert.equal(memory.profile().name, 'Ahmad');
  assert.equal(memory.profile().city, 'Taunsa');
  assert.ok(memory.all().some((m) => /biryani/.test(m.text)));
});

test('topics and message counts are learned by the habits engine', async () => {
  const { brain, habits } = makeBrain({ replies: [{ text: 'ok' }] });
  await brain.respond('i have an exam tomorrow and i need to study');
  await brain.respond('the weather is nice today');
  const topics = habits.topTopics(5).map((t) => t.topic);
  assert.ok(topics.includes('study'));
  assert.ok(topics.includes('weather'));
  assert.ok(habits.summary().signals >= 2);
});

test('the brain never throws, ever — even with a hostile pool', async () => {
  const hostile = {
    order: () => [{ id: 'x', label: 'x', tools: true }],
    async chat() {
      throw new Error('kaboom');
    },
    async embed() {
      throw new Error('nope');
    },
    privateMode: false,
  };
  const { brain } = makeBrain({ pool: hostile });
  for (const input of ['', 'hi', 'weather in Lahore', '???', 'tell me about quantum physics', 'remind me in 5 minutes', 'fuck this shit i am done']) {
    const res = await brain.respond(input);
    assert.ok(typeof res.reply === 'string' && res.reply.length > 0, `empty reply for "${input}"`);
    assert.ok(res.mood);
    assert.ok(!/fuck|shit/i.test(res.reply));
  }
});

test('brain replies are announced on the bus with tool names', async () => {
  const { brain, bus } = makeBrain({ replies: [{ text: 'Ready!' }] });
  const seen = [];
  bus.on('brain:reply', (p) => seen.push(p));
  await brain.respond('hello there my friend');
  assert.equal(seen.length, 1);
  assert.ok(Array.isArray(seen[0].tools));
  assert.ok(seen[0].reply.length > 0);
});

test('dials change how chatty and hyped the prompt is', async () => {
  const { brain, pool } = makeBrain({ replies: [{ text: 'ok' }], settings: { dials: { energy: 10, cheer: 10, mutter: 0, chatty: 0 } } });
  await brain.respond('explain something long to me please');
  assert.equal(pool.chatCalls[0].opts.max_tokens, 260);
  const { brain: hyped, pool: pool2 } = makeBrain({ replies: [{ text: 'ok' }], settings: { dials: { energy: 95, cheer: 95, mutter: 90, chatty: 90 } } });
  await hyped.respond('explain something long to me please');
  assert.equal(pool2.chatCalls[0].opts.max_tokens, 420);
  assert.ok(pool2.chatCalls[0].opts.temperature > 0.8);
});
