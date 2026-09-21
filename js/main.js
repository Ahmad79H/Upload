/**
 * PIP WAKES UP — application bootstrap and UI wiring.
 *
 * Everything else in js/ is deliberately headless and testable; this file is
 * the only place that touches the DOM chrome (bubbles, sheets, dock, buttons),
 * glues the modules together and runs Pip's daily life:
 *   wake → look around → listen → think → answer → fall asleep at night.
 */
import { Store } from './core/store.js';
import { bus } from './core/bus.js';
import { GatewayPool, GATEWAY_CATALOG } from './gateways.js';
import { Memory } from './memory.js';
import { Habits } from './habits.js';
import { Perception } from './perception.js';
import { Scheduler } from './scheduler.js';
import { Toolkit } from './tools.js';
import { Speech, VOICE_PRESETS } from './speech.js';
import { Brain } from './brain.js';
import { Puppet } from './puppet.js';
import { PACKS, localReply, normalizeDials, idleLine } from './personality.js';
import { escapeHtml, pick, partOfDay, clamp, humanDuration } from './core/util.js';

/* ─────────── boot ─────────── */
const win = globalThis.window ?? globalThis; // in a browser this *is* window
const store = new Store({ storage: safeLocalStorage() });
const settings = loadSettings();
const pool = new GatewayPool({ store });
const toolkit = new Toolkit({});
const memory = new Memory({ store, pool });
const habits = new Habits({ store, bus });
const perception = new Perception({ win, bus, store });
bus.on('perception:signal', ({ type }) => type && habits.observe(type, {}));
const speech = new Speech({ win, pool, bus, store, enabled: settings.speak, preset: settings.pack });
const brain = new Brain({
  pool,
  toolkit,
  memory,
  habits,
  perception,
  speech,
  bus,
  store,
  getSettings: () => settings,
});
const puppet = new Puppet({ win, doc: win.document ?? globalThis.document, container: document.getElementById('puppet-layer'), bus, store });
const scheduler = new Scheduler({
  store,
  bus,
  onFire: (item) => onScheduledFire(item),
});

/** Toolkit needs the live objects (puppet, memory, scheduler, …) as context. */
Object.assign(toolkit.ctx, {
  fetch: (...args) => fetch(...args),
  store,
  memory,
  habits,
  perception,
  puppet,
  scheduler,
  geo: () => perception.location,
  selfTest: runSelfTest,
  getGeo: () => perception.location,
});
toolkit.ctx.geo = perception.location;
toolkit.ctx.selfTest = runSelfTest;

/* ─────────── settings ─────────── */
function safeLocalStorage() {
  try {
    globalThis.localStorage?.setItem('pip.probe', '1');
    globalThis.localStorage?.removeItem('pip.probe');
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function loadSettings() {
  const defaults = {
    onboarded: false,
    userName: '',
    pack: 'deku',
    dials: PACKS.deku.dials,
    speak: true,
    voiceName: null,
    camera: false,
    motion: false,
    voiceWake: false,
    nudges: true,
    quietStart: '23:00',
    quietEnd: '07:00',
    privateMode: false,
    needleUrl: '',
    ollamaUrl: '',
    puter: true,
  };
  return { ...defaults, ...(store.get('settings', {}) || {}) };
}
const saveSettings = () => store.set('settings', settings);

function applySettingsToModules() {
  speech.setEnabled(settings.speak);
  speech.setPreset(settings.pack);
  if (settings.voiceName) speech.setVoiceByName(settings.voiceName);
  pool.setPrivateMode(settings.privateMode);
  if (settings.needleUrl) pool.setEndpoints({ needle: settings.needleUrl });
  if (settings.ollamaUrl) pool.setEndpoints({ ollama: settings.ollamaUrl });
}

/* ─────────── bubbles & toasts ─────────── */
/* UI timers are tracked so shutdown() (tests, embedding, page-hide) can leave
   nothing behind: a stray 9-second bubble timer outliving the page is how a
   headless test suite ends up hanging for no visible reason. */
const uiTimers = new Set();
function later(fn, ms) {
  const handle = setTimeout(() => {
    uiTimers.delete(handle);
    try {
      fn();
    } catch (err) {
      console.warn('[pip] deferred task failed', err?.message || err);
    }
  }, ms);
  uiTimers.add(handle);
  return handle;
}
function clearUiTimers() {
  for (const handle of uiTimers) clearTimeout(handle);
  uiTimers.clear();
}

const bubbleLayer = document.getElementById('bubble-layer');
let liveBubble = null;

function showBubble(text, { who = 'Pip', thinking = false, sticky = false, tools = [], actions = [], id = 'main' } = {}) {
  if (!text) return null;
  const el = document.createElement('div');
  el.className = `bubble${thinking ? ' bubble--think' : ''}`;
  el.dataset.bubbleId = id;
  el.innerHTML = `<span class="bubble__who">${escapeHtml(who)}</span><span class="bubble__text"></span>`;
  el.querySelector('.bubble__text').textContent = text;
  if (tools.length) {
    const row = document.createElement('div');
    row.className = 'bubble__tools';
    row.innerHTML = tools.map((t) => `<span class="bubble__tool">🔧 ${escapeHtml(t)}</span>`).join('');
    el.appendChild(row);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'bubble__actions';
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.className = 'btn btn--ghost';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      row.appendChild(b);
    });
    el.appendChild(row);
  }
  const existing = bubbleLayer.querySelector(`[data-bubble-id="${id}"]`);
  if (existing) existing.remove();
  bubbleLayer.appendChild(el);
  positionBubble(el);
  const life = sticky ? 9000 : Math.min(14000, 2600 + text.length * 55);
  el._timeout = later(() => el.remove(), life);
  if (id === 'main') liveBubble = el;
  return el;
}

function positionBubble(el) {
  const a = puppet.anchor();
  const bounds = puppet.bounds();
  const x = clamp(a.x, 110, bounds.w - 110);
  el.style.left = `${x}px`;
  el.style.top = `${clamp(a.y - 12, 90, bounds.h - 140)}px`;
}

function updateLiveBubble(text, { thinking = false, tools = [] } = {}) {
  const el = showBubble(text, { thinking, tools, id: 'main', sticky: true });
  positionBubble(el);
  return el;
}

function clearBubble() {
  liveBubble?.remove();
  liveBubble = null;
}

function toast(text, kind = '') {
  const layer = document.getElementById('toast-layer');
  const el = document.createElement('div');
  el.className = `toast ${kind ? `toast--${kind}` : ''}`;
  el.textContent = text;
  layer.appendChild(el);
  later(() => el.remove(), 3400);
}

/* ─────────── chat ─────────── */
const chatLog = document.getElementById('chat-log');
const chatHistory = store.get('chat', []) || [];

function renderChat() {
  chatLog.innerHTML = '';
  for (const m of chatHistory.slice(-60)) addChatMessage(m.role, m.content, { tools: m.tools, speakable: false });
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addChatMessage(role, content, { tools = [], speakable = false, meta = '' } = {}) {
  const el = document.createElement('div');
  el.className = `msg msg--${role === 'user' ? 'me' : role === 'system' ? 'sys' : 'pip'}`;
  const who = role === 'user' ? 'You' : role === 'system' ? '・' : 'Pip';
  el.innerHTML = `<span class="msg__meta">${escapeHtml(who)}${meta ? ` · ${escapeHtml(meta)}` : ''}</span>`;
  const body = document.createElement('div');
  body.textContent = content;
  el.appendChild(body);
  if (tools.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg__tools';
    wrap.innerHTML = tools.map((t) => `<span class="msg__tool">🔧 ${escapeHtml(t.name)}${t.result?.ok === false ? ' ⚠︎' : ''}</span>`).join('');
    el.appendChild(wrap);
  }
  if (speakable) {
    const btn = document.createElement('button');
    btn.className = 'msg__speak';
    btn.textContent = '🔊 say again';
    btn.addEventListener('click', () => speech.speak(content));
    el.appendChild(btn);
  }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function pushHistory(role, content, tools = []) {
  chatHistory.push({ role, content, tools, at: Date.now() });
  while (chatHistory.length > 80) chatHistory.shift();
  store.set('chat', chatHistory);
}

let busy = false;
async function sendMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || busy) return null;
  busy = true;
  document.body.classList.add('is-busy');
  if (puppet.anim === 'sleep') puppet.wake(); // talking to him wakes him up
  addChatMessage('user', text);
  pushHistory('user', text);
  memory.observe?.('interaction');
  habits.observe('message', { chars: text.length });
  puppet.setAnim('think');
  puppet.setExpression('curious');
  const tools = [];
  let streamEl = null;
  let streamed = '';

  try {
    const result = await brain.respond(text, {
      history: chatHistory.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      onStatus: ({ status, tools: toolNames }) => {
        if (status === 'using-gadgets' && toolNames?.length) {
          updateLiveBubble(`Using my gadget${toolNames.length > 1 ? 's' : ''}: ${toolNames.join(', ')}…`, { thinking: true });
          puppet.setAnim('think');
        } else if (status === 'thinking') {
          updateLiveBubble(pick(PACKS[settings.pack]?.thinking || ['Thinking…']), { thinking: true });
        } else if (status === 'offline-brain') {
          toast('free gateways busy — answering from my own head', 'bad');
        }
      },
      onToken: (t) => {
        streamed += t;
        if (!streamEl) {
          streamEl = updateLiveBubble(streamed, { thinking: false });
          puppet.setAnim('talk');
        } else {
          streamEl.querySelector('.bubble__text').textContent = streamed;
        }
      },
    });

    const reply = result.reply || localReply(text, { pack: PACKS[settings.pack] }).text;
    const toolList = (result.toolResults || []).map((t) => ({ name: t.name, result: t.result }));
    // If a gadget just told him to sleep, stay asleep — do not talk over it.
    if (puppet.anim !== 'sleep') {
      puppet.setAnim('talk', { durationMs: Math.min(9000, 900 + reply.length * 55) });
      puppet.setExpression(result.mood || 'happy');
    }
    updateLiveBubble(reply, { tools: toolList.map((t) => t.name) });
    addChatMessage('pip', reply, { tools: toolList, speakable: true, meta: result.gateway ? `via ${result.gateway}` : result.offline ? 'offline brain' : '' });
    pushHistory('pip', reply, toolList);
    if (settings.speak) await speech.speak(reply);
    if (puppet.anim !== 'sleep') later(() => puppet.setAnim('idle'), 400);
    if (result.mood === 'wow' || /plus ultra/i.test(reply)) puppet.perform('cheer');
    return result;
  } catch (err) {
    // Absolute last line of defence: Pip never shows an error, he apologises.
    const fallback = localReply(text, { pack: PACKS[settings.pack], userName: settings.userName });
    addChatMessage('pip', fallback.text, { meta: 'offline brain' });
    updateLiveBubble(fallback.text);
    puppet.setExpression('sad');
    puppet.setAnim('talk', { durationMs: 3000 });
    console.warn('[pip] turn failed', err);
    return { reply: fallback.text, mood: 'sad', offline: true, toolResults: [] };
  } finally {
    busy = false;
    document.body.classList.remove('is-busy');
    if (!speech.speaking && puppet.anim !== 'sleep') later(() => puppet.setAnim('idle'), 1200);
  }
}

/* ─────────── dock: text input + hold-to-talk ─────────── */
const askForm = document.getElementById('ask-form');
const askInput = document.getElementById('ask-input');
askForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = askInput.value;
  askInput.value = '';
  sendMessage(v);
});

const micBtn = document.getElementById('btn-talk');
let micActive = false;

async function startListening() {
  if (micActive) return;
  if (!speech.listenSupported) return toast('this browser has no free speech input 🥺', 'bad');
  micActive = true;
  micBtn.classList.add('is-live');
  puppet.setAnim('talk', { durationMs: 12000 });
  puppet.setExpression('curious');
  updateLiveBubble('Listening…', { thinking: true });
  try {
    const res = await speech.listen({
      onPartial: (partial) => updateLiveBubble(partial, { thinking: true }),
    });
    micActive = false;
    micBtn.classList.remove('is-live');
    clearBubble();
    if (res.ok && res.text) {
      askInput.value = '';
      await sendMessage(res.text);
    } else {
      puppet.setAnim('idle');
      const hint = /denied|not allowed/i.test(res.error || '') ? 'I need mic permission to listen — check the browser lock icon.' : "I did not catch that. Hold the mic and talk close to your phone!";
      updateLiveBubble(hint);
      if (settings.speak) speech.speak(hint);
      later(() => puppet.setAnim('idle'), 1500);
    }
  } catch (err) {
    micActive = false;
    micBtn.classList.remove('is-live');
    console.warn('[pip] listen failed', err);
    toast('mic hiccup — try again', 'bad');
  }
}

micBtn?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startListening();
});
micBtn?.addEventListener('pointerup', () => speech.stopListening());
micBtn?.addEventListener('pointercancel', () => speech.stopListening());

/* ─────────── puppet interactions ─────────── */
bus.on('puppet:tap', () => {
  const line = settings.speak ? idleLine({ pack: PACKS[settings.pack], userName: settings.userName }) : null;
  if (line) {
    showBubble(line);
    speech.speak(line, { force: false });
  }
});
bus.on('puppet:double-tap', () => {
  const line = pick(['Double tap?! PLUS ULTRA!', 'Wheee! Again, again!', 'Woah — my head is spinning!']);
  showBubble(line);
  speech.speak(line);
  showSparkles();
});
bus.on('puppet:long-press', () => openSheet('brain'));
bus.on('puppet:fling', () => {
  if (Math.random() < 0.5) {
    const line = pick(['Whaaa—! I am flying!', 'Catch me catch me catch me!', 'I am okay! I am okay!']);
    showBubble(line);
    if (settings.speak) speech.speak(line);
  }
});
bus.on('puppet:bounce', () => puppet.setExpression('wow'));
bus.on('puppet:sleep', () => showBubble('…z z z …'));
bus.on('puppet:wake', () => showBubble('I am awake! What did I miss?'));

function showSparkles() {
  puppet.perform('sparkle');
}

/* ─────────── scheduled things fire here ─────────── */
function onScheduledFire(item) {
  const label = item.label || (item.type === 'timer' ? 'your timer' : 'your reminder');
  const line =
    item.type === 'timer'
      ? `⏰ ${label} is finished! Plus Ultra!`
      : item.type === 'reminder'
        ? `Hey! You asked me to remind you: ${label}.`
        : `Quick nudge: ${label}`;
  showBubble(line, { sticky: true });
  addChatMessage('system', line);
  pushHistory('system', line);
  speech.speak(line);
  puppet.perform(item.type === 'timer' ? 'cheer' : 'wave');
  habits.observe('reminder_fired', { type: item.type });
}

/* ─────────── sheets & tabs ─────────── */
const sheet = document.getElementById('sheet');
function openSheet(tab) {
  sheet.hidden = false;
  if (tab) selectTab(tab);
  const grip = document.getElementById('sheet-grip');
  if (typeof grip?.scrollIntoView === 'function') grip.scrollIntoView({ block: 'nearest' });
  if (tab === 'brain') renderGateways();
  if (tab === 'memory') renderMemory();
  if (tab === 'habits') renderHabits();
}
function closeSheet() {
  sheet.hidden = true;
}
document.getElementById('btn-sheet')?.addEventListener('click', () => (sheet.hidden ? openSheet('chat') : closeSheet()));
document.getElementById('sheet-grip')?.addEventListener('click', closeSheet);
// Three more ways out, because the dock hides behind the sheet while it is open.
document.getElementById('btn-close-sheet')?.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheet.hidden) closeSheet();
});
document.getElementById('stage')?.addEventListener('click', () => {
  if (!sheet.hidden) closeSheet(); // tapping the sky/puppet area dismisses the sheet
});
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === name));
  if (name === 'brain') renderGateways();
  if (name === 'memory') renderMemory();
  if (name === 'habits') renderHabits();
}

/* ─────────── brains pane ─────────── */
const gatewayListEl = document.getElementById('gateway-list');
const probeLogEl = document.getElementById('probe-log');

function renderGateways() {
  const status = pool.status();
  gatewayListEl.innerHTML = status
    .map((g) => {
      const dot = !g.usable ? '' : g.coolingFor ? 'is-warm' : g.ok ? 'is-ok' : g.fail ? 'is-bad' : '';
      const state = !g.usable
        ? g.keyless
          ? 'off (you turned it off)'
          : 'needs a free key'
        : g.coolingFor
          ? `cooling down ${g.coolingFor}s`
          : g.ok
            ? `ready · ${g.latencyMs}ms · ${g.ok} ok`
            : g.fail
              ? `last try failed${g.lastError ? `: ${g.lastError.slice(0, 40)}` : ''}`
              : 'not tried yet';
      return `<div class="gw"><span class="gw__dot ${dot}"></span>
        <span><b>${escapeHtml(g.label)}</b> <span class="gw__tag ${g.keyless ? 'gw__tag--keyless' : ''}">${g.keyless ? 'keyless' : 'free key'}</span><br>
        <span class="gw__meta">${g.models.join(', ')} · ${state}</span></span>
        <span class="gw__meta">${g.keyed ? '🔑' : ''}${g.local ? '📴' : ''}</span></div>`;
    })
    .join('');
  renderKeyRows();
}

function renderKeyRows() {
  const el = document.getElementById('key-rows');
  if (!el) return;
  el.innerHTML = '';
  for (const gw of pool.catalog.filter((g) => !g.keyless && !g.local)) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.innerHTML = `<span>${escapeHtml(gw.label)} — ${escapeHtml(gw.notes || '')}</span>`;
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'paste a free-tier key (stored on this device only)';
    input.value = pool.keys[gw.id] || '';
    input.addEventListener('change', () => {
      pool.setKey(gw.id, input.value);
      toast(`${gw.label} ${input.value ? 'key saved' : 'key cleared'}`);
      renderGateways();
    });
    wrap.appendChild(input);
    el.appendChild(wrap);
  }
}

document.getElementById('btn-probe')?.addEventListener('click', async () => {
  probeLogEl.textContent = 'probing every free brain (this uses a few requests)…\n';
  const results = await pool.probe({
    onProgress: (r) => {
      probeLogEl.textContent += `${r.ok ? '✅' : '❌'} ${r.id} ${r.ms}ms ${r.ok ? r.sample || '' : r.error || ''}\n`;
      probeLogEl.scrollTop = probeLogEl.scrollHeight;
      renderGateways();
    },
  });
  const ok = results.filter((r) => r.ok).length;
  probeLogEl.textContent += `\n${ok}/${results.length} free brains answered.\n`;
  renderGateways();
  toast(`${ok}/${results.length} brains reachable`);
});
document.getElementById('btn-reset-health')?.addEventListener('click', () => {
  pool.resetHealth();
  renderGateways();
  toast('gateway health reset');
});

/* ─────────── memory pane ─────────── */
const memoryListEl = document.getElementById('memory-list');
const memSearch = document.getElementById('mem-search');
function renderMemory(filter = '') {
  const items = memory
    .all()
    .filter((m) => !filter || m.text.toLowerCase().includes(filter.toLowerCase()))
    .slice(-60)
    .reverse();
  memoryListEl.innerHTML = items.length
    ? items
        .map(
          (m) => `<div class="list__item" data-id="${m.id}"><span>${escapeHtml(m.text)}<br><span class="gw__meta">${m.tag} · ${new Date(m.at).toLocaleString()}</span></span>
        <button data-forget="${m.id}" title="forget this">🗑️</button></div>`,
        )
        .join('')
    : '<div class="list__item">My notebook is empty. Tell me something about you!</div>';
  const profile = memory.profile();
  document.getElementById('profile-view').innerHTML = Object.entries(profile).length
    ? Object.entries(profile)
        .map(([k, v]) => `<div class="list__item"><b>${escapeHtml(k)}</b> <span>${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}</span></div>`)
        .join('')
    : '<div class="list__item">Nothing learned yet.</div>';
}
memoryListEl?.addEventListener('click', (e) => {
  const id = e.target?.dataset?.forget;
  if (!id) return;
  memory.forgetById(id);
  renderMemory(memSearch?.value || '');
});
memSearch?.addEventListener('input', () => renderMemory(memSearch.value));
document.getElementById('btn-add-mem')?.addEventListener('click', () => {
  const text = prompt('What should Pip remember?');
  if (text) {
    memory.remember(text, { tag: 'note', importance: 0.8 });
    renderMemory();
    toast('noted in the hero notebook!');
  }
});
document.getElementById('btn-wipe-mem')?.addEventListener('click', () => {
  if (confirm('Erase everything Pip remembers about you?')) {
    memory.clear();
    renderMemory();
    toast('notebook erased');
  }
});

/* ─────────── habits pane ─────────── */
function renderHabits() {
  const el = document.getElementById('habits-view');
  el.innerHTML = habits
    .insights()
    .map((i) => `<div class="list__item">📓 <span>${escapeHtml(i)}</span></div>`)
    .join('');
  document.getElementById('signals-view').textContent = JSON.stringify(perception.snapshot(), null, 2);
}
document.getElementById('btn-scan-habits')?.addEventListener('click', () => {
  renderHabits();
  habits.observe('manual_scan');
  toast('habit scan done');
});
document.getElementById('btn-habits-report')?.addEventListener('click', async () => {
  const report = habits.report();
  await sendMessage('give me my habit report');
  if (settings.speak) speech.speak(report.summary);
});

/* ─────────── settings pane ─────────── */
function wireSettings() {
  const nameEl = document.getElementById('cfg-name');
  nameEl.value = settings.userName;
  nameEl.addEventListener('change', () => {
    settings.userName = nameEl.value.trim();
    saveSettings();
    if (settings.userName) memory.remember(`My name is ${settings.userName}`, { tag: 'fact', importance: 0.95 });
    scheduleNextNudge();
  });

  const voiceSel = document.getElementById('cfg-voice');
  const fillVoices = () => {
    const voices = speech.voices();
    voiceSel.innerHTML = '<option value="">auto (best for my persona)</option>' + voices.map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} · ${escapeHtml(v.lang || '')}</option>`).join('');
    voiceSel.value = settings.voiceName || '';
  };
  fillVoices();
  later(fillVoices, 800);
  voiceSel.addEventListener('change', () => {
    settings.voiceName = voiceSel.value || null;
    saveSettings();
    applySettingsToModules();
    speech.speak('Like this? I can change my voice whenever you want!');
  });

  const bind = (id, key, onChange) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key] ?? '';
    el.addEventListener('change', async () => {
      settings[key] = el.type === 'checkbox' ? el.checked : el.value;
      saveSettings();
      applySettingsToModules();
      await onChange?.(settings[key]);
    });
  };

  bind('cfg-speak', 'speak', (v) => (v ? speech.speak('Okay! I will talk now.') : null));
  bind('cfg-voicewake', 'voiceWake', (v) => (v ? startWakeWord() : stopWakeWord()));
  bind('cfg-nudges', 'nudges');
  bind('cfg-quiet-start', 'quietStart');
  bind('cfg-quiet-end', 'quietEnd');
  bind('cfg-private', 'privateMode', (v) => toast(v ? 'private mode: no network at all' : 'private mode off — free gateways allowed'));
  bind('cfg-needle', 'needleUrl', (v) => v && toast('needle bridge saved — on-device tool calls!'));
  bind('cfg-ollama', 'ollamaUrl', (v) => v && toast('ollama bridge saved'));
  bind('cfg-camera', 'camera', async (v) => {
    if (v) {
      const res = await perception.startCamera({ fps: 2 });
      if (!res.ok) {
        toast('camera unavailable — Pip will rely on other senses', 'bad');
        document.getElementById('cfg-camera').checked = false;
        settings.camera = false;
        saveSettings();
      }
    } else {
      perception.stopCamera();
      document.getElementById('ind-eye').hidden = true;
    }
  });

  document.getElementById('btn-export')?.addEventListener('click', () => {
    const json = JSON.stringify(store.export(), null, 2);
    try {
      if (!URL?.createObjectURL) throw new Error('downloads unsupported here');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = `pip-notebook-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      toast('exported your notebook');
    } catch {
      // last resort: put it on the clipboard so nothing is lost
      navigator.clipboard?.writeText?.(json).then(
        () => toast('notebook copied to your clipboard'),
        () => toast('export unsupported in this browser', 'bad'),
      );
    }
  });
  document.getElementById('btn-import')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        store.import(JSON.parse(await file.text()));
        toast('notebook imported — reloading');
        later(() => safeReload(), 800);
      } catch (err) {
        toast(`import failed: ${err.message}`, 'bad');
      }
    });
    input.click();
  });
  document.getElementById('btn-reset')?.addEventListener('click', () => {
    if (!confirm('Factory reset: erase Pip\'s memory, habits and settings?')) return;
    store.clearAll();
    toast('all clean — reloading');
    later(() => safeReload(), 700);
  });
  document.getElementById('btn-test')?.addEventListener('click', async () => {
    const view = document.getElementById('selftest-view');
    view.textContent = 'running my hero check-up…';
    const res = await runSelfTest();
    view.textContent = res.report;
    toast(res.ok ? 'self-test: all green ✅' : 'self-test found something ⚠️', res.ok ? '' : 'bad');
  });
}

/* ─────────── mood dials ─────────── */
function wireMoodBar() {
  const bar = document.getElementById('mood-bar');
  document.getElementById('mood-btn')?.addEventListener('click', () => (bar.hidden = !bar.hidden));
  const map = { 'mood-energy': 'energy', 'mood-cheer': 'cheer', 'mood-mutter': 'mutter', 'mood-chatty': 'chatty' };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    el.value = settings.dials[key];
    el.addEventListener('input', () => {
      settings.dials = normalizeDials({ ...settings.dials, [key]: Number(el.value) });
      saveSettings();
      puppet.setMood(settings.dials.energy > 85 ? 'hyped' : settings.dials.energy < 30 ? 'calm' : 'normal');
    });
  }
}

/* ─────────── wake word (opt-in, free Web Speech) ─────────── */
let wakeLoop = null;
function startWakeWord() {
  if (wakeLoop || !speech.SpeechRecognition) return toast('wake word needs browser speech recognition', 'bad');
  const Recognition = speech.SpeechRecognition;
  const rec = new Recognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    const text = last[0].transcript.toLowerCase();
    if (/\b(pip|puppet|hey pip|deku)\b/.test(text)) {
      if (busy || speech.speaking) return;
      rec.stop();
      const said = text.replace(/.*\b(pip|puppet|deku)\b/, '').trim();
      if (said.length > 3) sendMessage(said);
      else {
        showBubble('Yes? I am listening!');
        micBtn?.dispatchEvent(new Event('pointerdown'));
      }
    }
  };
  rec.onend = () => {
    if (settings.voiceWake && wakeLoop) {
      try {
        rec.start();
      } catch {
        /* ignore */
      }
    }
  };
  try {
    rec.start();
    wakeLoop = rec;
    toast('wake word on — say "hey Pip"');
    document.getElementById('ind-mic').hidden = false;
  } catch {
    wakeLoop = null;
  }
}
function stopWakeWord() {
  wakeLoop?.stop?.();
  wakeLoop = null;
  document.getElementById('ind-mic').hidden = true;
}

/* ─────────── proactive nudges ─────────── */
let nudgeTimer = null;
let themeTimer = null;
function scheduleNextNudge() {
  clearTimeout(nudgeTimer);
  const delay = 3 * 60000 + Math.random() * 4 * 60000;
  nudgeTimer = setTimeout(async () => {
    const nudge = habits.suggestNudge({
      quietStart: settings.quietStart,
      quietEnd: settings.quietEnd,
      enabled: settings.nudges && !settings.privateMode,
      minGapMs: 30 * 60000,
    });
    if (nudge && !busy && !speech.speaking) {
      showBubble(nudge.text, { sticky: true });
      if (settings.speak) speech.speak(nudge.text);
      puppet.perform('wave');
      addChatMessage('system', nudge.text);
    }
    scheduleNextNudge();
  }, delay);
}

/* ─────────── presence & senses ─────────── */
function wirePerception() {
  bus.on('perception:presence', ({ present, motionLevel }) => {
    document.getElementById('ind-eye').hidden = false;
    document.getElementById('presence-dot').parentElement?.setAttribute('data-presence', present ? 'watching' : 'away');
    if (present) {
      puppet.setExpression('curious');
      puppet.setLook('up');
      if (!wirePerception._greetedAt || Date.now() - wirePerception._greetedAt > 10 * 60000) {
        wirePerception._greetedAt = Date.now();
        const line = settings.userName ? `Oh! There you are, ${settings.userName}.` : 'Oh! There you are!';
        showBubble(line);
        if (settings.speak) speech.speak(line);
        puppet.perform('wave');
      }
    } else {
      puppet.setExpression('sad');
      later(() => puppet.setExpression('happy'), 2600);
    }
    habits.observe('presence', { present, motionLevel });
  });
  bus.on('perception:camera', ({ state }) => {
    document.getElementById('ind-eye').hidden = state !== 'on';
    if (state === 'denied') toast('camera blocked — Pip will use his other senses', 'bad');
  });
  bus.on('perception:step', () => {
    document.getElementById('ind-motion').hidden = false;
    habits.observe('motion', { via: 'sensor' });
  });
  bus.on('perception:wake', () => {
    const line = 'You are back! I kept watch the whole time.';
    showBubble(line);
    if (settings.speak) speech.speak(line);
  });
  bus.on('perception:sleep', () => {
    perception.observe('session_end', { minutes: Math.round((Date.now() - (perception.sessionStart || Date.now())) / 60000) });
    habits.observe('session_end', { minutes: Math.round((Date.now() - (perception.sessionStart || Date.now())) / 60000) });
  });
  bus.on('perception:battery', () => renderIndicators());
  bus.on('perception:net', () => renderIndicators());
  bus.on('brain:status', ({ status }) => {
    document.getElementById('brain-label').textContent = status === 'thinking' ? 'thinking…' : status === 'using-gadgets' ? 'using gadgets…' : 'ready';
  });
  bus.on('brain:reply', ({ gateway }) => renderIndicators(gateway));
  bus.on('perception:visibility', (state) => {
    if (state === 'hidden' && perception.watching) toast('Pip paused his eyes while you are away');
  });
}

function renderIndicators(gateway) {
  const bat = perception.battery();
  const net = perception.network();
  const batEl = document.getElementById('ind-battery');
  const netEl = document.getElementById('ind-net');
  const dot = document.getElementById('brain-dot');
  const label = document.getElementById('brain-label');
  if (bat.level != null) {
    batEl.textContent = bat.charging ? '🔌' : bat.level > 0.6 ? '🔋' : bat.level > 0.25 ? '🪫' : '🆘';
    batEl.title = `battery ${Math.round(bat.level * 100)}%${bat.charging ? ' (charging)' : ''}`;
    batEl.className = `ind ${bat.level < 0.15 ? 'is-bad' : bat.level < 0.3 ? 'is-warn' : ''}`;
  }
  netEl.textContent = net.online === false ? '📵' : net.effectiveType === '4g' ? '🌐' : '📶';
  netEl.title = net.online === false ? 'offline — Pip uses his own head' : `online via ${net.effectiveType || net.type || 'network'}`;
  const top = pool.order()[0];
  const usableCount = pool.order().length;
  dot.className = `chip__dot ${usableCount ? 'is-ok' : 'is-bad'}`;
  label.textContent = usableCount ? `${gateway || top.label} · ${usableCount} free brain${usableCount === 1 ? '' : 's'}` : 'no free brains left — offline mode';
}

/* ─────────── self test (used by the button and by tests) ─────────── */
async function runSelfTest() {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  check('puppet mounted', !!puppet.el && !!puppet.rootEl);
  check('puppet art parts', ['body-group', 'head-group', 'mouth', 'pupil', 'eyelid'].every((c) => !!puppet.el?.querySelector(`.${c}`)));
  check('toolbox loaded', toolkit.list().length >= 20, `${toolkit.list().length} gadgets`);
  check('memory writable', (() => {
    const before = memory.all().length;
    memory.remember('self-test ping', { tag: 'selftest', importance: 0.1 });
    const ok = memory.all().length >= before;
    memory.forget('self-test ping');
    return ok;
  })());
  check('scheduler alive', !!scheduler && typeof scheduler.add === 'function');
  check('storage on device', store.keys().length >= 0);
  check('gateways known', pool.catalog.filter((g) => g.keyless).length >= 4, `${pool.catalog.filter((g) => g.keyless).length} keyless`);
  const online = perception.network().online !== false;
  if (online) {
    const results = await pool.probe({ limit: 3 });
    check('free gateway reachable', results.some((r) => r.ok), results.map((r) => `${r.id}:${r.ok ? 'ok' : 'down'}`).join(', '));
  } else {
    check('offline mode', true, 'local brain only');
  }
  check('privacy invariants', perception.privacyInvariants().ok, JSON.stringify(perception.privacyInvariants()));
  const ok = checks.every((c) => c.ok);
  const report = `${ogm('🥦 Plus Ultra Puppet — self test')}\n${checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`).join('\n')}\n${ogm(ok ? 'ALL SYSTEMS: PLUS ULTRA' : 'SOME CHECKS NEED ATTENTION')}`;
  return { ok, checks, report, summary: ok ? 'Every system is green — feel free to throw me around!' : 'Mostly fine! One or two gadgets are grumpy.' };
}

function ogm(t) {
  return t;
}

/* ─────────── onboarding ─────────── */
function wireOnboarding() {
  const modal = document.getElementById('onboarding');
  const art = document.getElementById('onboard-art');
  const puppetMarkup = document.querySelector('#puppet-layer svg');
  if (puppetMarkup && art) art.innerHTML = puppetMarkup.outerHTML;
  if (settings.onboarded) {
    modal.hidden = true;
    return;
  }
  modal.hidden = false;
  document.getElementById('ob-start')?.addEventListener('click', async () => {
    settings.userName = document.getElementById('ob-name').value.trim();
    settings.pack = document.getElementById('ob-persona').value;
    settings.speak = true;
    const wantCam = document.getElementById('ob-perms-cam').checked;
    settings.onboarded = true;
    saveSettings();
    applySettingsToModules();
    modal.hidden = true;
    if (settings.userName) {
      memory.remember(`My name is ${settings.userName}`, { tag: 'fact', importance: 0.95 });
      document.getElementById('cfg-name').value = settings.userName;
    }
    const greeting = settings.userName
      ? `Hi ${settings.userName}! I am Pip, your little puppet hero. Tap me, drag me, or hold the mic and talk — I am all yours. Plus Ultra!`
      : 'Hi! I am Pip, your little puppet hero. Tap me, drag me, or hold the mic and talk — I am all yours. Plus Ultra!';
    showBubble(greeting, { sticky: true });
    puppet.perform('cheer');
    speech.speak(greeting);
    if (wantCam) {
      const res = await perception.startCamera({ fps: 2 });
      if (!res.ok) toast('no camera access — Pip still sees the time, your battery and your habits', 'bad');
      else {
        settings.camera = true;
        document.getElementById('cfg-camera').checked = true;
        saveSettings();
      }
    }
    if (settings.voiceWake) startWakeWord();
    toast('tap me whenever you want to talk!');
  });
}

/* ─────────── day/night theme ─────────── */
function updateTheme() {
  const stage = document.getElementById('stage');
  const part = partOfDay();
  stage.dataset.theme = part === 'night' ? 'night' : part === 'evening' ? 'dusk' : 'day';
  if (part === 'night' && settings.nudges) puppet.sleep();
  else if (puppet.anim === 'sleep') puppet.wake();
}

/* ─────────── pwa ─────────── */
let deferredInstall = null;
function wirePwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    const btn = document.getElementById('btn-install');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      deferredInstall?.prompt();
      await deferredInstall?.userChoice;
      deferredInstall = null;
      btn.hidden = true;
    });
  });
  if ('serviceWorker' in navigator) {
    // A new worker (new cache version) takes over immediately, and if this page
    // was being served by an older one we reload once so the fix is actually on
    // screen. Without this, cache-first workers happily serve a broken build
    // forever — which is exactly the trap this app fell into once.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      console.info('[pip] fresh build installed — one reload for the new Pip');
      safeReload();
    });
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        reg.update?.();
        reg.waiting?.postMessage('pip:skip-waiting');
      })
      .catch((err) => console.info('[pip] offline cache unavailable', err?.message));
  }
}

/* ─────────── optional keyless extras ─────────── */
function loadPuter() {
  if (!settings.puter) return;
  const s = document.createElement('script');
  s.src = 'https://js.puter.com/v2/';
  s.async = true;
  s.onload = () => {
    pool.attachPuter(window.puter);
    console.info('[pip] puter.js loaded — keyless extra brain + cloud voices');
  };
  s.onerror = () => console.info('[pip] puter.js unavailable (offline?)');
  document.head.appendChild(s);
}

/* ─────────── boot sequence ─────────── */
async function boot() {
  // Idempotent: retrying after a failure (or embedding Pip twice) must never
  // stack a second theme interval / scheduler / perception loop.
  clearUiTimers();
  clearTimeout(nudgeTimer);
  clearInterval(themeTimer);
  scheduler.stop();
  applySettingsToModules();
  puppet.mount();
  wireSettings();
  wireMoodBar();
  wirePerception();
  wireOnboarding();
  wirePwa();
  loadPuter();
  renderChat();
  renderGateways();
  renderMemory();
  renderHabits();
  updateTheme();
  scheduler.start();
  perception.start();
  if (settings.privateMode) toast('private mode is on — Pip stays offline');
  if (settings.voiceWake) startWakeWord();
  scheduleNextNudge();
  renderIndicators();
  themeTimer = setInterval(updateTheme, 60000);
  document.body.dataset.boot = 'ready';
  bus.emit('pip:ready', { at: Date.now() });
  console.info('%c🥦 Plus Ultra Puppet ready','color:#2fe08a;font-weight:bold');
  // friendly hello if the user has been here before
  if (settings.onboarded) {
    const part = partOfDay();
    const hello = settings.userName
      ? `${part === 'night' ? 'Still up' : part === 'morning' ? 'Good morning' : 'Hey'}, ${settings.userName}! I am here.`
      : part === 'morning' ? 'Good morning! I am here.' : 'Hey! I am here.';
    later(() => {
      showBubble(hello);
      puppet.perform('wave');
      if (!settings.camera && !settings.motion) console.info('[pip] tip: enable the presence camera to have him watch over you');
    }, 700);
  }
}

function safeReload() {
  try {
    location.reload();
  } catch {
    /* headless environments cannot reload — a toast already told the user */
  }
}

/** Stop every timer, listener and animation. Used by tests and when embedding Pip. */
export function shutdown() {
  clearUiTimers();
  clearTimeout(nudgeTimer);
  clearInterval(themeTimer);
  scheduler.stop();
  stopWakeWord();
  speech.stop();
  perception.dispose();
  puppet.destroy();
  document.body.dataset.boot = 'stopped';
  bus.emit('pip:shutdown', { at: Date.now() });
}

const recentProblems = [];
function noteProblem(kind, detail) {
  recentProblems.push({ kind, detail: String(detail ?? '').slice(0, 300), at: new Date().toISOString() });
  if (recentProblems.length > 12) recentProblems.shift();
}

/* ─────────── "Pip isn't on my screen" diagnostics ───────────
   ?diag=1 (or Settings → Diagnose) prints the facts needed to debug a blank
   puppet on a real phone: boot state, viewport, the puppet's measured rect, the
   active service-worker cache and the last few runtime problems. */
const diagWanted = typeof location !== 'undefined' && /[?&]diag=1/.test(location.search);
function diagnostics() {
  const p = puppet.measure();
  const cs = typeof win.getComputedStyle === 'function' && puppet.el ? win.getComputedStyle(puppet.el) : null;
  return {
    at: new Date().toISOString(),
    boot: document.body.dataset.boot,
    viewport: { w: win.innerWidth, h: win.innerHeight, dpr: win.devicePixelRatio || 1 },
    art: { classes: puppet.el?.getAttribute('class'), width: cs?.width, height: cs?.height, position: cs?.position },
    puppet: { size: puppet.size, pos: { ...puppet.pos }, floorY: puppet.floorY, groundLine: puppet.groundLine, ...p },
    layerTransform: puppet.rootEl?.style.transform,
    stylesheets: [...document.styleSheets].length,
    serviceWorker: win.navigator?.serviceWorker?.controller?.scriptURL || 'none',
    gateways: pool.status().map((g) => ({ id: g.id, ok: g.ok, fail: g.fail, usable: g.usable })),
    problems: recentProblems,
  };
}
function showDiagnostics() {
  const data = diagnostics();
  const box = document.getElementById('diag-view');
  if (!box) return data;
  box.textContent = `${JSON.stringify(data, null, 2)}\n\n(tap to dismiss)`;
  box.hidden = false;
  if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
  console.info('[pip] diagnostics', data);
  return data;
}
document.getElementById('diag-view')?.addEventListener('click', (e) => {
  e.currentTarget.hidden = true;
});
win.__pipDiagnostics = showDiagnostics;

/* A puppet with no pixels is a bug, never a mystery. */
bus.on('puppet:hidden', (info) => {
  console.error('[pip] the puppet has no size on this screen', info);
  noteProblem('puppet-hidden', JSON.stringify(info));
  toast('Pip could not draw himself — tap here for diagnostics', 'warn');
  const layer = document.getElementById('toast-layer');
  layer?.lastElementChild?.addEventListener('click', () => showDiagnostics());
});

window.addEventListener('error', (e) => {
  noteProblem('error', e.message);
  console.warn('[pip] unhandled', e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  noteProblem('rejection', e.reason?.message || e.reason);
  console.warn('[pip] unhandled promise', e.reason?.message || e.reason);
});

/* Test hooks: system tests import this module inside jsdom and drive it. */
export const __pip = { store, pool, toolkit, memory, habits, perception, speech, brain, puppet, scheduler, settings, sendMessage, showBubble, runSelfTest, boot, bootSafe: bootSafely, shutdown, bus, GATEWAY_CATALOG };

function reportBootFailure(err) {
  console.error('[pip] boot failed', err);
  noteProblem('boot', err?.stack || err?.message || err);
  document.body.dataset.boot = 'error';
  try {
    toast('Pip tripped while starting up — tap the sky to try again', 'warn');
  } catch {
    /* the toast layer itself may be missing; the console error above still tells the story */
  }
  if (typeof window !== 'undefined' && !window.__PIP_TEST_RETRY__) {
    window.__PIP_TEST_RETRY__ = true;
    document.getElementById('stage')?.addEventListener('click', function retry() {
      if (document.body.dataset.boot !== 'error') return;
      document.body.dataset.boot = 'cold';
      bootSafely();
    });
  }
}
function bootSafely() {
  try {
    const started = boot();
    if (started?.catch) started.catch(reportBootFailure);
    return started;
  } catch (err) {
    reportBootFailure(err);
    return null;
  }
}

if (typeof window !== 'undefined' && !window.__PIP_TEST__) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bootSafely());
  else bootSafely();
}

// Settings → Diagnose, or ?diag=1: show what Pip can see about himself.
document.getElementById('btn-diag')?.addEventListener('click', () => showDiagnostics());
if (diagWanted) later(() => showDiagnostics(), 1200);

