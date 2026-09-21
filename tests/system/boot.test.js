/**
 * SYSTEM TEST 1 — cold boot, onboarding, first conversation, self-test, reload.
 * Boots the real index.html + real js/main.js inside jsdom; only fetch is faked.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, shutdownApp, closeAllDoms, settle, appNetwork, onboard } from './harness.mjs';
import { pointer } from '../helpers.mjs';

const apps = [];
after(async () => {
  for (const a of apps) await shutdownApp(a);
  closeAllDoms();
});

const boot = async (opts) => {
  const app = await bootApp(opts);
  apps.push(app);
  return app;
};

test('the app boots into a ready state with Pip mounted', async () => {
  const { win, pip } = await boot();
  const doc = win.document;
  assert.equal(doc.body.dataset.boot, 'ready');
  assert.ok(doc.querySelector('#puppet-layer .puppet-svg'), 'the puppet art is in the DOM');
  assert.ok(doc.querySelector('.head-group'));
  assert.ok(doc.querySelector('#dock'));
  assert.ok(doc.querySelector('#ask-input'));
  assert.equal(pip.puppet.el.dataset.anim, 'idle');
  assert.ok(pip.pool.catalog.filter((g) => g.keyless).length >= 4);
  assert.equal(doc.querySelector('#brain-label').textContent.length > 0, true);
});

test('a fresh install shows onboarding and the intro writes the name to the notebook', async () => {
  const { win, pip } = await boot();
  const doc = win.document;
  const modal = doc.getElementById('onboarding');
  assert.equal(modal.hidden, false, 'first run asks for onboarding');
  assert.ok(doc.getElementById('onboard-art').querySelector('svg'), 'onboarding shows Pip himself');

  doc.getElementById('ob-name').value = 'Ahmad';
  doc.getElementById('ob-persona').value = 'deku';
  doc.getElementById('ob-start').dispatchEvent(new win.Event('click'));
  await settle(30);
  assert.equal(modal.hidden, true);
  assert.equal(pip.settings.userName, 'Ahmad');
  assert.equal(pip.memory.profile().name, 'Ahmad');
  assert.equal(pip.puppet.anim !== 'sleep', true);
});

test('chatting to Pip runs a full turn: bubbles, log, memory and habits', async () => {
  const { win, pip } = await boot({ network: appNetwork({ reply: 'I am here, partner! Plus Ultra!' }) });
  const doc = win.document;
  await onboard({ win, pip });

  const result = await pip.sendMessage('hello pip, how are you today?');
  assert.ok(result, 'a turn result is returned');
  assert.match(result.reply, /partner|Plus Ultra|here/i);
  const bubbles = doc.querySelectorAll('#bubble-layer .bubble');
  assert.ok(bubbles.length >= 1, 'Pip answers in a speech bubble');
  assert.match(doc.querySelector('#bubble-layer .bubble__text').textContent, /partner|here/i);
  const messages = [...doc.querySelectorAll('#chat-log .msg')];
  assert.equal(messages.length, 2, 'both the user message and Pip reply are logged');
  assert.ok(messages[0].className.includes('msg--me'));
  assert.ok(messages[1].className.includes('msg--pip'));
  assert.ok(pip.habits.summary().signals >= 1, 'the habit engine noticed the message');
  assert.ok(pip.store.get('chat').length >= 2, 'the conversation is saved on-device');
});

test('a gadget request answers with real tool data and no model round trip', async () => {
  const network = appNetwork();
  const { win, pip } = await boot({ network });
  await onboard({ win, pip });
  await settle(10);
  const before = network.count();
  const result = await pip.sendMessage('what is the weather in Lahore');
  assert.match(result.reply, /Lahore/);
  assert.match(result.reply, /3[0-9]/);
  assert.equal(result.toolResults[0].name, 'get_weather');
  assert.ok(network.count() > before, 'free weather APIs were used');
  assert.ok(!network.urls().some((u) => /chat\/completions/.test(u)), 'no paid/model call was needed for the weather');
});

test('the brain chip reports which free gateway is active', async () => {
  const { win, pip } = await boot({ network: appNetwork({ reply: 'Ready!' }) });
  await onboard({ win, pip });
  await settle(10);
  await pip.sendMessage('hello there, tell me something');
  const label = win.document.getElementById('brain-label').textContent;
  assert.ok(label.length > 3);
  assert.ok(/pollinations|llm7|ovh|kilo|brain/i.test(label), `unexpected chip text: ${label}`);
  assert.equal(win.document.getElementById('brain-dot').className.includes('is-ok'), true);
});

test('a returning user skips onboarding and gets their notebook back', async () => {
  const seed = {
    settings: { onboarded: true, userName: 'Ahmad', pack: 'hype', speak: false, dials: { energy: 95, cheer: 90, mutter: 40, chatty: 70 } },
    memories: [{ id: 'mem_1', text: 'I love mangoes', tag: 'fact', importance: 0.9, at: Date.now(), source: 'user', hits: 1 }],
    profile: { name: 'Ahmad', city: 'Taunsa' },
    habits: { hours: new Array(24).fill(0.2), days: { [new Date().toISOString().slice(0, 10)]: { first: Date.now(), last: Date.now(), count: 3, messages: 2, tools: 1, minutes: 5 } }, tools: { get_weather: 2 }, topics: { weather: 1 } },
  };
  const { pip, win } = await boot({ seed });
  assert.equal(win.document.getElementById('onboarding').hidden, true, 'no onboarding for a returning hero');
  assert.equal(pip.settings.userName, 'Ahmad');
  assert.equal(pip.settings.pack, 'hype');
  assert.equal(pip.memory.profile().city, 'Taunsa');
  assert.ok(pip.memory.all().some((m) => /mangoes/.test(m.text)));
  assert.equal(pip.habits.topTools(1)[0].name, 'get_weather', 'habit history came back');
  assert.ok(win.document.getElementById('brain-label').textContent.length > 0);
});

test('the built-in self test reports every subsystem', async () => {
  const { pip, win } = await boot();
  await onboard({ win, pip });
  const res = await pip.runSelfTest();
  assert.ok(res.checks.length >= 6);
  assert.ok(res.checks.some((c) => c.name === 'puppet mounted' && c.ok));
  assert.ok(res.checks.some((c) => c.name === 'toolbox loaded' && c.ok));
  assert.ok(res.checks.some((c) => c.name === 'privacy invariants' && c.ok));
  assert.match(res.report, /self test|Plus Ultra/i);
  const view = win.document.getElementById('selftest-view');
  win.document.getElementById('btn-test').dispatchEvent(new win.Event('click'));
  await settle(60);
  assert.match(view.textContent, /✅/);
});

test('the sheet opens, switches tabs and renders each pane with data', async () => {
  const { win, pip } = await boot();
  const doc = win.document;
  await onboard({ win, pip });
  await pip.sendMessage('remember that my name is Ahmad');
  doc.getElementById('btn-sheet').dispatchEvent(new win.Event('click'));
  assert.equal(doc.getElementById('sheet').hidden, false);

  const tabs = ['brain', 'memory', 'habits', 'settings', 'chat'];
  for (const tab of tabs) {
    const btn = [...doc.querySelectorAll('.tab')].find((t) => t.dataset.tab === tab);
    btn.dispatchEvent(new win.Event('click'));
    assert.equal(btn.classList.contains('is-active'), true);
    assert.equal(doc.querySelector(`.pane[data-pane="${tab}"]`).classList.contains('is-active'), true);
  }
  assert.ok(doc.querySelectorAll('#gateway-list .gw').length >= 6, 'gateway list renders every brain');
  assert.ok(doc.querySelectorAll('#key-rows input').length >= 3, 'optional free-tier keys are offered');
  assert.ok(doc.querySelectorAll('#memory-list .list__item').length >= 1, 'memory list shows what Pip learned');
  assert.ok(doc.querySelectorAll('#habits-view .list__item').length >= 1, 'habit insights render');
  assert.match(doc.getElementById('signals-view').textContent, /camera|present|battery/);

  doc.getElementById('sheet-grip').dispatchEvent(new win.Event('click'));
  assert.equal(doc.getElementById('sheet').hidden, true);
});

test('tapping the puppet makes him react — with no errors anywhere', async () => {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  const { win, pip } = await boot();
  const doc = win.document;
  await onboard({ win, pip });
  doc.getElementById('bubble-layer').innerHTML = '';

  const view = pip.puppet.el.ownerDocument.defaultView;
  pointer(pip.puppet.el, 'pointerdown', { x: 60, y: 300 });
  pointer(view, 'pointerup', { x: 60, y: 300 });
  await settle(30);
  console.error = origError;

  assert.ok(doc.querySelectorAll('#bubble-layer .bubble').length >= 1, 'Pip says something when tapped');
  assert.ok(pip.puppet.stats.pokes >= 1);
  assert.deepEqual(errors, [], `console.error was called: ${errors.join(' | ')}`);
});
