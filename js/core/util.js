/** Small dependency-free helpers shared by every module (all pure → easy to unit test). */

export const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
export const lerp = (a, b, t) => a + (b - a) * t;
export const round = (n, dp = 2) => Number(n.toFixed(dp));
export const nowMs = () => Date.now();

let uidCounter = 0;
export const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Safe JSON parse that never throws. */
export function safeJson(text, fallback = null) {
  if (text == null) return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    // Models love wrapping JSON in prose or fences — try to dig it out.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fenced) return safeJson(fenced[1], fallback);
    const first = text.search(/[[{]/);
    const last = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        /* fall through */
      }
    }
    return fallback;
  }
}

/** Promise timeout that rejects with a labelled error. */
export function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Retry with exponential backoff + jitter. `signal` abort stops it. */
export async function retry(fn, { tries = 3, base = 200, max = 2000, signal, onError } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      onError?.(err, i);
      if (i === tries - 1) break;
      const wait = Math.min(max, base * 2 ** i) * (0.75 + Math.random() * 0.5);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export const mean = (arr = []) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
export const median = (arr = []) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
export const ewma = (prev, next, alpha = 0.2) => (prev == null ? next : alpha * next + (1 - alpha) * prev);

export const tokenize = (text = '') =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

export function cosine(a = [], b = []) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Bag-of-words vector over a fixed vocabulary. Used by the local memory search. */
export function bagOfWords(text, vocab = null) {
  const tokens = tokenize(text);
  const vec = vocab ? new Map(vocab.map((w) => [w, 0])) : new Map();
  for (const t of tokens) vec.set(t, (vec.get(t) || 0) + 1);
  return vec;
}

export function bagVector(map, vocab) {
  return vocab.map((w) => map.get(w) || 0);
}

export const dayKey = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const hourOf = (ts = Date.now()) => new Date(ts).getHours();
export const minutesOfDay = (ts = Date.now()) => {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
};

export function humanTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function humanDay(ts = Date.now()) {
  const days = (ts - Date.now()) / 86400000;
  if (Math.abs(days) < 1) return 'today';
  if (days >= 1 && days < 2) return 'tomorrow';
  if (days <= -1 && days > -2) return 'yesterday';
  return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "5 min", "half an hour", "in 2 hours", "at 7:30", "tomorrow 8am" → Date | null */
export function parseWhen(text = '', base = Date.now()) {
  const t = String(text).toLowerCase().trim();
  if (!t) return null;
  const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, sixty: 60, half: 0.5, forty: 40 };
  const num = (s) => {
    if (s == null) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    return words[s] ?? null;
  };
  // Phrasings the generic regex gets wrong ("in half an hour" → "an hour").
  if (/half\s+an?\s+hour|half\s+hour/.test(t)) return new Date(base + 30 * 60000);
  if (/quarter\s+(?:of\s+)?an?\s+hour/.test(t)) return new Date(base + 15 * 60000);
  if (/an?\s+hour\s+and\s+a\s+half/.test(t)) return new Date(base + 90 * 60000);
  // \b guards stop "at 7 am" being read as "a m" = one minute.
  let m = /(?:in\s+)?\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|half|sixty)\b\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/.exec(t);
  if (m) {
    const amount = num(m[1]);
    if (amount == null) return null;
    const unit = m[2][0];
    const ms = unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
    return new Date(base + amount * ms);
  }
  m = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(t);
  if (m && (m[3] || /at\s+/.test(t) || /:/.test(m[0]))) {
    let hour = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    if (hour > 23 || min > 59) return null;
    const d = new Date(base);
    d.setHours(hour, min, 0, 0);
    if (/tomorrow/.test(t) || d.getTime() <= base) if (!/today/.test(t)) d.setDate(d.getDate() + (/tomorrow/.test(t) ? 1 : d.getTime() <= base ? 1 : 0));
    return d;
  }
  if (/tomorrow/.test(t)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  if (/tonight/.test(t)) {
    const d = new Date(base);
    d.setHours(20, 0, 0, 0);
    return d;
  }
  if (/noon/.test(t)) {
    const d = new Date(base);
    d.setHours(12, 0, 0, 0);
    return d;
  }
  return null;
}

/** Format a duration in ms as "2h 5m" */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const pick = (arr = [], rng = Math.random) => arr[Math.floor(rng() * arr.length) % (arr.length || 1)];
export const pickMany = (arr = [], n = 1, rng = Math.random) => {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < n) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
};

/** Throttle to at most one call per `ms` (trailing call included). */
export function throttle(fn, ms = 200) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
}

export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Local time bucket → 'morning' | 'afternoon' | 'evening' | 'night' */
export function partOfDay(ts = Date.now()) {
  const h = hourOf(ts);
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}
