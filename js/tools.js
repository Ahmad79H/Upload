/**
 * PIP'S TOOLBOX — every tool is client-side, keyless and free.
 * Nothing here needs an API key: weather, search, wiki, dictionary, translate,
 * timers, notes, memory, habits and puppet controls all use free public
 * endpoints or pure local code. Tools never throw: they return
 *   { ok, speak, data?, error? }
 * so the puppet can always answer sweetly even when the internet is rude.
 */
import { parseWhen, humanDay, humanTime, humanDuration, pick } from './core/util.js';

/* ═════════════ safe calculator (no eval, ever) ═════════════ */
export function calc(expr = '') {
  // "12% of 480" → "12*0.01*480"; a bare "%" becomes "*0.01" (50% → 0.5).
  const normalized = String(expr)
    .replace(/percent(?:age)?\s+of/gi, '% of')
    .replace(/%\s*of/gi, '*0.01*')
    .replace(/%/g, '*0.01')
    .replace(/\bof\b/gi, '*');
  const unsupported = normalized.replace(/[0-9+\-*/^().\s]/g, ' ').split(/\s+/).filter((w) => w && !/^(of|percent|plus|minus|times|over)$/i.test(w));
  if (unsupported.length) throw new Error(`I do not know the word "${unsupported[0]}" — keep it to numbers and + - * / ^ ( )`);
  const tokens = normalized.match(/\d+(?:\.\d+)?|[+\-*/^()]/g);
  if (!tokens) throw new Error('nothing to calculate');
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function primary() {
    const t = next();
    if (t === '(') {
      const v = sum();
      if (next() !== ')') throw new Error('unbalanced parentheses');
      return v;
    }
    if (t === '-') return -primary();
    if (t && /^\d/.test(t)) return parseFloat(t);
    throw new Error(`unexpected "${t}"`);
  }
  function power() {
    let base = primary();
    while (peek() === '^') {
      next();
      base = base ** power();
    }
    return base;
  }
  function product() {
    let v = power();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const rhs = power();
      if (op === '*') v *= rhs;
      else v = rhs === 0 ? Nan0() : v / rhs;
    }
    return v;
  }
  function sum() {
    let v = product();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = product();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }
  const value = sum();
  if (i < tokens.length) throw new Error('could not parse the whole expression');
  if (!Number.isFinite(value)) throw new Error('result is not a finite number');
  return Math.round(value * 1e10) / 1e10;
}
const Nan0 = () => {
  throw new Error('division by zero');
};

/* ═════════════ local fun data ═════════════ */
const FACTS = [
  'Octopuses have three hearts, and two of them stop beating when they swim.',
  'Honey never spoils — edible 3,000-year-old jars were found in Egyptian tombs.',
  'A day on Venus is longer than a year on Venus.',
  'Bananas are berries, but strawberries are not.',
  'Wombat poop is cube-shaped. Nobody is sure why it bothers.',
  'The Eiffel Tower grows about 15 cm taller in summer.',
  'Sharks existed before trees did.',
  'Your body makes about two million red blood cells every second.',
  'There are more possible chess games than atoms in the observable universe.',
  'A single strand of spider silk could theoretically stop a plane — if it were thick enough.',
];
const JOKES = [
  'Why did the scarecrow win an award? Because he was outstanding in his field!',
  'I told my computer I needed a break… now it won\'t stop sending me KitKat ads.',
  'Why don\'t scientists trust atoms? They make up everything!',
  'I would tell you a hero joke, but you would have to Smash to hear the punchline.',
  'Why did the student eat his homework? The teacher said it was a piece of cake.',
  'My hero name is "Buffering". I\'ll save you in a moment…',
];
const CHEERS = ['You have got this — one jump at a time!', 'Even when it is hard, you keep going. That is the whole quirk!', 'Small steps still count as Plus Ultra!', 'I believe in you. I always will.'];

/* ═════════════ websafe fetch helper ═════════════ */
async function tryFetch(fetchImpl, url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchImpl(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ═════════════════════════ TOOLS ═════════════════════════ */
/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} description
 * @property {object} parameters JSON-schema style
 * @property {RegExp[]} patterns
 * @property {string[]} keywords
 * @property {string[]} [needs] 'network' | 'geo' | 'puppet' | 'store'
 * @property {(args:object, ctx:object) => Promise<{ok:boolean,speak:string,data?:any,error?:string}>} run
 */

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'get_time',
    definitive: true,
    description: 'Tell the current local time.',
    parameters: { type: 'object', properties: {} },
    patterns: [/^\s*(what(?:'s| is)? the time|what time is it|time now|time please)\b/i],
    keywords: ['what time', 'current time', 'time is it'],
    async run() {
      const now = new Date();
      return { ok: true, speak: `It is ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} right now, partner.`, data: { iso: now.toISOString() } };
    },
  },
  {
    name: 'get_date',
    definitive: true,
    description: 'Tell today\'s date and day of the week.',
    parameters: { type: 'object', properties: {} },
    patterns: [/^\s*(what(?:'s| is)? (?:the )?date|what day is it|today'?s date)\b/i],
    keywords: ['what date', 'what day', 'date today'],
    async run() {
      const now = new Date();
      return {
        ok: true,
        speak: `Today is ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}, ${now.getFullYear()}.`,
        data: { iso: now.toISOString() },
      };
    },
  },
  {
    name: 'get_weather',
    definitive: true,
    description: 'Get the current weather and today\'s forecast for a city.',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string', description: 'city name, e.g. "Taunsa" or "Lahore"' } },
      required: ['location'],
    },
    patterns: [/\b(weather|forecast|temperature|how hot|how cold|rain (?:today|tomorrow))\b/i],
    keywords: ['weather', 'forecast', 'temperature', 'raining', 'how hot', 'how cold'],
    needs: ['network'],
    async run({ location }, ctx) {
      const geo = ctx.geo || {};
      let place = location;
      if (!place && geo.lat && geo.lon) {
        const r = await tryFetch(ctx.fetch, `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`);
        const j = await r.json();
        return formatWeather(j, geo.city || 'your area', ctx);
      }
      if (!place) return { ok: false, speak: 'Tell me the city and I will go fetch it!', error: 'no location' };
      const g = await tryFetch(ctx.fetch, `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
      const gj = await g.json();
      const hit = gj?.results?.[0];
      if (!hit) return { ok: false, speak: `I could not find ${place} on my map. Try another spelling?`, error: 'no geocode' };
      const w = await tryFetch(
        ctx.fetch,
        `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`,
      );
      return formatWeather(await w.json(), `${hit.name}${hit.country ? `, ${hit.country}` : ''}`, ctx);
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for a quick answer or the latest info.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'what to search for' } }, required: ['query'] },
    patterns: [/\b(search|google|look up|find out|latest news about)\b/i],
    keywords: ['search', 'google', 'look up', 'find', 'latest'],
    needs: ['network'],
    async run({ query }, ctx) {
      if (!query) return { ok: false, speak: 'What should I search for?', error: 'empty query' };
      // 1) DuckDuckGo instant answers (keyless, CORS-friendly)
      try {
        const r = await tryFetch(ctx.fetch, `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=puppet`);
        const j = await r.json();
        const snippet = j.AbstractText || j.Answer || j.Definition;
        if (snippet) {
          const source = j.AbstractURL ? ` Source: ${j.AbstractURL}` : '';
          return { ok: true, speak: `${snippet}${source}`, data: { source: j.AbstractURL, query } };
        }
        const related = (j.RelatedTopics || []).map((t) => t.Text).filter(Boolean).slice(0, 3);
        if (related.length) return { ok: true, speak: `Here is what I found: ${related.join(' • ')}`, data: { query, related } };
      } catch {
        /* fall through to Wikipedia */
      }
      // 2) Wikipedia search fallback
      try {
        const r = await tryFetch(ctx.fetch, `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=1`);
        const j = await r.json();
        const page = j?.pages?.[0];
        if (page) {
          const sum = await tryFetch(ctx.fetch, `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`);
          const s = await sum.json();
          return { ok: true, speak: `${s.extract}`, data: { source: s.content_urls?.desktop?.page, query } };
        }
      } catch {
        /* ignore */
      }
      return { ok: false, speak: 'My search wings got tangled — the free search service is not answering. Want me to try again in a moment?', error: 'search failed' };
    },
  },
  {
    name: 'wikipedia',
    description: 'Look up a topic on Wikipedia and summarise it.',
    parameters: { type: 'object', properties: { topic: { type: 'string', description: 'topic or person' } }, required: ['topic'] },
    patterns: [/\b(who|what)\s+(?:is|was|are)\b.*\bwiki/i, /\btell me about\b/i, /\bwikipedia\b/i],
    keywords: ['who is', 'who was', 'tell me about', 'wikipedia'],
    needs: ['network'],
    async run({ topic }, ctx) {
      const q = topic || 'random';
      const r = await tryFetch(ctx.fetch, `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q.trim().replace(/\s+/g, '_'))}`);
      const j = await r.json();
      if (!j?.extract) return { ok: false, speak: `Hmm, I could not find a page for "${q}". Try a shorter name?`, error: 'no page' };
      return { ok: true, speak: `${j.extract}`, data: { url: j.content_urls?.desktop?.page, title: j.title } };
    },
  },
  {
    name: 'define',
    definitive: true,
    description: 'Look up the dictionary definition of a word.',
    parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
    patterns: [/\b(define|definition of|meaning of|what does .* mean)\b/i],
    keywords: ['define', 'definition', 'meaning of', 'what does'],
    needs: ['network'],
    async run({ word }, ctx) {
      const w = (word || '').trim().split(/\s+/)[0];
      if (!w) return { ok: false, speak: 'Which word should I look up?', error: 'no word' };
      const r = await tryFetch(ctx.fetch, `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
      const j = await r.json();
      const entry = Array.isArray(j) ? j[0] : null;
      const def = entry?.meanings?.[0]?.definitions?.[0]?.definition;
      if (!def) return { ok: false, speak: `I could not find "${w}" in my dictionary.`, error: 'not found' };
      return { ok: true, speak: `${w} — ${entry.meanings[0].partOfSpeech || 'word'}: ${def}` };
    },
  },
  {
    name: 'translate',
    definitive: true,
    description: 'Translate text into another language.',
    parameters: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string', description: 'target language, e.g. Urdu' } }, required: ['text'] },
    patterns: [/\btranslate\b/i, /\bsay .* in (urdu|hindi|english|arabic|spanish|french|chinese|japanese)\b/i],
    keywords: ['translate', 'in urdu', 'in hindi', 'in spanish', 'in french', 'in arabic'],
    needs: ['network'],
    async run({ text, to }, ctx) {
      const target = to || 'Urdu';
      const langCode = LANG_CODES[target.toLowerCase()] || target;
      try {
        const r = await tryFetch(
          ctx.fetch,
          `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text).slice(0, 400)}&langpair=en|${encodeURIComponent(langCode)}`,
        );
        const j = await r.json();
        const out = j?.responseData?.translatedText;
        if (out && !/INVALID|QUERY LENGTH/i.test(out)) {
          return { ok: true, speak: `In ${target}: ${out}`, data: { translated: out, to: target } };
        }
      } catch {
        /* ignore */
      }
      return { ok: false, speak: 'The free translator is napping — sorry! I will keep your sentence safe for later.', error: 'translate failed' };
    },
  },
  {
    name: 'calculate',
    definitive: true,
    description: 'Do arithmetic, percentages and simple maths.',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. 12% of 480 or (3+4)*2' } }, required: ['expression'] },
    patterns: [/\b(calculate|compute|what(?:'s| is) \d|how much is \d|\d+\s*[+\-*/^%]\s*\d+)/i],
    keywords: ['calculate', 'compute', 'plus', 'minus', 'times', 'divided by', 'percent'],
    async run({ expression }) {
      try {
        const value = calc(expression);
        return { ok: true, speak: `${expression.trim()} = ${value}`, data: { value } };
      } catch (err) {
        return { ok: false, speak: `I flubbed that maths — ${err.message}. Try like: 12% of 480.`, error: err.message };
      }
    },
  },
  {
    name: 'set_timer',
    description: 'Start a countdown timer in minutes and alert when it ends.',
    parameters: { type: 'object', properties: { minutes: { type: 'number' }, label: { type: 'string' } }, required: ['minutes'] },
    patterns: [/\b(set|start|make)\b.{0,14}\btimer\b/i, /\btimer for\b/i],
    keywords: ['timer', 'countdown'],
    needs: ['store'],
    async run({ minutes = 5, label = 'timer' }, ctx) {
      const id = ctx.scheduler?.add({ type: 'timer', fireAt: Date.now() + minutes * 60000, label });
      return { ok: true, speak: `Timer set: ${minutes} minute${minutes === 1 ? '' : 's'} for "${label}". I will yell Plus Ultra when it is done!`, data: { id, minutes } };
    },
  },
  {
    name: 'set_reminder',
    description: 'Remind the user about something at a certain time.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, at: { type: 'number', description: 'unix ms timestamp' } },
      required: ['text'],
    },
    patterns: [/\b(remind me|reminder|don'?t let me forget|alarm)\b/i],
    keywords: ['remind', 'reminder', 'alarm'],
    needs: ['store'],
    async run({ text, at }, ctx) {
      const when = at ? new Date(at) : parseWhen(text) ?? new Date(Date.now() + 30 * 60000);
      const clean = String(text || 'remember this').replace(/\b(in|at|tomorrow|tonight|today)\b.*$/i, '').trim() || 'this';
      const id = ctx.scheduler?.add({ type: 'reminder', fireAt: when.getTime(), label: clean });
      ctx.memory?.remember(`Reminder: ${clean} at ${when.toLocaleString()}`, { tag: 'reminder', importance: 0.7 });
      return {
        ok: true,
        speak: `Got it! I will remind you to ${clean} ${when.getTime() - Date.now() < 3600000 ? 'in ' + humanDuration(when.getTime() - Date.now()) : `${humanDay(when.getTime())} at ${humanTime(when.getTime())}`}.`,
        data: { id, at: when.getTime(), text: clean },
      };
    },
  },
  {
    name: 'remember',
    description: 'Store a fact, preference or promise in Pip\'s notebook about the user.',
    parameters: { type: 'object', properties: { text: { type: 'string' }, tag: { type: 'string' } }, required: ['text'] },
    patterns: [/\b(remember that|remember i|note that|don'?t forget that|keep in mind)\b/i],
    keywords: ['remember that', 'note that', 'keep in mind'],
    needs: ['store'],
    async run({ text, tag = 'note' }, ctx) {
      const entry = ctx.memory?.remember(text, { tag, importance: 0.8 });
      return { ok: true, speak: `Noted in my hero notebook! "${String(text).slice(0, 90)}" — I will remember that.`, data: entry };
    },
  },
  {
    name: 'recall',
    description: 'Search Pip\'s long-term memory about the user.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    patterns: [/\b(do you remember|what do you know about|recall|did i tell you)\b/i],
    keywords: ['do you remember', 'recall', 'what do you know'],
    needs: ['store'],
    async run({ query }, ctx) {
      const hits = (await ctx.memory?.search(query, { limit: 3 })) || [];
      if (!hits.length) return { ok: true, speak: 'I dug through my notebook and it is blank on that one. Tell me and I will write it down!', data: { hits: [] } };
      return { ok: true, speak: `I remember: ${hits.map((h) => h.text).join(' • ')}`, data: { hits: hits.map((h) => ({ text: h.text, score: h.score })) } };
    },
  },
  {
    name: 'forget',
    description: 'Delete something from Pip\'s memory.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    patterns: [/\b(forget|delete that|erase)\b/i],
    keywords: ['forget', 'delete that', 'erase'],
    needs: ['store'],
    async run({ query }, ctx) {
      const n = ctx.memory?.forget(query) ?? 0;
      return { ok: true, speak: n ? `Okay… I let go of ${n} thing${n === 1 ? '' : 's'} about that.` : 'I did not have anything about that anyway — squeaky clean!', data: { removed: n } };
    },
  },
  {
    name: 'habit_report',
    definitive: true,
    description: 'Summarise the habits and patterns Pip learned about the user.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(my )?(habits?|routine|patterns?|how i (?:use|behave))\b/i, /\bwhat have you learned about me\b/i],
    keywords: ['habit', 'routine', 'pattern', 'learned about me'],
    needs: ['store'],
    async run(_args, ctx) {
      const report = ctx.habits?.report();
      return { ok: true, speak: report?.summary || 'I am still writing notes about you. Give me a day or two!', data: report };
    },
  },
  {
    name: 'add_note',
    description: 'Add a note to the user\'s list.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    patterns: [/\b(add|make|write|save|take)\b.{0,12}\bnote\b/i],
    keywords: ['add note', 'make a note', 'write down', 'note down'],
    needs: ['store'],
    async run({ text }, ctx) {
      const note = ctx.store?.update('notes', [], (arr) => [...arr, { id: Date.now(), text, at: Date.now() }].slice(-200));
      return { ok: true, speak: `Note saved: "${String(text).slice(0, 80)}".`, data: note?.at(-1) };
    },
  },
  {
    name: 'list_notes',
    definitive: true,
    description: 'List the user\'s saved notes.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(show|read|list)\b.{0,12}\bnotes?\b/i],
    keywords: ['my notes', 'list notes', 'read notes'],
    needs: ['store'],
    async run(_args, ctx) {
      const notes = ctx.store?.get('notes', []) || [];
      return { ok: true, speak: notes.length ? `You have ${notes.length} note${notes.length === 1 ? '' : 's'}: ${notes.slice(-3).map((n) => n.text).join(' • ')}` : 'Your note list is empty. Nice and tidy!', data: notes };
    },
  },
  {
    name: 'tech_news',
    description: 'Read the top technology news headlines right now.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(news|headlines)\b/i],
    keywords: ['news', 'headlines', 'tech news', 'what happened today'],
    needs: ['network'],
    async run(_args, ctx) {
      const r = await tryFetch(ctx.fetch, 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=5');
      const j = await r.json();
      const hits = (j.hits || []).filter((h) => h.title).slice(0, 5);
      if (!hits.length) return { ok: false, speak: 'The news feed is quiet right now.', error: 'no hits' };
      return { ok: true, speak: `Top of the tech world right now: ${hits.map((h, i) => `${i + 1}) ${h.title}`).join('  ')}`, data: hits.map((h) => ({ title: h.title, url: h.url, points: h.points })) };
    },
  },
  {
    name: 'coin_flip',
    definitive: true,
    description: 'Flip a coin.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(flip|toss)\b.{0,10}\bcoin\b/i, /\bheads or tails\b/i],
    keywords: ['flip a coin', 'heads or tails', 'toss a coin'],
    async run() {
      const heads = Math.random() < 0.5;
      return { ok: true, speak: heads ? 'Heads! Plus Ultra!' : 'Tails! Still Plus Ultra!', data: { result: heads ? 'heads' : 'tails' } };
    },
  },
  {
    name: 'roll_dice',
    definitive: true,
    description: 'Roll one or more dice.',
    parameters: { type: 'object', properties: { sides: { type: 'number' }, count: { type: 'number' } } },
    patterns: [/\broll\b.{0,10}\b(dice|die|d6|d20)\b/i],
    keywords: ['roll a dice', 'roll dice', 'roll a die', 'd20'],
    async run({ sides = 6, count = 1 }, ctx) {
      const n = Math.min(Math.max(1, Math.round(count)), 10);
      const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * Math.min(Math.max(2, sides), 1000)));
      const total = rolls.reduce((a, b) => a + b, 0);
      ctx?.perception?.logSignal?.('dice');
      return { ok: true, speak: n === 1 ? `You rolled a ${rolls[0]}!` : `You rolled ${rolls.join(', ')} — total ${total}.`, data: { rolls, total } };
    },
  },
  {
    name: 'random_fact',
    definitive: true,
    description: 'Share a fun fact.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(fun )?fact\b/i, /\bsomething interesting\b/i],
    keywords: ['fun fact', 'random fact', 'something interesting'],
    async run() {
      return { ok: true, speak: pick(FACTS) };
    },
  },
  {
    name: 'tell_joke',
    definitive: true,
    description: 'Tell a joke.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(joke|make me laugh)\b/i],
    keywords: ['joke', 'make me laugh', 'funny'],
    async run() {
      return { ok: true, speak: pick(JOKES) };
    },
  },
  {
    name: 'motivate',
    definitive: true,
    description: 'Give the user an encouraging pep talk.',
    parameters: { type: 'object', properties: {} },
    patterns: [
      /\bi(?:'?m| am)\s+(?:so\s+|really\s+|very\s+|a bit\s+|kinda\s+|a little\s+)?(sad|tired|exhausted|stressed|anxious|scared|lazy|done|burnt out|lonely)\b/i,
      /\b(motivate me|cheer me up|pep talk|i need encouragement|encourage me)\b/i,
    ],
    keywords: ['motivate me', 'cheer me up', 'pep talk', 'encourage me', 'i am tired', 'i am sad', 'exhausted'],
    async run() {
      return { ok: true, speak: `${pick(CHEERS)} Want me to stand beside you while you start? I am not going anywhere.` };
    },
  },
  {
    name: 'device_status',
    definitive: true,
    description: 'Report battery, network, memory size and how long Pip has been awake.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(battery|device status|phone status|how much battery)\b/i],
    keywords: ['battery', 'device status', 'how much battery'],
    async run(_args, ctx) {
      const b = ctx.perception?.battery?.() || {};
      const net = ctx.perception?.network?.() || {};
      const bits = [];
      if (b.level != null) bits.push(`battery ${Math.round(b.level * 100)}%${b.charging ? ' (charging)' : ''}`);
      if (net.online != null) bits.push(net.online ? `online${net.type ? ` over ${net.type}` : ''}` : 'offline');
      bits.push(`notebook size ${Math.round((ctx.store?.size() || 0) / 1024)} KB`);
      return { ok: true, speak: `Status check: ${bits.join(', ')}.`, data: { battery: b, network: net } };
    },
  },
  {
    name: 'emote',
    definitive: true,
    description: 'Make Pip perform an emotion or action: cheer, jump, blush, dance, think, droop, sparkle.',
    parameters: { type: 'object', properties: { mood: { type: 'string' } }, required: ['mood'] },
    patterns: [/\b(cheer|jump|dance|blush|sparkle|do a flip|wave|celebrate)\b/i],
    keywords: ['cheer', 'jump', 'dance', 'blush', 'sparkle', 'celebrate', 'wave'],
    needs: ['puppet'],
    async run({ mood = 'cheer' }, ctx) {
      const action = String(mood).toLowerCase();
      ctx.puppet?.perform(action);
      return { ok: true, speak: `${action === 'dance' ? 'Dance mode engaged!' : 'Plus Ultra!!'}`, data: { mood: action } };
    },
  },
  {
    name: 'sleep_puppet',
    definitive: true,
    description: 'Put Pip to sleep until the user wakes him, saving battery.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(go to sleep|sleep now|good night|goodnight pip|power down)\b/i],
    keywords: ['go to sleep', 'good night', 'power down'],
    needs: ['puppet'],
    async run(_a, ctx) {
      ctx.puppet?.sleep();
      return { ok: true, speak: 'Okay… I will keep one eye half open. Wake me whenever.' };
    },
  },
  {
    name: 'wake_puppet',
    definitive: true,
    description: 'Wake Pip up.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(wake up|wakey|good morning pip|rise and shine)\b/i],
    keywords: ['wake up', 'good morning'],
    needs: ['puppet'],
    async run(_a, ctx) {
      ctx.puppet?.wake();
      return { ok: true, speak: 'I am up! I am up! My notebook is ready — what are we doing today?' };
    },
  },
  {
    name: 'who_am_i',
    definitive: true,
    description: 'Show what Pip has learned about the user (name, routines, favourites).',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(who am i|what do you know about me|my profile)\b/i],
    keywords: ['who am i', 'my profile', 'what do you know about me'],
    needs: ['store'],
    async run(_a, ctx) {
      const p = ctx.habits?.profile() || {};
      const bits = Object.entries(p)
        .filter(([, v]) => v != null && v !== '')
        .slice(0, 6)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      return { ok: true, speak: bits.length ? `Here is my notebook on you — ${bits.join(' · ')}` : 'My notebook is still mostly empty. Talk to me more!', data: p };
    },
  },
  {
    name: 'self_test',
    description: 'Run Pip\'s built-in diagnostics on his brains, memory and tools.',
    parameters: { type: 'object', properties: {} },
    patterns: [/\b(self ?test|run diagnostics|are you okay|system check)\b/i],
    keywords: ['self test', 'diagnostics', 'system check', 'are you okay'],
    async run(_a, ctx) {
      const result = (await ctx.selfTest?.()) || { ok: true, summary: 'all good' };
      return { ok: result.ok !== false, speak: result.summary || 'All systems green!', data: result };
    },
  },
];

export const LANG_CODES = {
  urdu: 'ur',
  hindi: 'hi',
  arabic: 'ar',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  chinese: 'zh-CN',
  japanese: 'ja',
  korean: 'ko',
  turkish: 'tr',
  russian: 'ru',
  portuguese: 'pt',
  'english': 'en',
  pashto: 'ps',
  punjabi: 'pa',
  bengali: 'bn',
  indonesian: 'id',
  italian: 'it',
};

function formatWeather(json, place, ctx) {
  const cur = json?.current;
  if (!cur) return { ok: false, speak: `I could not read the sky over ${place}.`, error: 'no weather' };
  const code = WEATHER_CODES[cur.weather_code] || 'mysterious skies';
  const temp = Math.round(cur.temperature_2m);
  const max = json?.daily?.temperature_2m_max?.[0];
  const min = json?.daily?.temperature_2m_min?.[0];
  const rainChance = json?.daily?.precipitation_probability_max?.[0];
  let speak = `In ${place} it is ${temp}°C with ${code}`;
  if (min != null && max != null) speak += `, going from ${Math.round(min)}° to ${Math.round(max)}° today`;
  if (rainChance != null) speak += `. Chance of rain: ${rainChance}%`;
  speak += '.';
  if (rainChance >= 55) speak += ' Take an umbrella, partner!';
  else if (temp >= 35) speak += ' That is hero-sweat weather — drink water!';
  else if (temp <= 8) speak += ' Bundle up!';
  return { ok: true, speak, data: { place, temp, code, max, min, rainChance } };
}

const WEATHER_CODES = {
  0: 'a clear sky', 1: 'mostly clear skies', 2: 'a few clouds', 3: 'overcast clouds', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'a thunderstorm', 96: 'a thunderstorm with hail', 99: 'a thunderstorm with heavy hail',
};

/* ═════════════ registry ═════════════ */
export class Toolkit {
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.tools = TOOLS.map((t) => ({ ...t }));
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
    this.calls = 0;
  }

  list() {
    return this.tools;
  }

  names() {
    return this.tools.map((t) => t.name);
  }

  spec(name) {
    return this.byName.get(name);
  }

  /** schemas for gateways that natively support tool calling */
  schemas({ max = 14 } = {}) {
    return this.tools.slice(0, max).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  /** Never throws. Always returns { ok, speak? , error? }. */
  async run(name, args = {}) {
    this.calls++;
    const tool = this.byName.get(name);
    if (!tool) return { ok: false, error: `unknown tool "${name}"`, speak: `I do not have a gadget called ${name} yet!` };
    try {
      const out = await tool.run(args, this.ctx);
      return { ok: out?.ok !== false, speak: out?.speak, data: out?.data, error: out?.error };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), speak: `My ${name} gadget slipped: ${err?.message || err}` };
    }
  }

  async runCalls(calls = []) {
    const results = [];
    for (const call of calls) {
      const res = await this.run(call.name, call.arguments);
      results.push({ ...call, result: res });
    }
    return results;
  }
}

export const toolNames = () => TOOLS.map((t) => t.name);
