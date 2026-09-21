/**
 * Shared test scaffolding: fake DOM, fake clock, fake fetch, fake gateway pool.
 * Everything is dependency-injectable so the tests never touch the internet and
 * never depend on a real browser.
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, makeMemoryStorage } from '../js/core/store.js';

/** Deterministic Math.random for the duration of a test file. Returns a restore(). */
export function seedRandom(seed = 0x5eed) {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return () => {
    Math.random = original;
  };
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ─────────── DOM ─────────── */

export async function loadIndexHtml() {
  return readFile(resolve(ROOT, 'index.html'), 'utf8');
}

export async function makeDom({ url = 'https://pip.test/', html = null, quiet = true } = {}) {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const virtualConsole = new VirtualConsole();
  if (quiet) {
    // canvas/audio are not implementable in jsdom — silence those notices,
    // but keep real script errors visible so tests still fail loudly.
    virtualConsole.on('jsdomError', (err) => {
      if (/Not implemented/i.test(err.message)) return;
      console.error('[jsdom]', err.message);
    });
  }
  const dom = new JSDOM(html ?? (await loadIndexHtml()), { pretendToBeVisual: true, url, virtualConsole });
  trackDom(dom);
  return dom;
}

export async function makeAppDom(options = {}) {
  const dom = await makeDom(options);
  installGlobals(dom.window);
  dom.window.__PIP_TEST__ = true;
  return dom;
}

export function installGlobals(win) {
  const keys = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Blob', 'FormData', 'File', 'URL', 'SpeechSynthesisUtterance', 'DOMParser', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  for (const key of keys) {
    if (win[key] === undefined) continue;
    const value = typeof win[key] === 'function' && /^(getComputedStyle|requestAnimationFrame|cancelAnimationFrame)$/.test(key) ? win[key].bind(win) : win[key];
    try {
      globalThis[key] = value;
    } catch {
      // Node 22 exposes `navigator` as a getter-only global — redefine it.
      try {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
      } catch {
        /* leave the platform default in place */
      }
    }
  }
  // Browser dialogs: main.js calls the bare globals, so route them through the
  // window and let tests stub win.confirm / win.prompt as they see fit.
  for (const fn of ['confirm', 'prompt', 'alert']) {
    const wrapper = (...args) => win[fn]?.(...args);
    try {
      globalThis[fn] = wrapper;
    } catch {
      Object.defineProperty(globalThis, fn, { value: wrapper, configurable: true, writable: true });
    }
  }
  globalThis.window = win;
  globalThis.document = win.document;
  return win;
}

/**
 * Dispatch a pointer event that our drag code understands.
 * jsdom has no PointerEvent constructor, so a MouseEvent with pointerId bolted
 * on is the closest thing — and it exercises exactly the same code path.
 * Works for both elements and windows.
 */
export function pointer(target, type, { x = 0, y = 0, pointerId = 1 } = {}) {
  const win = target?.document ? target : target?.ownerDocument?.defaultView;
  if (!win) throw new Error('pointer(): cannot find a window for that target');
  const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  target.dispatchEvent(ev);
  return ev;
}

/** Track jsdom windows so tests can close them and let Node exit promptly. */
export const openDoms = new Set();
export function trackDom(dom) {
  openDoms.add(dom);
  return dom;
}
export function closeAllDoms() {
  for (const dom of openDoms) {
    try {
      dom.window.close();
    } catch {
      /* ignore */
    }
  }
  openDoms.clear();
}

export const rafTick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/* ─────────── clock ─────────── */

export function fakeClock(start = Date.UTC(2026, 8, 21, 9, 0, 0)) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
    return now;
  };
  clock.set = (ts) => {
    now = ts;
    return now;
  };
  clock.at = (iso) => {
    now = new Date(iso).getTime();
    return now;
  };
  return clock;
}

/* ─────────── store ─────────── */

export function makeStore(seed = {}) {
  return new Store({ storage: makeMemoryStorage(seed) });
}

/* ─────────── fetch ─────────── */

export function jsonResponse(body, { status = 200, ok = status < 400, stream = false } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
    get body() {
      if (!stream) return null;
      const chunks = [text];
      return {
        getReader() {
          let i = 0;
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              const value = new TextEncoder().encode(chunks[i++]);
              return { done: false, value };
            },
          };
        },
      };
    },
  };
}

export function sseBody(content, model = 'test-model') {
  const lines = content
    .match(/.{1,12}/gs)
    .map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
    .join('');
  return `${lines}data: [DONE]\n\n`;
}

/**
 * A fetch stub driven by a route table: { 'host/path': (url, init) => response }
 * or a simple array of behaviours consumed in order.
 */
export function fetchStub(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = typeof url === 'string' ? url : url?.url;
    calls.push({ url: u, init });
    const res = await handler(u, init, calls.length);
    if (!res) throw new TypeError('fetch failed');
    if (res.throw) throw new Error(res.throw);
    return res;
  };
  fn.calls = calls;
  fn.urls = () => calls.map((c) => c.url);
  fn.count = () => calls.length;
  return fn;
}

export const chatOk = (content = 'Plus Ultra, partner!', extra = {}) =>
  jsonResponse({ choices: [{ message: { role: 'assistant', content, ...extra } }] });

/* ─────────── fake pool ─────────── */

export function makePool({ replies = [], fail = false, clock = fakeClock() } = {}) {
  let i = 0;
  return {
    privateMode: false,
    chatCalls: [],
    setPrivateMode(v) {
      this.privateMode = v;
    },
    order: () => [{ id: 'fake', label: 'Fake brain', tools: true }],
    async chat(messages, opts = {}) {
      this.chatCalls.push({ messages, opts });
      if (fail) throw Object.assign(new Error('all down'), { code: 'ALL_GATEWAYS_FAILED' });
      const reply = replies[Math.min(i++, replies.length - 1)] ?? { text: 'Sure!', toolCalls: [] };
      if (opts.onToken) opts.onToken(reply.text);
      return { gateway: 'fake', model: 'fake-1', latencyMs: 5, toolCalls: [], ...reply };
    },
    async embed(texts) {
      const { hashEmbedding } = await import('../js/gateways.js');
      const list = Array.isArray(texts) ? texts : [texts];
      return { vectors: list.map((t) => hashEmbedding(t)), gateway: 'local-hash-256' };
    },
    async transcribe() {
      return { text: 'transcribed words', gateway: 'ovh-whisper' };
    },
    status: () => [{ id: 'fake', label: 'Fake brain', usable: true, ok: 1, fail: 0, coolingFor: 0, latencyMs: 5, keyless: true, models: ['fake-1'] }],
    catalog: [{ id: 'fake', label: 'Fake brain', base: 'https://fake.test/v1', models: ['fake-1'], keyless: true, tools: true, tier: 1 }],
    keys: {},
  };
}

/* ─────────── assertions ─────────── */

export function assertNoThrow(fn, label = 'call') {
  try {
    return fn();
  } catch (err) {
    throw new Error(`${label} threw: ${err.message}`);
  }
}

export async function settle(ms = 5) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Collect console noise made by a module under test. */
export function withCapturedConsole() {
  const messages = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of Object.keys(orig)) {
    console[level] = (...args) => messages.push({ level, text: args.map(String).join(' ') });
  }
  return {
    messages,
    restore() {
      Object.assign(console, orig);
    },
  };
}
