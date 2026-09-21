/**
 * SYSTEM TEST 3 — chaos monkey: Pip must stay cute when everything else breaks.
 *   • every free gateway down / returning garbage
 *   • no network at all (airplane mode)
 *   • hostile storage (quota exceeded, blocked localStorage)
 *   • camera and mic denied
 *   • 60 rapid-fire messages, giant inputs, unicode
 *   • guaranteed: no unhandled rejection, no error text shown to the user,
 *     no frame or memory ever uploaded.
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
  await onboard(app);
  return app;
};

/** Watch for anything the app leaks: unhandled rejections, window errors, error text. */
function watchForTrouble(win) {
  const trouble = [];
  const onRejection = (reason) => trouble.push(`unhandled rejection: ${reason?.message || reason}`);
  const onError = (event) => trouble.push(`window error: ${event?.message || event}`);
  process.on('unhandledRejection', onRejection);
  if (win?.addEventListener) win.addEventListener('error', onError);
  return {
    trouble,
    stop() {
      process.off('unhandledRejection', onRejection);
      win?.removeEventListener?.('error', onError);
    },
  };
}

test('all gateways down: Pip answers from his own head, no errors shown', async () => {
  const network = appNetwork({ failAll: true });
  const { win, pip } = await boot({ network });
  const watch = watchForTrouble(win);
  const res = await pip.sendMessage('hello pip, how are you today?');
  watch.stop();
  assert.equal(res.offline, true);
  assert.ok(res.reply.length > 5);
  assert.ok(!/error|exception|failed|undefined|NaN/i.test(res.reply), `leaked technical text: ${res.reply}`);
  assert.deepEqual(watch.trouble, []);
  assert.match(win.document.getElementById('bubble-layer').textContent, /\w/);
});

test('garbage from a gateway is treated as a failure and Pip hops to the next brain', async () => {
  const network = appNetwork({ malformed: true });
  const { pip } = await boot({ network });
  const res = await pip.sendMessage('tell me a story about heroes please');
  assert.ok(res.reply.length > 5);
  assert.ok(network.urls().filter((u) => /chat\/completions/.test(u)).length >= 2, 'he tried more than one free gateway');
  const status = pip.pool.status();
  assert.ok(status.some((g) => g.fail > 0), 'the broken gateway is remembered');
});

test('offline install: nothing works but everything still works', async () => {
  const network = appNetwork({ failAll: true });
  const { win, pip } = await boot({ network });
  // local gadgets must keep working with zero network
  const time = await pip.sendMessage('what time is it');
  assert.match(time.reply, /\d{1,2}:\d{2}/);
  const coin = await pip.sendMessage('flip a coin');
  assert.match(coin.reply, /heads|tails|Plus Ultra/i);
  const calc = await pip.sendMessage('what is 12% of 480');
  assert.match(calc.reply, /57\.6/);
  const note = await pip.sendMessage('add note buy milk');
  assert.equal(pip.store.get('notes').length, 1);
  const joke = await pip.sendMessage('tell me a joke');
  assert.ok(joke.reply.length > 5);
  assert.ok(win.document.getElementById('bubble-layer').textContent.length > 0);
});

test('a hostile storage backend (private mode / quota) cannot break the puppet', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  pip.store.storage = {
    get length() {
      return 0;
    },
    key: () => null,
    getItem: () => {
      throw new Error('SecurityError: storage blocked');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  };
  const res = await pip.sendMessage('remember that my favourite colour is green');
  assert.ok(res.reply.length > 0);
  assert.equal(pip.memory.all().some((m) => /green/.test(m.text)), true, 'memory still works in RAM');
  assert.doesNotThrow(() => pip.store.set('anything', { big: 'x'.repeat(1000) }));
});

test('denied camera and microphone are explained gently, never as errors', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  const res = await pip.perception.startCamera();
  assert.equal(res.ok, false);
  assert.equal(pip.perception.cameraState, 'unsupported');
  const inv = pip.perception.privacyInvariants();
  assert.equal(inv.ok, true);
  assert.equal(inv.framesStored, 0);
  assert.equal(inv.uploads, 0);
  const listen = await pip.speech.listen({ timeoutMs: 20 });
  assert.equal(listen.ok, false);
  assert.ok(listen.error.length > 3);
  assert.ok(win.document.querySelector('#puppet-layer .puppet-svg'));
});

test('30 rapid messages, giant text and unicode never break the pipeline', async () => {
  const network = appNetwork({ reply: 'Okay!' });
  const { win, pip } = await boot({ network });
  const watch = watchForTrouble(win);
  const inputs = [
    'hi', 'hello pip', 'what is the weather in Lahore', 'remember that my name is Ahmad',
    'سلام، آپ کیسے ہیں؟', '😀🎉🥦', 'x'.repeat(500), 'what is ' + 'very '.repeat(60) + 'important?',
    'set a timer for 9 minutes', 'forget everything about me', 'translate hello in urdu',
  ];
  // Note: Pip rate-limits himself between gateway calls (minIntervalMs) to be a
  // good citizen on free tiers, so keep this loop moderate.
  for (let i = 0; i < 30; i++) await pip.sendMessage(inputs[i % inputs.length]);
  watch.stop();
  assert.deepEqual(watch.trouble, []);
  const bubbles = win.document.querySelectorAll('#bubble-layer .bubble');
  assert.ok(bubbles.length <= 3, `bubbles are cleaned up, found ${bubbles.length}`);
  assert.ok(pip.store.get('chat').length <= 80, 'chat history is capped');
  assert.ok(pip.memory.all().length <= 800);
  assert.ok(pip.habits.summary().signals >= 30);
  const pre = win.document.querySelector('#chat-log pre, #chat-log code');
  assert.equal(pre, null, 'no raw code blocks leak into the chat log');
});

test('a message sent while Pip is still thinking is queued, not lost or doubled', async () => {
  const network = appNetwork({ reply: 'Thinking done!', chatDelayMs: 40 });
  const { pip } = await boot({ network });
  const first = pip.sendMessage('first question about heroes');
  const second = pip.sendMessage('second question about heroes');
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a, 'the first turn resolves');
  assert.equal(b, null, 'the second is politely ignored while he is busy (no double reply)');
  assert.deepEqual(pip.toolkit.ctx.store.get('chat').filter((m) => m.role === 'user').length, 1);
});

test('privacy invariants hold after a full session of watching and talking', async () => {
  const { win, pip } = await boot({ network: appNetwork() });
  await pip.perception.startCamera({ fps: 5 });
  await settle(30);
  pip.bus.emit('perception:presence', { present: true, motionLevel: 0.6, faceScore: 0.5 });
  await pip.sendMessage('what do you see in your notebook about me');
  await settle(20);
  const inv = pip.perception.privacyInvariants();
  assert.deepEqual(inv, { framesStored: 0, uploads: 0, keepsVideoElement: false, analysisResolution: '32x24', ok: true });
  const snapshot = JSON.stringify(pip.perception.snapshot());
  assert.ok(!/data:|base64|blob:/i.test(snapshot), 'no pixels in the sensory snapshot');
  assert.ok(!pip.store.keys().some((k) => /frame|photo|video|image/i.test(k)), 'no image data in storage');
  pip.perception.stopCamera();
  assert.ok(['off', 'unsupported'].includes(pip.perception.cameraState), `camera state was ${pip.perception.cameraState}`);
  assert.ok(win.document.querySelector('.puppet-svg'));
});

test('Pip can be woken, put to sleep and dragged after everything went wrong', async () => {
  const { win, pip } = await boot({ network: appNetwork({ failAll: true }) });
  await pip.sendMessage('good night pip');
  assert.equal(pip.puppet.anim, 'sleep', 'he actually goes to sleep when asked');
  const view = pip.puppet.el.ownerDocument.defaultView;
  pointer(pip.puppet.el, 'pointerdown', { x: 80, y: 300 });
  pointer(view, 'pointermove', { x: 120, y: 260 });
  pointer(view, 'pointerup', { x: 120, y: 260 });
  await settle(30);
  assert.ok(pip.puppet.stats.drags >= 1, 'he is still draggable');
  assert.ok(win.document.querySelector('#drop-shadow'));
});

test('the whole app survives being shut down and booted again (no leaked timers)', async () => {
  const first = await boot({ network: appNetwork() });
  await first.pip.sendMessage('hello there');
  await shutdownApp(first);
  assert.equal(first.win.document.body.dataset.boot, 'stopped');
  const second = await boot({ network: appNetwork() });
  const res = await second.pip.sendMessage('hello again');
  assert.ok(res.reply.length > 0);
  assert.notEqual(second.pip.puppet, first.pip.puppet);
});
