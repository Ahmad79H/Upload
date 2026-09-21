/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  FREE GATEWAY POOL — the reason Pip needs no account, key or credit card.
 * ─────────────────────────────────────────────────────────────────────────────
 *  Keyless OpenAI-compatible endpoints (catalog verified against the public
 *  freellmpool provider catalog, 2026-08):
 *    • Pollinations  text.pollinations.ai/openai   (keyless, per-IP limits)
 *    • LLM7          api.llm7.io/v1                (keyless, "unused" bearer)
 *    • OVHcloud AI   oai.endpoints.kepler.ai.cloud.ovh.net/v1 (keyless, 12 rpm)
 *    • Kilo Gateway  api.kilo.ai/api/gateway       (keyless, ~200 req/h)
 *  Keyless extras: OVH Whisper STT, OVH BGE embeddings, Puter.js (chat+TTS),
 *  Pollinations media endpoint, DuckDuckGo/Wikipedia (in tools.js).
 *
 *  The pool does the boring-but-critical work:
 *   1. orders candidates by health, latency and user preference,
 *   2. hedges — if the favourite is slow it quietly starts the next one,
 *   3. failovers across every free option before ever giving up,
 *   4. cools down rate-limited/broken gateways and remembers why,
 *   5. streams tokens so Pip can talk while still thinking.
 *
 *  Anything that needs a key (Groq, Gemini, OpenRouter…) is opt-in: paste a
 *  free-tier key in Settings and it jumps to the front of the queue.
 */
import { withTimeout, retry, safeJson, clamp } from './core/util.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export const GATEWAY_CATALOG = [
  {
    id: 'pollinations',
    label: 'Pollinations',
    base: 'https://text.pollinations.ai/openai',
    models: ['openai-fast', 'openai', 'gpt-oss'],
    auth: 'none',
    keyless: true,
    tools: false,
    tier: 1,
    minIntervalMs: 1200,
    notes: 'Anonymous, rate-limited per IP. The default free brain.',
  },
  {
    id: 'llm7',
    label: 'LLM7.io',
    base: 'https://api.llm7.io/v1',
    models: ['default', 'fast', 'codestral-latest'],
    auth: 'bearer:unused',
    keyless: true,
    tools: false,
    tier: 1,
    minIntervalMs: 1500,
    notes: 'Keyless ~10 req/min (60/h). Send the placeholder key "unused".',
  },
  {
    id: 'ovh',
    label: 'OVHcloud AI Endpoints',
    base: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    models: ['Meta-Llama-3_3-70B-Instruct', 'gpt-oss-120b', 'Mistral-Nemo-Instruct-2407', 'Qwen3.5-9B'],
    auth: 'none',
    keyless: true,
    tools: true,
    tier: 1,
    minIntervalMs: 900,
    notes: 'Keyless anonymous tier, ~12 rpm. Also serves Whisper + BGE embeddings.',
  },
  {
    id: 'kilo',
    label: 'Kilo Gateway',
    base: 'https://api.kilo.ai/api/gateway',
    models: ['kilo-auto/free', 'openrouter/free', 'minimax/minimax-m2.7:free', 'liquid/lfm-2.5-2.6b:free'],
    auth: 'none',
    keyless: true,
    tools: true,
    tier: 1,
    minIntervalMs: 1200,
    notes: 'Keyless ~200 req/h per IP. Free routes may log prompts — no secrets.',
  },
  {
    id: 'zen',
    label: 'OpenCode Zen',
    base: 'https://opencode.ai/zen/v1',
    models: ['deepseek-v4-flash-free', 'nemotron-3-ultra-free'],
    auth: 'none',
    keyless: true,
    tools: true,
    tier: 3,
    minIntervalMs: 1500,
    enabled: false,
    notes: 'Promo keyless routes that come and go. Off by default until it answers a probe.',
  },
  {
    id: 'pollinations-media',
    label: 'Pollinations (media)',
    base: 'https://gen.pollinations.ai/v1',
    models: ['openai'],
    auth: 'none',
    keyless: true,
    tools: false,
    tier: 3,
    minIntervalMs: 2000,
    enabled: false,
    notes: 'Unified text/image/audio endpoint — needs a Pollinations key for most models.',
  },
  { id: 'groq', label: 'Groq', base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], auth: 'bearer:key', keyless: false, tools: true, tier: 0, minIntervalMs: 300, notes: 'Free tier key = very fast + real tool calling.' },
  { id: 'gemini', label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash', 'gemini-flash-latest'], auth: 'bearer:key', keyless: false, tools: true, tier: 0, minIntervalMs: 500, notes: 'Free tier key; excellent tool calling and vision.' },
  { id: 'cerebras', label: 'Cerebras', base: 'https://api.cerebras.ai/v1', models: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507'], auth: 'bearer:key', keyless: false, tools: true, tier: 0, minIntervalMs: 300, notes: 'Free tier key, blisteringly fast.' },
  { id: 'openrouter', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', models: ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-8b:free'], auth: 'bearer:key', keyless: false, tools: true, tier: 0, minIntervalMs: 900, notes: ':free routes, ~50/day without credit.' },
  { id: 'mistral', label: 'Mistral', base: 'https://api.mistral.ai/v1', models: ['mistral-small-latest', 'open-mistral-nemo'], auth: 'bearer:key', keyless: false, tools: true, tier: 0, minIntervalMs: 1100, notes: 'Free experimentation tier key.' },
  { id: 'huggingface', label: 'HuggingFace router', base: 'https://router.huggingface.co/v1', models: ['meta-llama/Llama-3.3-70B-Instruct'], auth: 'bearer:key', keyless: false, tools: false, tier: 2, minIntervalMs: 1500, notes: 'Monthly free inference credits.' },
  { id: 'needle', label: 'Needle bridge (on-device)', base: 'http://127.0.0.1:8000', models: ['needle'], auth: 'none', keyless: true, tools: true, local: true, tier: 0, enabled: false, kind: 'needle', minIntervalMs: 0, notes: 'Cactus needle 26M — tool calls that never leave your phone/laptop.' },
  { id: 'ollama', label: 'Ollama (on-device)', base: 'http://127.0.0.1:11434/v1', models: ['llama3.2:1b', 'qwen2.5:1.5b', 'gemma3:1b'], auth: 'none', keyless: true, tools: true, local: true, tier: 2, enabled: false, minIntervalMs: 0, notes: 'Fully offline chat if you run Ollama locally.' },
];

export const buildCatalog = () => GATEWAY_CATALOG.map((g) => ({ ...g, models: [...g.models] }));

const HEALTH_DEFAULTS = () => ({
  ok: 0,
  fail: 0,
  streak: 0,
  lastError: null,
  lastOkAt: 0,
  latencyMs: 1400,
  cooldownUntil: 0,
  blocked: false,
});

export class GatewayPool {
  /**
   * @param {object} opts
   * @param {typeof fetch} [opts.fetchImpl] injected for tests
   * @param {() => number} [opts.clock]
   * @param {import('./core/store.js').Store} [opts.store] persistence for health + keys
   */
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), clock = () => Date.now(), store = null, catalog = null, timeoutMs = 12000, hedgeAfterMs = 5500, maxHops = 4 } = {}) {
    if (!fetchImpl) throw new Error('GatewayPool needs a fetch implementation');
    this.fetch = fetchImpl;
    this.clock = clock;
    this.store = store;
    this.catalog = catalog ?? buildCatalog();
    this.timeoutMs = timeoutMs;
    this.hedgeAfterMs = hedgeAfterMs;
    this.maxHops = maxHops;
    this.health = {};
    this.lastCallAt = {};
    this.privateMode = false;
    this.disabled = new Set();
    this.enabledOverrides = {};
    this.keys = {};
    this.puter = null; // set by attachPuter()
    this.stats = { requests: 0, errors: 0, tokens: 0, byGateway: {} };
    this.load();
  }

  /* ─────────── persistence ─────────── */
  load() {
    if (!this.store) return this;
    const saved = this.store.get('gateways', {}) || {};
    this.health = saved.health || {};
    this.keys = saved.keys || {};
    this.enabledOverrides = saved.enabled || {};
    for (const id of saved.disabled || []) this.disabled.add(id);
    for (const [id, patch] of Object.entries(this.enabledOverrides)) this.patchGateway(id, { enabled: patch });
    return this;
  }

  save() {
    if (!this.store) return this;
    this.store.set('gateways', {
      health: this.health,
      keys: this.keys,
      enabled: this.enabledOverrides,
      disabled: [...this.disabled],
    });
  }

  patchGateway(id, patch) {
    const gw = this.catalog.find((g) => g.id === id);
    if (gw) Object.assign(gw, patch);
    return gw;
  }

  setKey(id, key) {
    if (key) this.keys[id] = String(key).trim();
    else delete this.keys[id];
    this.save();
    return this.keys[id];
  }

  setEnabled(id, enabled) {
    this.enabledOverrides[id] = !!enabled;
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
    this.patchGateway(id, { enabled: !!enabled });
    this.save();
  }

  setPrivateMode(on) {
    this.privateMode = !!on;
    return this.privateMode;
  }

  setEndpoints({ needle, ollama }) {
    if (needle) this.patchGateway('needle', { base: needle.replace(/\/$/, ''), enabled: true });
    if (ollama) this.patchGateway('ollama', { base: `${ollama.replace(/\/$/, '')}/v1`, enabled: true });
    return this;
  }

  attachPuter(puter) {
    this.puter = puter || null;
    return this;
  }

  /* ─────────── health bookkeeping ─────────── */
  h(id) {
    if (!this.health[id]) this.health[id] = HEALTH_DEFAULTS();
    return this.health[id];
  }

  isCooling(id) {
    return this.h(id).cooldownUntil > this.clock();
  }

  markOk(id, latencyMs) {
    const h = this.h(id);
    h.ok += 1;
    h.streak = 0;
    h.lastOkAt = this.clock();
    h.latencyMs = h.latencyMs ? h.latencyMs * 0.6 + latencyMs * 0.4 : latencyMs;
    h.cooldownUntil = 0;
    h.lastError = null;
    h.blocked = false;
    this.save();
  }

  markFail(id, err, { cooldownMs = 0 } = {}) {
    const h = this.h(id);
    h.fail += 1;
    h.streak += 1;
    h.lastError = err?.message ? String(err.message).slice(0, 220) : 'unknown error';
    const networkish = /failed to fetch|networkerror|load failed|cors|aborted|typeerror/i.test(h.lastError);
    if (networkish) h.blocked = true;
    const backoff = cooldownMs || Math.min(15 * 60_000, 4000 * 2 ** Math.min(h.streak, 6));
    const cooldown = /429|rate|quota|too many/i.test(h.lastError) ? Math.max(backoff, 30_000) : backoff;
    h.cooldownUntil = this.clock() + (h.blocked ? Math.max(cooldown, 60_000) : cooldown);
    this.save();
    return h;
  }

  resetHealth() {
    this.health = {};
    this.save();
  }

  /* ─────────── candidate ordering ─────────── */
  modelFor(gw, i = 0) {
    return gw.models[Math.min(i, gw.models.length - 1)];
  }

  isUsable(gw) {
    if (this.disabled.has(gw.id)) return false;
    if (gw.enabled === false) return false;
    if (!gw.keyless && !this.keys[gw.id]) return false;
    if (gw.local && !gw.enabled) return false;
    return true;
  }

  /** Lower score = try sooner. */
  score(gw, now = this.clock()) {
    const h = this.h(gw.id);
    let s = gw.tier * 100;
    if (this.keys[gw.id] && !gw.local) s -= 60; // your own key wins
    if (this.isCooling(gw.id)) s += 1000 + clamp((h.cooldownUntil - now) / 1000, 0, 900);
    if (h.blocked) s += 400;
    s += h.streak * 25;
    s += clamp(h.latencyMs / 100, 0, 120);
    s -= Math.min(h.ok, 12) * 2;
    return s;
  }

  order({ includeDisabled = false } = {}) {
    return this.catalog
      .filter((gw) => (includeDisabled ? true : this.isUsable(gw)))
      .map((gw) => ({ gw, s: this.score(gw) }))
      .sort((a, b) => a.s - b.s)
      .map((x) => x.gw);
  }

  /** Full status snapshot for the Brains UI (and tests). */
  status() {
    const now = this.clock();
    return this.catalog.map((gw) => {
      const h = this.h(gw.id);
      return {
        id: gw.id,
        label: gw.label,
        keyless: gw.keyless,
        keyed: !!this.keys[gw.id],
        local: !!gw.local,
        usable: this.isUsable(gw),
        coolingFor: Math.max(0, Math.round((h.cooldownUntil - now) / 1000)),
        blocked: h.blocked,
        ok: h.ok,
        fail: h.fail,
        latencyMs: Math.round(h.latencyMs),
        lastError: h.lastError,
        notes: gw.notes,
        models: gw.models.slice(0, 2),
      };
    });
  }

  /* ─────────── the actual call ─────────── */
  headers(gw) {
    const h = { ...JSON_HEADERS };
    const auth = gw.auth || '';
    if (auth === 'bearer:key') h.authorization = `Bearer ${this.keys[gw.id] || ''}`;
    else if (auth === 'bearer:unused') h.authorization = `Bearer ${this.keys[gw.id] || 'unused'}`;
    return h;
  }

  async callGateway(gw, { messages, model, tools, temperature = 0.7, max_tokens = 380, onToken, signal, stream = true, timeoutMs } = {}) {
    if (gw.kind === 'needle') return this.callNeedle(gw, { messages, tools, signal, timeoutMs });
    const usedModel = model || this.modelFor(gw);
    const body = {
      model: usedModel,
      messages: gw.kind === 'needle' ? undefined : messages,
      temperature,
      max_tokens,
      stream: !!stream,
    };
    if (tools?.length && gw.tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (gw.kind === 'needle') delete body.model;

    const started = this.clock();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const res = await withTimeout(
      this.fetch(`${gw.base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(gw),
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      timeoutMs ?? this.timeoutMs,
      `${gw.id} request`,
    );

    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new Error(`${gw.id} HTTP ${status} ${detail}`);
    }

    let text = '';
    let toolCalls = [];
    if (stream && res.body?.getReader && onToken) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const chunk = safeJson(data, null);
          const delta = chunk?.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            onToken(delta.content);
          }
          if (delta?.tool_calls) toolCalls = mergeToolCallDeltas(toolCalls, delta.tool_calls);
        }
      }
    } else {
      const json = await res.json().catch(() => null);
      const msg = json?.choices?.[0]?.message ?? json?.choices?.[0]?.text ?? '';
      text = typeof msg === 'string' ? msg : msg?.content ?? '';
      toolCalls = normalizeToolCalls(msg?.tool_calls) ?? normalizeToolCalls(json?.choices?.[0]?.message?.tool_calls) ?? [];
      if (text && onToken) onToken(text);
    }

    const latency = this.clock() - started;
    const trimmed = text.trim();
    if (!trimmed && !toolCalls.length) throw new Error(`${gw.id} returned an empty completion`);
    return { text: trimmed, toolCalls, gateway: gw.id, model: usedModel, latencyMs: latency };
  }

  /** Cactus Needle (26M tool-calling model) served over its local HTTP engine. */
  async callNeedle(gw, { messages = [], tools = [], signal, timeoutMs } = {}) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const query = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
    const chatCall = () =>
      this.fetch(`${gw.base}/v1/chat/completions`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ messages, tools, model: 'needle' }),
        signal,
      });
    let res;
    try {
      res = await withTimeout(
        this.fetch(`${gw.base}/run`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ query, tools: tools.map((t) => t.function ?? t), stream: false }),
          signal,
        }),
        timeoutMs ?? 6000,
        'needle request',
      );
      // Older needle builds only expose the OpenAI-compatible chat endpoint.
      if (!res?.ok) res = await chatCall();
    } catch {
      res = await chatCall();
    }
    if (!res?.ok) throw new Error(`needle HTTP ${res?.status ?? 'no-response'}`);
    const json = await res.json().catch(() => null);
    const calls = normalizeToolCalls(json?.function_calls ?? json?.tool_calls ?? json?.choices?.[0]?.message?.tool_calls);
    return { text: json?.text ?? json?.reasoning ?? '', toolCalls: calls ?? [], gateway: 'needle', model: 'needle-26m', latencyMs: 0 };
  }

  /** Keyless speech-to-text (OVHcloud Whisper, OpenAI-compatible). */
  async transcribe(blob, { language, gatewayId = 'ovh' } = {}) {
    if (this.privateMode) throw new Error('private mode: transcription disabled');
    const gw = this.catalog.find((g) => g.id === gatewayId) || { id: 'ovh', base: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', auth: 'none' };
    // Normalise whatever the caller recorded (MediaRecorder Blob, File, or a
    // plain {size,type} stub used by tests) into something FormData accepts.
    const BlobCtor = globalThis.Blob;
    const file = blob instanceof BlobCtor ? blob : new BlobCtor([blob?.data ?? ''], { type: blob?.type || 'audio/webm' });
    const form = new FormData();
    form.append('file', file, 'speech.webm');
    form.append('model', 'whisper-large-v3');
    if (language) form.append('language', language);
    const started = this.clock();
    try {
      const res = await withTimeout(
        this.fetch(`${gw.base}/audio/transcriptions`, { method: 'POST', body: form }),
        25000,
        'transcribe',
      );
      if (!res.ok) throw new Error(`stt HTTP ${res.status}`);
      const json = await res.json();
      this.markOk('ovh', this.clock() - started);
      return { text: (json.text || '').trim(), gateway: 'ovh-whisper' };
    } catch (err) {
      this.markFail('ovh', err, { cooldownMs: 5000 });
      throw err;
    }
  }

  /** Keyless embeddings (OVHcloud BGE) with a deterministic local fallback. */
  async embed(texts, { fallback = true } = {}) {
    const list = Array.isArray(texts) ? texts : [texts];
    if (!this.privateMode) {
      try {
        const res = await withTimeout(
          this.fetch('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ model: 'bge-m3', input: list }),
          }),
          8000,
          'embed',
        );
        if (res.ok) {
          const json = await res.json();
          const vectors = (json.data || []).map((d) => d.embedding);
          if (vectors.length === list.length) return { vectors, gateway: 'ovh-bge-m3' };
        }
      } catch {
        /* silent fallback below */
      }
    }
    if (!fallback) throw new Error('embeddings unavailable');
    return { vectors: list.map((t) => hashEmbedding(t)), gateway: 'local-hash-256' };
  }

  /**
   * Chat with hedging + failover across every usable free gateway.
   * Returns the first *successful* completion; the loser of a hedge is aborted.
   */
  async chat(messages, opts = {}) {
    if (this.privateMode && !opts.allowNetwork) {
      throw new Error('private mode: network disabled');
    }
    this.stats.requests++;
    const candidates = (opts.only ? this.catalog.filter((g) => opts.only.includes(g.id)) : this.order()).slice(0, this.maxHops);
    if (!candidates.length) {
      const err = new Error('no gateways available');
      err.code = 'NO_GATEWAYS';
      throw err;
    }
    const errors = [];
    let hedgeTimer = null;
    let hedgeResolve;
    const hedged = new Promise((r) => {
      hedgeResolve = r;
    });

    const runOne = async (gw, index) => {
      const h = this.h(gw.id);
      const since = this.clock() - (this.lastCallAt[gw.id] || 0);
      if (gw.minIntervalMs && since < gw.minIntervalMs) {
        await new Promise((r) => setTimeout(r, gw.minIntervalMs - since));
      }
      // rotate model on repeat attempts with the same gateway
      const model = opts.model && index === 0 ? opts.model : this.modelFor(gw, index > 0 ? Math.min(index, gw.models.length - 1) : 0);
      this.lastCallAt[gw.id] = this.clock();
      const res = await this.callGateway(gw, { ...opts, model });
      this.markOk(gw.id, res.latencyMs);
      this.stats.byGateway[gw.id] = (this.stats.byGateway[gw.id] || 0) + 1;
      this.stats.tokens += Math.round((res.text || '').length / 4);
      return res;
    };

    const attempts = candidates.map((gw, i) => async () => {
      if (errors.length >= candidates.length) throw new Error('all gateways failed');
      return runOne(gw, i);
    });

    // Hedging: fire the first; if it hasn't answered within hedgeAfterMs, fire the next.
    const results = [];
    let settled = false;
    const launch = async (i) => {
      if (settled || i >= attempts.length) return;
      try {
        const res = await attempts[i]();
        if (!settled) {
          settled = true;
          clearTimeout(hedgeTimer);
          hedgeResolve(res);
        }
        results.push(res);
      } catch (err) {
        errors.push({ gateway: candidates[i]?.id, message: err.message, err });
        const cooldown = /HTTP 400|empty completion/i.test(err.message) ? 8000 : 0;
        if (candidates[i]) this.markFail(candidates[i].id, err, { cooldownMs: cooldown });
        if (!settled) {
          clearTimeout(hedgeTimer);
          if (i + 1 < attempts.length) {
            hedgeTimer = setTimeout(() => launch(i + 1), Math.min(this.hedgeAfterMs, 2500));
          } else {
            const agg = new Error(`every free gateway failed: ${errors.map((e) => `${e.gateway}: ${e.message}`).join(' | ')}`);
            agg.code = 'ALL_GATEWAYS_FAILED';
            agg.errors = errors;
            settled = true;
            hedgeResolve(Promise.reject(agg));
          }
        }
      }
    };
    hedgeTimer = setTimeout(() => launch(1), this.hedgeAfterMs);
    launch(0);
    const winner = await hedged;
    return Array.isArray(winner) || winner?.text != null ? winner : winner;
  }

  /** Probe each usable gateway with a tiny prompt; used by Settings + tests. */
  async probe({ onProgress = () => {}, limit = Infinity } = {}) {
    const list = this.order({ includeDisabled: true }).slice(0, limit);
    const out = [];
    for (const gw of list) {
      const t0 = this.clock();
      try {
        const res = await this.callGateway(gw, {
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
          max_tokens: 12,
          temperature: 0,
          stream: false,
          timeoutMs: gw.local ? 2500 : 9000,
        });
        const ms = this.clock() - t0;
        this.markOk(gw.id, ms);
        const item = { id: gw.id, ok: true, ms, sample: res.text.slice(0, 40) };
        out.push(item);
        onProgress(item);
      } catch (err) {
        this.markFail(gw.id, err, { cooldownMs: 0 });
        const item = { id: gw.id, ok: false, ms: this.clock() - t0, error: err.message.slice(0, 120) };
        out.push(item);
        onProgress(item);
      }
    }
    return out;
  }
}

/* ─────────── helpers ─────────── */

export function normalizeToolCalls(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .map((c, i) => {
      const fn = c?.function ?? c;
      const name = fn?.name;
      if (!name) return null;
      let args = fn?.arguments ?? fn?.parameters ?? {};
      if (typeof args === 'string') args = safeJson(args, {}) ?? {};
      return { id: c?.id || `call_${i}`, name, arguments: args };
    })
    .filter(Boolean);
}

export function mergeToolCallDeltas(acc, deltas) {
  const out = [...acc];
  for (const d of deltas) {
    const idx = d.index ?? out.length;
    if (!out[idx]) out[idx] = { id: d.id || `call_${idx}`, function: { name: '', arguments: '' } };
    const target = out[idx];
    if (d.id) target.id = d.id;
    if (d.function?.name) target.function.name += d.function.name;
    if (d.function?.arguments) target.function.arguments += d.function.arguments;
  }
  return out;
}

/** 256-dim deterministic hash embedding (offline fallback; good enough for habit/memory recall). */
export function hashEmbedding(text = '', dims = 256) {
  const vec = new Array(dims).fill(0);
  const tokens = String(text).toLowerCase().match(/[a-z0-9']+/g) || [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dims;
    vec[idx] += 1;
    vec[(idx * 7 + 13) % dims] += 0.5;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}

export const freeGatewayIds = () => GATEWAY_CATALOG.filter((g) => g.keyless).map((g) => g.id);
