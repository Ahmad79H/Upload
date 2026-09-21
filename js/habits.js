/**
 * PIP WATCHES, PIP LEARNS — on-device habit learning.
 *
 * Every interaction (message, gadget, presence ping, screen-on event, timer)
 * becomes a timestamped signal. From that Pip derives:
 *   • when you wake up and when you go quiet,
 *   • which hours you are chatty (EWMA per hour bucket),
 *   • which gadgets you reach for most,
 *   • streaks, session lengths and how many days he has known you,
 *   • gentle proactive nudges ("you usually ask about the weather now").
 *
 * No ML framework, no server, no uploads: just statistics you can inspect in
 * the Habits tab (and that unit tests can drive with a fake clock).
 */
import { dayKey, hourOf, ewma, clamp, mean, humanDuration, pick } from './core/util.js';

const BUCKETS = 24;

export class Habits {
  constructor({ store, clock = () => Date.now(), bus = null } = {}) {
    if (!store) throw new Error('Habits needs a Store');
    this.store = store;
    this.clock = clock;
    this.bus = bus;
    this.state = this.normalize(this.store.get('habits', null));
  }

  /** Merge stored state with defaults so a corrupt/older notebook can never crash Pip. */
  normalize(stored) {
    const base = {
      hours: new Array(BUCKETS).fill(0),
      days: {},
      tools: {},
      topics: {},
      signals: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      wakeTimes: [],
      sleepTimes: [],
      sessions: [],
      nudgesSent: 0,
      lastNudgeAt: 0,
    };
    const src = stored && typeof stored === 'object' ? stored : {};
    const out = { ...base, ...src };
    if (!Array.isArray(out.hours) || out.hours.length !== BUCKETS) out.hours = new Array(BUCKETS).fill(0);
    out.hours = out.hours.map((v) => (Number.isFinite(v) ? v : 0));
    for (const key of ['days', 'tools', 'topics']) if (!out[key] || typeof out[key] !== 'object' || Array.isArray(out[key])) out[key] = {};
    for (const key of ['wakeTimes', 'sleepTimes', 'sessions']) if (!Array.isArray(out[key])) out[key] = [];
    for (const key of ['signals', 'nudgesSent', 'lastNudgeAt']) if (!Number.isFinite(out[key])) out[key] = 0;
    return out;
  }

  persist() {
    this.store.set('habits', this.state);
    this.bus?.emit('habits:updated', this.summary());
    return this.state;
  }

  /** Record one signal. Keeps everything bounded so localStorage never explodes. */
  observe(type, meta = {}) {
    const now = this.clock();
    const h = hourOf(now);
    const k = dayKey(now);
    this.state.signals++;
    this.state.hours[h] = Number(ewma(this.state.hours[h], 1, 0.12).toFixed(4));
    for (let i = 0; i < BUCKETS; i++) if (i !== h) this.state.hours[i] = Number((this.state.hours[i] * 0.999).toFixed(4));
    const day = (this.state.days[k] ||= { first: now, last: now, count: 0, messages: 0, tools: 0, minutes: 0 });
    day.last = now;
    day.count++;
    day.first = Math.min(day.first, now);
    this.state.firstSeenAt ??= now;
    this.state.lastSeenAt = now;

    if (type === 'message') day.messages++;
    if (type === 'tool') {
      day.tools++;
      const name = meta.name || 'unknown';
      this.state.tools[name] = (this.state.tools[name] || 0) + 1;
    }
    if (type === 'topic' && meta.topic) this.state.topics[meta.topic] = (this.state.topics[meta.topic] || 0) + 1;
    if (type === 'wake') this.state.wakeTimes = [...this.state.wakeTimes, now].slice(-30);
    if (type === 'sleep') this.state.sleepTimes = [...this.state.sleepTimes, now].slice(-30);
    if (type === 'session_end' && meta.minutes) this.state.sessions = [...this.state.sessions, Math.round(meta.minutes)].slice(-60);

    // keep at most 120 days of history
    const keys = Object.keys(this.state.days);
    if (keys.length > 120) for (const old of keys.slice(0, keys.length - 120)) delete this.state.days[old];

    this.persist();
    return this.state.days[k];
  }

  /* ───────── derived knowledge ───────── */

  busiestHour() {
    let best = 0;
    this.state.hours.forEach((v, i) => {
      if (v > this.state.hours[best]) best = i;
    });
    return this.state.hours[best] > 0 ? best : null;
  }

  wakingHour() {
    const times = this.state.wakeTimes.map((t) => hourOf(t));
    return times.length ? Math.round(mean(times)) : Object.keys(this.state.days).length ? this.avgFirstHour() : null;
  }

  avgFirstHour() {
    const hours = Object.values(this.state.days).map((d) => hourOf(d.first));
    return hours.length ? Math.round(mean(hours)) : null;
  }

  avgLastHour() {
    const hours = Object.values(this.state.days).map((d) => hourOf(d.last));
    return hours.length ? Math.round(mean(hours)) : null;
  }

  activeDays() {
    return Object.keys(this.state.days).length;
  }

  /** Consecutive days with activity. A streak survives until the end of today. */
  streak() {
    let streak = 0;
    const d = new Date(this.clock());
    if (!this.state.days[dayKey(d.getTime())]) d.setDate(d.getDate() - 1); // start from yesterday
    for (;;) {
      const key = dayKey(d.getTime());
      if (this.state.days[key]) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else break;
      if (streak > 400) break;
    }
    return streak;
  }

  topTools(n = 3) {
    return Object.entries(this.state.tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, count]) => ({ name, count }));
  }

  topTopics(n = 4) {
    return Object.entries(this.state.topics)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([topic, count]) => ({ topic, count }));
  }

  avgSessionMinutes() {
    if (!this.state.sessions.length) {
      const mins = Object.values(this.state.days).map((d) => (d.last - d.first) / 60000).filter((m) => m > 0.5);
      return mins.length ? Math.round(mean(mins)) : 0;
    }
    return Math.round(mean(this.state.sessions));
  }

  profile() {
    const wake = this.wakingHour();
    const sleep = this.avgLastHour();
    const p = this.store.get('profile', {});
    return {
      name: p.name || null,
      city: p.city || null,
      likes: p.likes || [],
      known_days: this.activeDays(),
      streak_days: this.streak(),
      usually_awake_from: wake != null ? `${String(wake).padStart(2, '0')}:00` : null,
      usually_quiet_after: sleep != null ? `${String(sleep).padStart(2, '0')}:00` : null,
      busiest_hour: this.busiestHour(),
      favourite_gadget: this.topTools(1)[0]?.name || null,
      top_topics: this.topTopics(3).map((t) => t.topic),
      avg_session_minutes: this.avgSessionMinutes(),
      signals_learned: this.state.signals,
    };
  }

  summary() {
    return {
      hours: this.state.hours.map((v) => Number(v.toFixed(3))),
      days: this.activeDays(),
      signals: this.state.signals,
      tools: this.state.tools,
      streak: this.streak(),
    };
  }

  /** Human-readable insight list for the Habits tab. */
  insights() {
    const out = [];
    const wake = this.wakingHour();
    const sleep = this.avgLastHour();
    const busiest = this.busiestHour();
    const tools = this.topTools(3);
    const topics = this.topTopics(3);
    const days = this.activeDays();
    if (days) out.push(`I have known you for ${days} day${days === 1 ? '' : 's'}${this.streak() > 1 ? ` (streak: ${this.streak()} days in a row!)` : ''}.`);
    if (wake != null) out.push(`You usually show up around ${String(wake).padStart(2, '0')}:00 — I try to be awake first.`);
    if (sleep != null) out.push(`You tend to go quiet around ${String(sleep).padStart(2, '0')}:00, so I keep my voice down after that.`);
    if (busiest != null) out.push(`Your most active hour is ${String(busiest).padStart(2, '0')}:00.`);
    if (tools.length) out.push(`Your favourite gadgets: ${tools.map((t) => `${t.name} (×${t.count})`).join(', ')}.`);
    if (topics.length) out.push(`You keep talking about: ${topics.map((t) => t.topic).join(', ')}.`);
    const avg = this.avgSessionMinutes();
    if (avg) out.push(`Our average session is about ${humanDuration(avg * 60000)}.`);
    if (!out.length) out.push('Talk to me a little and I will start writing insights here!');
    return out;
  }

  report() {
    return {
      ok: true,
      summary: `${pick(['Here is my notebook on you:', 'Habit scan complete, partner!', 'I have been watching patterns…'])} ${this.insights().slice(0, 3).join(' ')}`,
      insights: this.insights(),
      profile: this.profile(),
    };
  }

  /**
   * Proactive nudges. Returns at most one suggestion per cooldown window and
   * respects quiet hours (given as "HH:MM" strings).
   */
  suggestNudge({ quietStart = '23:00', quietEnd = '07:00', minGapMs = 45 * 60000, enabled = true } = {}) {
    if (!enabled) return null;
    const now = this.clock();
    if (now - this.state.lastNudgeAt < minGapMs) return null;
    if (isQuiet(now, quietStart, quietEnd)) return null;
    const h = hourOf(now);
    const suggestions = [];
    const busiest = this.busiestHour();
    const fav = this.topTools(1)[0]?.name;
    const favToolText = { get_weather: 'weather check', tech_news: 'headlines', set_timer: 'a focus timer', calculate: 'some maths', motivate: 'a pep talk' }[fav] || 'your usual gadgets';
    if (fav && Math.abs(h - (busiest ?? h)) <= 1) suggestions.push(`It is about the time you usually ask me for ${favToolText}. Want me to pull it up?`);
    const wake = this.wakingHour();
    if (wake != null && h === wake) suggestions.push('You are up early again — should I check the weather and your notes for today?');
    const sleep = this.avgLastHour();
    if (sleep != null && Math.abs(h - sleep) <= 1) suggestions.push('You are usually winding down now. Want me to set an alarm for tomorrow?');
    if (this.streak() >= 3) suggestions.push(`That is ${this.streak()} days in a row you have talked to me — Plus Ultra streak!`);
    if (!suggestions.length) return null;
    this.state.lastNudgeAt = now;
    this.state.nudgesSent++;
    this.persist();
    return { text: pick(suggestions), at: now };
  }
}

export function isQuiet(ts, quietStart = '23:00', quietEnd = '07:00') {
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const d = new Date(ts);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = toMin(quietStart);
  const end = toMin(quietEnd);
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
