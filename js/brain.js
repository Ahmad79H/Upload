/**
 * PIP'S BRAIN — decides, for every sentence you say, which of these happens:
 *
 *   A. it is clearly a gadget request ("weather in Lahore", "remind me in 20 min")
 *      → the LOCAL router (nlu.js, the needle-lite stand-in) fires the tool
 *        immediately: fast, offline, zero gateway quota burned.
 *   B. it is a question or chat → a free gateway answers in Pip's voice, with
 *      his notebook, habits and any relevant gadget results in the prompt.
 *   C. a gateway *can* call tools natively → Pip forwards the schemas, executes
 *      what comes back, then asks the model to phrase the result nicely.
 *   D. everything is down (offline / rate-limited / private mode) → Pip still
 *      answers from `personality.localReply()`. He is never silent, never shows
 *      a stack trace, and never says "error".
 *
 * The Brain never throws — it always resolves to something speakable.
 */
import { routeUtterance, toolsForPrompt, parseToolCallFromText, contentToText } from './nlu.js';
import { systemPrompt, decorate, moodFromText, localReply, PACKS, normalizeDials, safetyScrub } from './personality.js';
import { tokenize } from './core/util.js';

export class Brain {
  constructor({ pool, toolkit, memory, habits, perception = null, speech = null, bus = null, store = null, clock = () => Date.now(), getSettings = () => ({}) } = {}) {
    this.pool = pool;
    this.toolkit = toolkit;
    this.memory = memory;
    this.habits = habits;
    this.perception = perception;
    this.speech = speech;
    this.bus = bus;
    this.store = store;
    this.clock = clock;
    this.getSettings = getSettings;
    this.turns = 0;
    this.lastGateway = null;
    this.maxRounds = 2;
  }

  settings() {
    return {
      userName: '',
      pack: 'deku',
      dials: null,
      privateMode: false,
      speak: true,
      ...this.getSettings(),
    };
  }

  pack() {
    return PACKS[this.settings().pack] || PACKS.deku;
  }

  dials() {
    return normalizeDials(this.settings().dials || this.pack().dials);
  }

  /**
   * One full turn.
   * @returns {Promise<{reply:string, mood:string, gateway:string|null, toolResults:Array, offline:boolean, reasoning?:string}>}
   */
  async respond(userText, { onToken = null, onStatus = null, history = [] } = {}) {
    const text = contentToText(userText).trim();
    this.turns++;
    const settings = this.settings();
    const pack = this.pack();
    const dials = this.dials();
    const emit = (status, extra = {}) => {
      onStatus?.({ status, ...extra });
      this.bus?.emit('brain:status', { status, ...extra });
    };

    if (!text) {
      const reply = 'I am listening! Say anything.';
      return { reply, mood: 'curious', gateway: null, toolResults: [], offline: true };
    }

    // ── remember what the user said (cheap, local, always on) ──
    this.memory?.observe?.('message');
    this.habits?.observe('message', { chars: text.length });
    this.learnTopics(text, settings);
    if (this.looksLikePersonalFact(text)) this.memory?.remember(text, { tag: 'fact', importance: 0.6, source: 'user' });

    // ── A: local gadget routing (needle-lite) ──
    // In private mode only offline gadgets are allowed — nothing may leave the phone.
    const availableTools = settings.privateMode
      ? this.toolkit.list().filter((t) => !(t.needs || []).includes('network'))
      : this.toolkit.list();
    const route = routeUtterance(text, availableTools, { now: this.clock() });
    let toolResults = [];
    if (route.calls.length && route.confident) {
      emit('using-gadgets', { tools: route.calls.map((c) => c.name) });
      toolResults = await this.toolkit.runCalls(route.calls);
      for (const r of toolResults) this.habits?.observe('tool', { name: r.name, ok: r.result?.ok !== false });
    }

    // A gadget whose output *is* the answer (clock, weather, dice…) does not need
    // a model round-trip: faster, free and works offline.
    const solo = toolResults[0];
    const soloToolAnswer =
      toolResults.length === 1 &&
      solo?.result?.ok !== false &&
      typeof solo.result?.speak === 'string' &&
      (this.toolkit.spec(solo.name)?.definitive === true || (!route.question && text.split(/\s+/).length <= 9));

    // ── D: private mode or zero network → fully local answer ──
    if (settings.privateMode) {
      const replyBase = toolResults.map((r) => r.result?.speak).filter(Boolean).join(' ') || localReply(text, { pack, userName: settings.userName, profile: this.memory?.profile() }).text;
      return this.finish(replyBase, { pack, dials, toolResults, gateway: 'local', offline: true, onToken, onStatus: emit });
    }

    // ── B/C: ask a free gateway ──
    if (!soloToolAnswer) {
      try {
        emit('thinking', { gateway: this.pool?.order?.()[0]?.id });
        const answer = await this.askGateway({ text, history, toolResults, settings, pack, dials, onToken, emit });
        if (answer?.reply) {
          return this.finish(answer.reply, { pack, dials, toolResults: [...toolResults, ...(answer.extraTools || [])], gateway: answer.gateway, offline: false, onToken, onStatus: emit });
        }
      } catch (err) {
        this.bus?.emit('brain:gateway-failed', { error: err?.message, code: err?.code });
        emit('offline-brain', { error: err?.message });
      }
    }

    // ── tool-only or offline fallback ──
    const spokenTools = toolResults.map((r) => r.result?.speak).filter(Boolean).join(' ');
    if (spokenTools) {
      return this.finish(spokenTools, { pack, dials, toolResults, gateway: this.lastGateway, offline: false, onToken, onStatus: emit });
    }
    const local = localReply(text, { pack, userName: settings.userName, profile: this.memory?.profile(), dials });
    return { reply: safetyScrub(local.text), mood: local.mood, gateway: null, toolResults, offline: true, reasoning: 'local' };
  }

  async askGateway({ text, history, toolResults, settings, pack, dials, onToken, emit }) {
    const profile = { ...(this.memory?.profile() || {}), ...(this.habits?.profile() || {}) };
    const memoryBlock = (await this.memory?.contextBlock?.(text, { limit: 4 })) || '';
    const toolBlock = toolResults.length
      ? toolResults.map((r) => `gadget ${r.name}(${JSON.stringify(r.arguments)}) → ${r.result?.ok === false ? `failed: ${r.result.error}` : JSON.stringify(r.result?.data ?? r.result?.speak ?? '').slice(0, 400)}`).join('\n')
      : '';
    const sys = systemPrompt({
      pack,
      userName: settings.userName,
      profile,
      gateway: this.pool?.order?.()[0]?.label,
      tools: this.toolkit.list(),
      extra: [
        memoryBlock ? `Notebook memories:\n${memoryBlock}` : '',
        toolBlock ? `Gadget results (use these exact facts, do not invent):\n${toolBlock}` : '',
        toolResults.length ? 'Phrase the gadget result naturally and warmly in 1-2 short sentences.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const messages = [{ role: 'system', content: sys }];
    for (const turn of history.slice(-6)) {
      if (!turn?.role || !turn?.content) continue;
      messages.push({ role: turn.role === 'pip' ? 'assistant' : turn.role, content: String(turn.content).slice(0, 900) });
    }
    messages.push({ role: 'user', content: text });

    const nativeTools = this.pool?.order?.()[0]?.tools ? toolsForPrompt(this.toolkit.list(), { max: 12 }) : [];
    let res = await this.pool.chat(messages, {
      tools: nativeTools,
      max_tokens: dials.chatty > 60 ? 420 : 260,
      temperature: dials.energy > 85 ? 0.85 : 0.68,
      onToken: onToken ? (t) => onToken(t) : undefined,
    });
    this.lastGateway = res.gateway;

    // C: the gateway called a gadget natively → run it, then let the model narrate.
    let calls = res.toolCalls?.length ? res.toolCalls : parseToolCallFromText(res.text, this.toolkit.names());
    const extraTools = [];
    for (let round = 0; round < this.maxRounds && calls?.length; round++) {
      const normalized = Array.isArray(calls) ? calls : [calls];
      const results = await this.toolkit.runCalls(normalized);
      for (const r of results) this.habits?.observe('tool', { name: r.name, ok: r.result?.ok !== false });
      extraTools.push(...results);
      const summary = results
        .map((r) => `${r.name} → ${r.result?.ok === false ? `failed (${r.result.error})` : JSON.stringify(r.result?.data ?? r.result?.speak ?? '').slice(0, 300)}`)
        .join('\n');
      const followUp = [
        ...messages,
        { role: 'assistant', content: res.text || '(used a gadget)' },
        { role: 'user', content: `Gadget results:\n${summary}\nNow answer me in 1-2 short sentences, in character.` },
      ];
      res = await this.pool.chat(followUp, { max_tokens: 220, temperature: 0.6, onToken: onToken ? (t) => onToken(t) : undefined });
      this.lastGateway = res.gateway;
      calls = res.toolCalls?.length ? res.toolCalls : null;
    }

    if (!res.text && extraTools.length) {
      return { reply: extraTools.map((r) => r.result?.speak).filter(Boolean).join(' ') || 'Done!', gateway: res.gateway, extraTools };
    }
    if (!res.text) throw new Error('empty model answer');
    return { reply: res.text, gateway: res.gateway, extraTools };
  }

  /** Wrap the final text in Pip's voice + pick a face. */
  finish(rawText, { pack, dials, toolResults, gateway, offline, onToken, onStatus }) {
    const decorated = decorate(rawText, { pack, dials });
    const mood = moodFromText(decorated);
    const result = {
      reply: decorated,
      mood,
      gateway: gateway || null,
      toolResults,
      offline: !!offline,
      reasoning: toolResults.length ? 'used-gadgets' : offline ? 'local' : 'gateway',
    };
    this.bus?.emit('brain:reply', { ...result, tools: toolResults.map((t) => t.name) });
    return result;
  }

  /* ─────────── tiny local learning helpers ─────────── */

  looksLikePersonalFact(text = '') {
    return /\b(my name is|i am from|i live in|i like|i love|i hate|my birthday|i work|my favourite|my favorite|i study)\b/i.test(text);
  }

  learnTopics(text = '', settings = {}) {
    const TOPICS = {
      weather: ['weather', 'rain', 'temperature', 'forecast', 'hot', 'cold'],
      study: ['study', 'exam', 'homework', 'assignment', 'school', 'college', 'university'],
      health: ['gym', 'workout', 'run', 'sleep', 'tired', 'doctor', 'medicine', 'water'],
      tech: ['code', 'programming', 'bug', 'app', 'computer', 'phone', 'ai', 'robot'],
      anime: ['anime', 'manga', 'deku', 'hero', 'naruto', 'one piece', 'jujutsu'],
      feelings: ['sad', 'happy', 'stressed', 'anxious', 'lonely', 'excited'],
      money: ['money', 'budget', 'salary', 'expensive', 'save', 'spend'],
      food: ['food', 'eat', 'hungry', 'recipe', 'cook', 'chai', 'tea'],
    };
    const tokens = new Set(tokenize(text));
    for (const [topic, words] of Object.entries(TOPICS)) {
      if (words.some((w) => tokens.has(w))) this.habits?.observe('topic', { topic });
    }
  }
}
