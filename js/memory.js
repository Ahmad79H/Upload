/**
 * PIP'S HERO NOTEBOOK — long-term memory that never leaves the device.
 *
 * Storage: localStorage (via Store). Retrieval: cosine similarity over
 * keyless OVH/BGE embeddings when the network is available, with a
 * deterministic hash-embedding + lexical fallback so recall always works
 * offline. Nothing is ever uploaded except the embedding request itself.
 */
import { uid, tokenize, cosine, clamp } from './core/util.js';
import { hashEmbedding } from './gateways.js';

const NAME_RE = /\b(?:my name is|i am|i'm|call me)\s+([\w\u0600-\u06ff'.-]+(?:\s+[\w\u0600-\u06ff'.-]+)?)/i;
const CITY_RE = /\b(?:i live in|i am from|i'm from|my city is|based in)\s+([\w\u0600-\u06ff'.-]+(?:[ -][\w\u0600-\u06ff'.-]+){0,2})/i;
const LIKE_RE = /\bi (?:really )?(?:like|love|enjoy)\s+([\w\u0600-\u06ff' ,-]{3,60})/i;
const HATE_RE = /\bi (?:hate|dislike|can'?t stand)\s+([\w\u0600-\u06ff' ,-]{3,60})/i;
const WORK_RE = /\bi (?:work|study)\s+(?:at|in|as)\s+([\w\u0600-\u06ff' ,-]{3,60})/i;
const BIRTHDAY_RE = /\bmy birthday is\s+([\w ]{3,24})/i;
const FACT_STOP = new Set(['and', 'but', 'i', 'my', 'so', 'because', 'please', 'also', 'then', 'the', 'a', 'an']);

/** "Ahmad and i live in Taunsa" → "Ahmad"; keeps lists for likes ("mangoes and biryani" → both). */
export function cleanFact(raw = '', { maxWords = 2, keepList = false } = {}) {
  let text = String(raw).split(/[,.!?;]|\band\b|\bbut\b|\bbecause\b|\bi\b/)[0].trim();
  if (keepList) text = String(raw).split(/[.!?;]/)[0].trim();
  const words = text.split(/\s+/).filter((w) => w && !FACT_STOP.has(w.toLowerCase()));
  return words.slice(0, maxWords).join(' ').trim();
}

export class Memory {
  constructor({ store, pool = null, clock = () => Date.now(), maxEntries = 800 } = {}) {
    if (!store) throw new Error('Memory needs a Store');
    this.store = store;
    this.pool = pool;
    this.clock = clock;
    this.maxEntries = maxEntries;
    this.cache = this.store.get('memories', []);
  }

  get entries() {
    return this.cache;
  }

  persist() {
    const trimmed = this.cache.slice(-this.maxEntries);
    this.store.set('memories', trimmed);
    return trimmed.length;
  }

  /**
   * Save a memory. Near-duplicates get merged instead of piling up.
   * @returns {{id:string,text:string,tag:string,at:number,importance:number,merged?:boolean}}
   */
  remember(text, { tag = 'note', importance = 0.5, source = 'user', at = this.clock() } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const norm = clean.toLowerCase().replace(/\s+/g, ' ');
    const dupe = this.cache.find((m) => m.text.toLowerCase().replace(/\s+/g, ' ') === norm);
    if (dupe) {
      dupe.at = at;
      dupe.hits = (dupe.hits || 1) + 1;
      dupe.importance = clamp(Math.max(dupe.importance, importance) + 0.05, 0, 1);
      this.persist();
      return { ...dupe, merged: true };
    }
    const entry = { id: uid('mem'), text: clean, tag, importance: clamp(importance, 0, 1), at, source, hits: 1, vec: null };
    this.cache.push(entry);
    this.persist();
    this.extractProfile(clean);
    return entry;
  }

  /** Cheap on-device fact extraction → the profile shown in the Memory tab. */
  extractProfile(text) {
    const profile = this.store.get('profile', {});
    const set = (k, v) => {
      if (v && profile[k] !== v) profile[k] = v;
    };
    set('name', cleanFact(NAME_RE.exec(text)?.[1], { maxWords: 2 }));
    set('city', cleanFact(CITY_RE.exec(text)?.[1], { maxWords: 3 }));
    set('work', cleanFact(WORK_RE.exec(text)?.[1], { maxWords: 4 }));
    set('birthday', cleanFact(BIRTHDAY_RE.exec(text)?.[1], { maxWords: 3 }));
    const like = cleanFact(LIKE_RE.exec(text)?.[1], { maxWords: 4, keepList: true });
    if (like) profile.likes = [...new Set([...(profile.likes || []), like])].slice(-12);
    const hate = cleanFact(HATE_RE.exec(text)?.[1], { maxWords: 4, keepList: true });
    if (hate) profile.dislikes = [...new Set([...(profile.dislikes || []), hate])].slice(-12);
    profile.lastSeen = this.clock();
    this.store.set('profile', profile);
    return profile;
  }

  profile() {
    return this.store.get('profile', {});
  }

  all({ tag } = {}) {
    return tag ? this.cache.filter((m) => m.tag === tag) : [...this.cache];
  }

  forgetById(id) {
    const before = this.cache.length;
    this.cache = this.cache.filter((m) => m.id !== id);
    this.persist();
    return before - this.cache.length;
  }

  /** Fuzzy delete: "forget my old address" removes matching memories. */
  forget(query = '') {
    const q = tokenize(query);
    if (!q.length) return 0;
    const before = this.cache.length;
    this.cache = this.cache.filter((m) => {
      const toks = new Set(tokenize(m.text));
      const overlap = q.filter((t) => toks.has(t)).length / q.length;
      return overlap < 0.5;
    });
    this.persist();
    return before - this.cache.length;
  }

  clear() {
    this.cache = [];
    this.persist();
  }

  /** Lexical score (always available, offline). */
  lexicalScore(query, entry) {
    const q = tokenize(query);
    if (!q.length) return 0;
    const toks = new Set(tokenize(entry.text));
    const hits = q.filter((t) => toks.has(t)).length;
    const recency = clamp(1 - (this.clock() - entry.at) / (1000 * 60 * 60 * 24 * 60), 0.15, 1);
    return (hits / q.length) * 0.75 + entry.importance * 0.15 + recency * 0.1;
  }

  /**
   * Search memory. Uses free keyless embeddings when possible, lexical always.
   * @returns {Promise<Array<{text:string,score:number,tag:string,at:number}>>}
   */
  async search(query = '', { limit = 4, minScore = 0.12 } = {}) {
    if (!this.cache.length) return [];
    let scores = this.cache.map((m) => ({ entry: m, score: this.lexicalScore(query, m) }));
    if (this.pool && query.trim().split(/\s+/).length > 2) {
      try {
        const { vectors } = await this.pool.embed([query, ...this.cache.slice(-60).map((m) => m.text)]);
        if (vectors?.length === this.cache.slice(-60).length + 1) {
          const [qv, ...rest] = vectors;
          scores = this.cache.slice(-60).map((m, i) => ({
            entry: m,
            score: Math.max(cosine(qv, rest[i]) * 0.85, this.lexicalScore(query, m) * 0.6),
          }));
        }
      } catch {
        /* lexical only */
      }
    }
    return scores
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ text: s.entry.text, tag: s.entry.tag, at: s.entry.at, score: Number(s.score.toFixed(3)) }));
  }

  /** Compact block injected into the prompt (keeps tokens tiny for small models). */
  async contextBlock(query, { limit = 5 } = {}) {
    const hits = await this.search(query, { limit });
    const profile = this.profile();
    const lines = [];
    if (profile.name) lines.push(`user name: ${profile.name}`);
    if (profile.city) lines.push(`city: ${profile.city}`);
    if (profile.likes?.length) lines.push(`likes: ${profile.likes.slice(-4).join(', ')}`);
    if (profile.dislikes?.length) lines.push(`dislikes: ${profile.dislikes.slice(-3).join(', ')}`);
    for (const h of hits) lines.push(`(${h.tag}) ${h.text}`);
    return lines.join('\n');
  }
}

export const _internals = { hashEmbedding, NAME_RE, CITY_RE };
