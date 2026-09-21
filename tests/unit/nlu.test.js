import test from 'node:test';
import assert from 'node:assert/strict';
import { routeUtterance, fillSlots, extractCity, extractMathExpression, extractPayload, extractTarget, extractTopic, keywordsOf, contentToText, toolsForPrompt, parseToolCallFromText, titleCase } from '../../js/nlu.js';
import { TOOLS, toolNames } from '../../js/tools.js';

const now = new Date('2026-09-21T10:00:00').getTime();
const route = (q, opts = {}) => routeUtterance(q, TOOLS, { now, ...opts });

test('routes the classic gadget requests to the right tool', () => {
  const cases = [
    ['what is the weather in Lahore', 'get_weather'],
    ['weather in Taunsa tomorrow', 'get_weather'],
    ['remind me to call mama in 20 minutes', 'set_reminder'],
    ['set a timer for 10 minutes', 'set_timer'],
    ['what is 15% of 200', 'calculate'],
    ['remember that my name is Ahmad', 'remember'],
    ['do you remember my favourite colour', 'recall'],
    ['forget my old address', 'forget'],
    ['flip a coin', 'coin_flip'],
    ['roll a d20', 'roll_dice'],
    ['tell me a joke', 'tell_joke'],
    ['i am so tired today', 'motivate'],
    ['who is Deku', 'wikipedia'],
    ['translate hello in urdu', 'translate'],
    ['what time is it', 'get_time'],
    ['search for najam in taunsa', 'web_search'],
    ['add note buy milk', 'add_note'],
    ['what are my habits', 'habit_report'],
    ['battery status', 'device_status'],
  ];
  for (const [q, expected] of cases) {
    const r = route(q);
    assert.equal(r.calls[0]?.name, expected, `"${q}" → ${r.calls.map((c) => c.name).join(',')} (expected ${expected})`);
  }
});

test('slot filling extracts the useful arguments', () => {
  const weather = route('what is the weather in Lahore').calls[0];
  assert.equal(weather.arguments.location, 'Lahore');
  const reminder = route('remind me to drink water in 20 minutes').calls[0];
  assert.match(reminder.arguments.text, /drink water/);
  assert.equal(reminder.arguments.at - now, 20 * 60000);
  const timer = route('set a timer for 5 minutes').calls[0];
  assert.equal(timer.arguments.minutes, 5);
  const dice = route('roll a d20').calls[0];
  assert.equal(dice.arguments.sides, 20);
  const dice3 = route('roll 3 dice').calls[0];
  assert.equal(dice3.arguments.count, 3);
  const translate = route('translate good morning in urdu').calls[0];
  assert.equal(translate.arguments.to, 'urdu');
  assert.match(translate.arguments.text, /good morning/);
  const note = route('add note buy milk and eggs').calls[0];
  assert.match(note.arguments.text, /milk/);
  const remember = route('remember that i hate loud music').calls[0];
  assert.match(remember.arguments.text, /loud music/);
  assert.equal(remember.arguments.tag, 'note');
});

test('pure chat and questions are not forced into tools', () => {
  const chatty = ['hey pip how are you', 'tell me something nice', 'i had a long day', 'good morning partner'];
  for (const q of chatty) {
    const r = route(q);
    const top = r.calls[0];
    assert.ok(!top || top.confidence < 0.5, `"${q}" should not strongly match a gadget (got ${top?.name} ${top?.confidence})`);
  }
  assert.equal(route('what is the capital of France?').question, true);
});

test('routing is deterministic and confidence is bounded', () => {
  const a = route('weather in Lahore');
  const b = route('weather in Lahore');
  assert.deepEqual(a.calls, b.calls);
  for (const c of a.calls) {
    assert.ok(c.confidence >= 0 && c.confidence <= 1);
    assert.ok(Array.isArray(c.evidence) && c.evidence.length > 0);
  }
});

test('maxCalls and threshold are respected', () => {
  const r = route('remind me to check the weather in Lahore and set a timer for 5 minutes', { maxCalls: 2 });
  assert.ok(r.calls.length <= 2);
  const strict = route('maybe something about weather', { threshold: 0.99 });
  assert.equal(strict.confident, false);
});

test('empty and junk input never throws', () => {
  for (const q of ['', '   ', '🙂🙂', '!!!', null, undefined, 42]) {
    const r = route(q);
    assert.equal(r.calls.length, 0);
    assert.equal(r.confident, false);
  }
});

test('contentToText handles multimodal content arrays', () => {
  assert.equal(contentToText('plain'), 'plain');
  assert.equal(contentToText([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]), 'hello world');
  assert.equal(contentToText(null), '');
  assert.equal(contentToText(7), '7');
});

test('extractors behave on their own', () => {
  assert.equal(extractCity('weather in Lahore'), 'Lahore');
  assert.equal(extractCity('what is the weather in New York today'), 'New York');
  assert.equal(extractCity('hello there'), null);
  assert.equal(extractMathExpression('what is 12 * 3'), '12 * 3');
  assert.equal(extractMathExpression('hello'), null);
  assert.equal(extractPayload('remind me to stretch'), 'stretch');
  assert.deepEqual(extractTarget('translate good night in spanish'), { text: 'good night', to: 'spanish' });
  assert.deepEqual(extractTarget('define serendipity'), { word: 'serendipity' });
  assert.equal(extractTopic('tell me about All Might'), 'All Might');
  assert.equal(extractTopic('who is Deku'), 'Deku');
  assert.equal(titleCase('new york'), 'New York');
  // stop words (the/weather/is/today) are removed so tool matching stays sharp
  assert.deepEqual(keywordsOf('the weather is nice today'), ['nice']);
  assert.ok(keywordsOf('remind me to study physics').includes('physics'));
});

test('tool schemas are prompt-ready and small', () => {
  const schemas = toolsForPrompt(TOOLS, { max: 5 });
  assert.equal(schemas.length, 5);
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.ok(s.function.name && s.function.description);
    assert.equal(s.function.parameters.type, 'object');
  }
});

test('parses a tool call the model wrote as text', () => {
  const names = toolNames();
  const call = parseToolCallFromText('Sure! <tool_call>{"name":"get_weather","arguments":{"location":"Lahore"}}</tool_call>', names);
  assert.equal(call.name, 'get_weather');
  assert.deepEqual(call.arguments, { location: 'Lahore' });
  const fenced = parseToolCallFromText('```json\n{"name":"get_time","arguments":{}}\n```', names);
  assert.equal(fenced.name, 'get_time');
  assert.equal(parseToolCallFromText('{"name":"not_a_tool"}', names), null);
  assert.equal(parseToolCallFromText('hello there', names), null);
});

test('fillSlots falls back to defaults for optional args', () => {
  const tool = TOOLS.find((t) => t.name === 'roll_dice');
  const args = fillSlots(tool, 'roll the dice please', { now });
  assert.equal(args.count, 1);
  assert.equal(args.sides, 6);
});
