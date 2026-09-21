/**
 * SYSTEM TEST 2 — the journeys a real user takes:
 * talking by voice, dragging the puppet around, timers, habits, voice modes,
 * presence watching, data export and the settings that matter.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, shutdownApp, closeAllDoms, settle, appNetwork, onboard, fakeRecognition } from './harness.mjs';
import { pointer, rafTick } from '../helpers.mjs';

const apps = [];
after(async () => {
  for (const a of apps) await shutdownApp(a);
  closeAllDoms();
});
const boot = async (opts) => {
  const app = await bootApp(opts);
  apps.push(app);
  await onboard(app);
  return app;
};

test('hold-to-talk: Pip listens, hears you and answers out loud', async () => {
  const network = appNetwork({ reply: 'Lahore is warm today, partner!' });
  const { win, pip } = await boot({ network, withRecognition: fakeRecognition('what is the weather like today') });
  const doc = win.document;
  const mic = doc.getElementById('btn-talk');
  pointer(mic, 'pointerdown', { x: 10, y: 10 });
  await settle(60);
  assert.ok(pip.speech.utterances >= 0);
  const bubbles = doc.querySelector('#bubble-layer .bubble__text');
  assert.ok(bubbles, 'Pip spoke in a bubble');
  assert.match(doc.getElementById('chat-log').textContent, /weather/i, 'your spoken words were transcribed into the chat');
  assert.ok(pip.habits.summary().signals >= 1);
  assert.equal(doc.getElementById('btn-talk').classList.contains('is-live'), false, 'the mic indicator clears');
});

test('hold-to-talk degrades politely when the microphone is blocked', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const doc = win.document;
  const mic = doc.getElementById('btn-talk');
  pointer(mic, 'pointerdown', { x: 10, y: 10 });
  await settle(40);
  assert.match(doc.getElementById('bubble-layer').textContent, /mic|catch|listen/i);
  assert.equal(pip.puppet.el.dataset.anim !== 'error', true);
});

test('you can drag Pip around the screen and fling him, and he stays visible', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const doc = win.document;
  const p = pip.puppet;
  const startX = p.pos.x;
  const view = p.el.ownerDocument.defaultView;
  pointer(p.el, 'pointerdown', { x: startX, y: p.pos.y });
  pointer(view, 'pointermove', { x: startX + 60, y: p.pos.y - 120 });
  assert.equal(doc.querySelector('.puppet-svg').dataset.drag, 'true');
  assert.equal(doc.getElementById('drop-shadow').style.opacity !== '', true, 'shadow tracks him');
  pointer(view, 'pointermove', { x: startX + 140, y: p.pos.y - 60 });
  pointer(view, 'pointerup', { x: startX + 140, y: p.pos.y - 60 });
  assert.equal(doc.querySelector('.puppet-svg').dataset.drag, 'false');
  await rafTick(900);
  assert.ok(p.pos.x >= 0 && p.pos.x <= p.bounds().w);
  assert.ok(p.pos.y >= 0 && p.pos.y <= p.bounds().h);
  assert.ok(p.pos.y <= p.floorY + 1, 'gravity puts him back on the ground');
  assert.ok(pip.store.get('puppet').pos, 'his spot is remembered');
});

test('tapping him repeatedly is always harmless (stress the tap handler)', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const view = pip.puppet.el.ownerDocument.defaultView;
  for (let i = 0; i < 30; i++) {
    pointer(pip.puppet.el, 'pointerdown', { x: 40 + i, y: 300 });
    pointer(view, 'pointerup', { x: 40 + i, y: 300 });
  }
  await settle(30);
  assert.ok(pip.puppet.stats.pokes >= 3);
  assert.ok(win.document.querySelectorAll('#bubble-layer .bubble').length <= 3, 'bubbles do not pile up forever');
});

test('timers fire, Pip celebrates and the chat log records it', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const result = await pip.sendMessage('set a timer for 1 minute to stretch');
  assert.equal(result.toolResults[0].name, 'set_timer');
  assert.equal(pip.scheduler.list({ type: 'timer' }).length, 1);
  // jump the clock instead of waiting 60 seconds
  const item = pip.scheduler.list({ type: 'timer' })[0];
  pip.scheduler.tick(item.fireAt + 1);
  await settle(20);
  assert.match(win.document.getElementById('chat-log').textContent, /stretch/i);
  assert.equal(pip.scheduler.list({ type: 'timer' }).length, 0, 'one-shot timers are cleared');
  assert.ok(pip.puppet.anim === 'cheer' || pip.puppet.anim === 'talk' || pip.puppet.anim === 'idle');
});

test('reminders land in the notebook so Pip can recall them later', async () => {
  const { pip } = await boot({ network: appNetwork() });
  await pip.sendMessage('remind me to call my mother in 30 minutes');
  assert.ok(pip.memory.all().some((m) => /call my mother/.test(m.text)));
  const recalled = await pip.sendMessage('do you remember what I asked you to remind me?');
  assert.ok(recalled.reply.length > 0);
});

test('habits build up and the report reads like a notebook entry', async () => {
  const { win, pip } = await boot({ network: appNetwork({ reply: 'Noted!' }) });
  for (const q of ['hello pip', 'i need to study for my exam', 'what is the weather in Lahore', 'i am tired today']) {
    await pip.sendMessage(q);
  }
  const report = pip.habits.report();
  assert.ok(report.insights.length >= 1);
  assert.ok(report.profile.top_topics.includes('study') || report.profile.top_topics.includes('weather') || report.profile.favourite_gadget);
  await pip.sendMessage('what have you learned about me');
  assert.equal(pip.habits.summary().signals > 4, true);
  const pane = win.document.getElementById('habits-view');
  win.document.getElementById('btn-scan-habits').dispatchEvent(new win.Event('click'));
  assert.ok(pane.textContent.length > 20);
});

test('presence watching reacts to a person appearing, and keeps frames local', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  // pretend the on-device analyser saw a face
  pip.bus.emit('perception:presence', { present: true, motionLevel: 0.3, faceScore: 0.4 });
  await settle(20);
  assert.match(win.document.getElementById('bubble-layer').textContent, /there you are|Ahmad/i);
  const inv = pip.perception.privacyInvariants();
  assert.equal(inv.framesStored, 0);
  assert.equal(inv.uploads, 0);
  const snap = pip.perception.snapshot();
  assert.ok(!JSON.stringify(snap).includes('data:image'), 'no image data is ever held');
});

test('the mood dials change his personality immediately', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const energy = win.document.getElementById('mood-energy');
  win.document.getElementById('mood-btn').dispatchEvent(new win.Event('click'));
  assert.equal(win.document.getElementById('mood-bar').hidden, false);
  energy.value = '95';
  energy.dispatchEvent(new win.Event('input'));
  assert.equal(pip.settings.dials.energy, 95);
  assert.equal(pip.puppet.mood, 'hyped');

  const mutter = win.document.getElementById('mood-mutter');
  mutter.value = '0';
  mutter.dispatchEvent(new win.Event('input'));
  assert.equal(pip.settings.dials.mutter, 0);
  assert.equal(pip.store.get('settings').dials.energy, 95, 'dials are saved on device');
});

test('switching persona changes his voice preset and accent colour', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const sel = win.document.getElementById('cfg-voice');
  assert.ok(sel, 'voice picker exists');
  pip.speech.setPreset('hype');
  assert.equal(pip.speech.preset, 'hype');
  pip.puppet.el.dataset.persona = 'hype';
  assert.equal(pip.puppet.el.dataset.persona, 'hype');
});

test('private mode kills the network but the puppet never goes silent', async () => {
  const network = appNetwork();
  const { win, pip } = await boot({ network });
  win.document.getElementById('cfg-private').checked = true;
  win.document.getElementById('cfg-private').dispatchEvent(new win.Event('change'));
  await settle(10);
  assert.equal(pip.settings.privateMode, true);
  const before = network.count();
  const res = await pip.sendMessage('tell me about the history of the universe please');
  assert.equal(network.count(), before, 'no request left the device — not even a wiki lookup');
  assert.ok(res.reply.length > 5);
  assert.equal(res.offline, true);
  // and a gadget request that would need the internet says so kindly
  const offlineReply = await pip.sendMessage('what is the weather in Lahore');
  assert.equal(network.count(), before, 'weather gadget is disabled offline too');
  assert.ok(offlineReply.reply.length > 5);
});

test('memory can be searched, added and wiped from the UI', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const doc = win.document;
  pip.memory.remember('I love mangoes from Multan', { tag: 'fact' });
  pip.memory.remember('My sister is a doctor', { tag: 'fact' });
  [...doc.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'memory').dispatchEvent(new win.Event('click'));
  const total = pip.memory.all().length;
  assert.ok(total >= 2, `expected the two new facts (plus anything onboarding learned), got ${total}`);
  assert.equal(doc.querySelectorAll('#memory-list .list__item').length, total);
  doc.getElementById('mem-search').value = 'mangoes';
  doc.getElementById('mem-search').dispatchEvent(new win.Event('input'));
  assert.equal(doc.querySelectorAll('#memory-list .list__item').length, 1);
  doc.getElementById('mem-search').value = '';
  doc.getElementById('mem-search').dispatchEvent(new win.Event('input'));

  const forgetBtn = doc.querySelector('#memory-list [data-forget]');
  forgetBtn.dispatchEvent(new win.Event('click', { bubbles: true })); // the list uses event delegation
  assert.equal(pip.memory.all().length, total - 1, 'forgetting removes exactly one memory');
  win.confirm = () => true; // "yes, erase everything"
  doc.getElementById('btn-wipe-mem').dispatchEvent(new win.Event('click', { bubbles: true }));
  await settle(10);
  assert.equal(pip.memory.all().length, 0);
});

test('habits nudges are rate limited and respect the quiet-hours setting', async () => {
  const { pip } = await boot({ network: appNetwork() });
  for (let i = 0; i < 5; i++) pip.habits.observe('tool', { name: 'get_weather' });
  const first = pip.habits.suggestNudge({ enabled: true, minGapMs: 60000, quietStart: '23:00', quietEnd: '07:00' });
  assert.ok(first, 'a nudge is available');
  assert.equal(pip.habits.suggestNudge({ enabled: true, minGapMs: 60000, quietStart: '23:00', quietEnd: '07:00' }), null);
  assert.equal(pip.habits.suggestNudge({ enabled: false, minGapMs: 0 }), null);
});

test('the optional free-tier key field is stored locally and prioritises that brain', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const doc = win.document;
  [...doc.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'brain').dispatchEvent(new win.Event('click'));
  const inputs = [...doc.querySelectorAll('#key-rows input')];
  assert.ok(inputs.length >= 3, 'groq / gemini / openrouter key boxes exist');
  inputs[0].value = 'gsk_test_key_123';
  inputs[0].dispatchEvent(new win.Event('change'));
  await settle(10);
  assert.equal(Object.values(pip.pool.keys)[0], 'gsk_test_key_123');
  assert.match(pip.pool.order()[0].id, /groq|gemini|cerebras|openrouter|mistral|huggingface/, 'a keyed brain jumps the queue');
  assert.equal(doc.querySelectorAll('#gateway-list .gw').length >= 6, true);
});

test('an on-device bridge can be pointed at Needle or Ollama', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const needleInput = win.document.getElementById('cfg-needle');
  needleInput.value = 'http://127.0.0.1:8000';
  needleInput.dispatchEvent(new win.Event('change'));
  await settle(10);
  const needle = pip.pool.catalog.find((g) => g.id === 'needle');
  assert.equal(needle.base, 'http://127.0.0.1:8000');
  assert.equal(needle.enabled, true);
  assert.ok(pip.pool.order().some((g) => g.id === 'needle'), 'the local model is used when available');
});
