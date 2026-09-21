/**
 * NEEDLE-LITE — Pip's own tiny function-calling model.
 *
 * Real on-device function calling (Cactus "Needle", 26M params) is a great fit
 * for a phone puppet, so Pip speaks to a local Needle bridge when you run one
 * (see js/gateways.js → id "needle"). But a puppet that only works when a
 * Python server is running is a sad puppet — so this module is a distilled,
 * dependency-free stand-in: a scoring + slot-filling router that turns
 * "remind me to stretch in 20 minutes" into
 *   { name: "set_reminder", arguments: { text: "stretch", at: "..." } }
 * in well under a millisecond, offline, deterministically and testably.
 *
 * Everything here is pure: no DOM, no network, no globals → fully unit tested.
 */
import { parseWhen, tokenize, clamp } from './core/util.js';

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'my', 'me', 'i', 'you', 'is', 'are', 'am', 'and', 'please', 'can', 'could', 'would', 'will', 'do', 'does', 'what', 'whats', 'what\'s', 'how', 'in', 'on', 'at', 'it', 'that', 'this', 'be', 'with', 'about', 'tell', 'give', 'get', 'show', 'weather', 'today']);

/** Words that signal the user wants a real answer from a model, not a tool. */
const QUESTION_RE = /^(who|what|why|how|when|where|which|can you|could you|do you|does|is|are|will|should|explain|describe|tell me about|what's|whats|define)\b/i;

/** Imperative cues used to detect a tool intent even without an exact keyword. */
const COMMAND_RE = /^(set|start|add|make|remind|note|remember|forget|translate|calculate|compute|search|look up|google|wiki|define|play|dance|sleep|wake|scan|check|flip|roll|call|ask)\b/i;

export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join(' ')
      .trim();
  }
  return content == null ? '' : String(content);
}

/* ───────────── slot extractors ───────────── */

const CITY_STOP = ['today', 'tomorrow', 'now', 'please', 'right', 'here', 'outside', 'outside?'];

export function extractCity(text = '') {
  const patterns = [
    /\bweather\s+(?:in|at|for)\s+([a-z\u0600-\u06ff' .-]{2,40})/i,
    /\bin\s+([a-z\u0600-\u06ff' .-]{2,40})\s*(?:\?|$)/i,
    /\b(?:forecast|temperature|how hot|how cold)\s+(?:in|at|for)?\s*([a-z\u0600-\u06ff' .-]{2,40})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    let city = m[1].trim().replace(/[?.!,]+$/, '');
    city = city.split(/\s+(?:tomorrow|today|tonight|right now|now)\b/i)[0].trim();
    if (city && !CITY_STOP.includes(city.toLowerCase()) && city.length > 1) return titleCase(city);
  }
  return null;
}

export const titleCase = (s = '') => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function extractMathExpression(text = '') {
  const cleaned = text
    .toLowerCase()
    .replace(/what(?:'s| is)|calculate|compute|how much is|equals?|please|the answer to|\?/g, ' ')
    .replace(/(?:percent|%)\s*of/g, ' * 0.01 * ')
    .replace(/\bx\b|times|multiplied by/g, '*')
    .replace(/divided by|over/g, '/')
    .replace(/plus/g, '+')
    .replace(/minus|less/g, '-')
    .replace(/[^0-9+\-*/^%().\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[0-9]/.test(cleaned) && /[+\-*/^%]/.test(cleaned) ? cleaned : null;
}

export function extractDuration(text = '', base = Date.now()) {
  const when = parseWhen(text, base);
  if (!when) return null;
  return { at: when.getTime(), label: when.toLocaleString([], { hour: '2-digit', minute: '2-digit', weekday: 'short' }) };
}

export function extractQuoted(text = '') {
  const m = /["“'']([^"”'']{2,200})["”'']/.exec(text);
  return m ? m[1].trim() : null;
}

/** Strip the command words so we keep the payload: "remind me to drink water" → "drink water" */
export function extractPayload(text = '') {
  const quoted = extractQuoted(text);
  if (quoted) return quoted;
  const stripped = text
    .replace(/^(?:hey\s+)?(?:pip|puppet|deku)[, ]*/i, '')
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?/i, '')
    .replace(/^(?:set|start|add|make|create|put)?\s*(?:a|an|the)?\s*(?:timer|reminder|alarm|note|memo)\s*(?:for|to|about|that)?\s*/i, '')
    .replace(/^(?:remind me|remember|note down|note|jot down|write down)\s*(?:to|that|about)?\s*/i, '')
    .replace(/^(?:search for|search|look up|google|find out|find me|find)\s+/i, '')
    .replace(/\s+(?:in|at|tomorrow|tonight|today)\s+[\w:.\s]+$/i, '')
    .replace(/[.?!]+$/, '')
    .trim();
  return stripped || text.trim();
}

/** "who is Deku" / "tell me about Deku" → "Deku" (used for wiki lookups). */
export function extractTopic(text = '') {
  const stripped = text
    .replace(/^(?:hey\s+)?(?:pip|puppet)[, ]*/i, '')
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?/i, '')
    .replace(/^(?:who|what|which|when|where)\s+(?:is|was|are|were)\s+/i, '')
    .replace(/^(?:tell me (?:about|more about)|explain|describe|search for|look up|google|wiki(?:pedia)?)\s+/i, '')
    .replace(/[.?!]+$/, '')
    .trim();
  return stripped || text.trim();
}

export function extractTarget(text = '') {
  const m = /\b(?:translate|say)\s+(.+?)\s+(?:in|into|to)\s+([a-z\u0600-\u06ff ]{3,24})/i.exec(text);
  if (m) return { text: m[1].replace(/^["'“]|["'”]$/g, '').trim(), to: m[2].trim() };
  const m2 = /\b(?:define|meaning of|what does)\s+([a-z-]{2,30})\b/i.exec(text);
  if (m2) return { word: m2[1] };
  return null;
}

export function keywordsOf(text = '') {
  return tokenize(text).filter((t) => !STOP.has(t) && t.length > 1);
}

/* ───────────── the router ───────────── */

/**
 * @param {string} text user utterance
 * @param {Array} tools tool specs: { name, description, parameters, patterns?, keywords?, slots?, minScore? }
 * @param {{ now?: number, maxCalls?: number, threshold?: number }} [opts]
 * @returns {{ calls: Array<{name:string,arguments:object,confidence:number,evidence:string[]}>, question: boolean, confident: boolean, text: string }}
 */
export function routeUtterance(text, tools = [], { now = Date.now(), maxCalls = 3, threshold = 0.34 } = {}) {
  const clean = contentToText(text).trim();
  if (!clean) return { calls: [], question: false, confident: false, text: '' };
  const lower = clean.toLowerCase();
  const tokens = new Set(keywordsOf(clean));
  const scored = [];

  for (const tool of tools) {
    let score = 0;
    const evidence = [];
    for (const re of tool.patterns || []) {
      if (re.test(clean)) {
        score += 0.55;
        evidence.push(`pattern:${re.source.slice(0, 28)}`);
        break;
      }
    }
    for (const kw of tool.keywords || []) {
      if (lower.includes(kw)) {
        score += kw.includes(' ') ? 0.4 : 0.28;
        evidence.push(`kw:${kw}`);
      }
    }
    if (tool.description) {
      const descTokens = keywordsOf(tool.description);
      let overlap = 0;
      for (const t of descTokens) if (tokens.has(t)) overlap++;
      if (overlap) {
        score += clamp(overlap / Math.max(6, descTokens.length), 0, 0.3);
        evidence.push(`desc-overlap:${overlap}`);
      }
    }
    if (!score) continue;
    if (COMMAND_RE.test(clean) || tool.patterns?.some((r) => r.test(clean))) score += 0.05;
    if (score >= (tool.minScore ?? threshold)) scored.push({ tool, score: clamp(score, 0, 1), evidence });
  }

  scored.sort((a, b) => b.score - a.score);
  const calls = [];
  for (const { tool, score, evidence } of scored.slice(0, maxCalls)) {
    const args = fillSlots(tool, clean, { now, evidence });
    if (!args) continue;
    calls.push({ name: tool.name, arguments: args, confidence: Number(score.toFixed(3)), evidence });
  }

  const question = QUESTION_RE.test(clean) || /\?\s*$/.test(clean);
  return {
    calls,
    question,
    confident: calls.length > 0 && calls[0].confidence >= threshold,
    text: clean,
  };
}

/** Fill the tool's argument schema from the utterance using generic + custom extractors. */
export function fillSlots(tool, text, { now = Date.now(), evidence = [] } = {}) {
  const props = tool.parameters?.properties || {};
  const required = tool.parameters?.required || [];
  const args = {};
  const custom = typeof tool.slots === 'function' ? tool.slots(text, { now, evidence }) || {} : {};

  for (const key of Object.keys(props)) {
    if (custom[key] !== undefined && custom[key] !== null) {
      args[key] = custom[key];
      continue;
    }
    const type = props[key].type;
    if (key === 'at' || key === 'when' || key === 'time') {
      const d = extractDuration(text, now);
      if (d) args[key] = d.at;
      else if (!required.includes(key)) continue;
    } else if (key === 'minutes' || key === 'duration') {
      const m = /(\d+(?:\.\d+)?|a|one|two|five|ten|fifteen|twenty|thirty|half an?|an?)\s*(minutes?|mins?|hours?|hrs?)/i.exec(text);
      if (m) {
        const amount = /half/i.test(m[1]) ? 0.5 : { a: 1, an: 1, one: 1, two: 2, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 }[m[1].toLowerCase()] ?? parseFloat(m[1]);
        args[key] = /h/i.test(m[2]) ? Math.round(amount * 60) : amount;
      } else if (required.includes(key)) args[key] = 5;
      else continue;
    } else if (key === 'location' || key === 'city') {
      const city = extractCity(text);
      if (city) args[key] = city;
      else if (!required.includes(key)) continue;
      else args[key] = null;
    } else if (key === 'expression') {
      const expr = extractMathExpression(text);
      if (expr) args[key] = expr;
      else if (!required.includes(key)) continue;
    } else if (key === 'topic') {
      args[key] = extractTopic(text);
    } else if (key === 'tag') {
      args[key] = 'note';
    } else if (key === 'side' || key === 'sides') {
      const m = /\bd\s*(\d{1,4})\b|(\d{1,4})\s*(?:-| )?(?:sided|sides)/i.exec(text);
      args[key] = m ? Number(m[1] || m[2]) : Number(props[key].default ?? 6);
    } else if (key === 'count') {
      const m = /\b(\d{1,2}|one|two|three|four|five|six|ten)\s*(?:x\s*)?(?:dice|dices|die|rolls?)\b/i.exec(text);
      const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };
      args[key] = m ? words[m[1].toLowerCase()] ?? Number(m[1]) : 1;
    } else if (key === 'query' || key === 'text' || key === 'note' || key === 'label' || key === 'message') {
      const target = extractTarget(text);
      const raw = key === 'query' && target?.word ? target.word : key === 'text' && target?.text ? target.text : null;
      args[key] = raw ?? extractPayload(text);
    } else if (key === 'to' || key === 'language') {
      const target = extractTarget(text);
      args[key] = target?.to ?? 'English';
    } else if (key === 'word') {
      args[key] = extractTarget(text)?.word ?? extractPayload(text).split(/\s+/)[0];
    } else if (type === 'number') {
      const m = /-?\d+(?:\.\d+)?/.exec(text);
      args[key] = m ? Number(m[0]) : 1;
    } else if (type === 'boolean') {
      args[key] = !/\bno\b|\bdon'?t\b|\bnot\b/.test(text);
    } else {
      args[key] = extractPayload(text);
    }
  }
  return args;
}

/** Needle-style tool list for prompts (kept tiny — small models choke on big schemas). */
export function toolsForPrompt(tools = [], { max = 12 } = {}) {
  return tools.slice(0, max).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Parse the model's own tool-call JSON when a gateway does not do it for us. */
export function parseToolCallFromText(text = '', toolNames = []) {
  const m = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(text) || /```json\s*([\s\S]*?)```/i.exec(text);
  if (!m) return null;
  try {
    const json = JSON.parse(m[1]);
    const name = json.name || json.tool || json.function;
    if (!toolNames.includes(name)) return null;
    return { name, arguments: json.arguments || json.parameters || json.args || {} };
  } catch {
    return null;
  }
}
