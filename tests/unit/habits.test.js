import test from 'node:test';
import assert from 'node:assert/strict';
import { Habits, isQuiet } from '../../js/habits.js';
import { Bus } from '../../js/core/bus.js';
import { makeStore, fakeClock } from '../helpers.mjs';

const at = (iso) => new Date(iso).getTime();
const setup = () => {
  const store = makeStore();
  const clock = fakeClock(at('2026-09-21T09:00:00'));
  const bus = new Bus();
  const habits = new Habits({ store, clock, bus });
  return { store, clock, bus, habits };
};

test('observations accumulate into hourly EWMA and day buckets', () => {
  const { habits, clock } = setup();
  habits.observe('message', { chars: 10 });
  clock.at('2026-09-21T09:30:00');
  habits.observe('message', { chars: 20 });
  habits.observe('tool', { name: 'get_weather' });
  habits.observe('tool', { name: 'get_weather' });
  habits.observe('tool', { name: 'tell_joke' });
  habits.observe('topic', { topic: 'study' });

  const summary = habits.summary();
  assert.equal(summary.signals, 6); // 2 messages + 3 tools + 1 topic
  assert.equal(summary.days, 1);
  assert.equal(summary.hours[9] > 0, true);
  assert.deepEqual(habits.topTools(1), [{ name: 'get_weather', count: 2 }]);
  assert.deepEqual(habits.topTopics(1), [{ topic: 'study', count: 1 }]);
  assert.equal(habits.busiestHour(), 9);
  assert.equal(habits.activeDays(), 1);
});

test('state is persisted and reloadable', () => {
  const { habits, store } = setup();
  habits.observe('message');
  const reloaded = new Habits({ store, clock: () => at('2026-09-21T10:00:00') });
  assert.equal(reloaded.summary().signals, 1);
});

test('the bus hears about updates', () => {
  const { habits, bus } = setup();
  let payload = null;
  bus.on('habits:updated', (p) => (payload = p));
  habits.observe('message');
  assert.ok(payload);
  assert.equal(payload.signals, 1);
});

test('wake, sleep and streak logic follows a realistic week', () => {
  const { habits, clock } = setup();
  const days = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21'];
  days.forEach((d, i) => {
    clock.at(`${d}T07:${String(10 + i).padStart(2, '0')}:00`);
    habits.observe('wake');
    clock.at(`${d}T12:00:00`);
    habits.observe('message');
    clock.at(`${d}T22:30:00`);
    habits.observe('session_end', { minutes: 40 });
    habits.observe('sleep');
  });
  assert.equal(habits.activeDays(), 7);
  assert.equal(habits.wakingHour(), 7);
  assert.equal(habits.avgLastHour(), 22);
  assert.equal(habits.streak(), 7, 'seven consecutive days is a streak');
  assert.equal(habits.avgSessionMinutes(), 40);
});

test('a missed day breaks the streak', () => {
  const { habits, clock } = setup();
  clock.at('2026-09-19T09:00:00');
  habits.observe('message');
  clock.at('2026-09-20T09:00:00');
  habits.observe('message');
  clock.at('2026-09-21T09:00:00'); // today: nothing observed yet
  assert.equal(habits.streak(), 2, 'the streak survives until today ends');
  habits.observe('message');
  assert.equal(habits.streak(), 3);

  // a real gap breaks it
  const gapStore = makeStore();
  const gapClock = fakeClock(at('2026-09-21T09:00:00'));
  const gapped = new Habits({ store: gapStore, clock: gapClock });
  gapClock.at('2026-09-15T09:00:00');
  gapped.observe('message');
  gapClock.at('2026-09-21T09:00:00');
  assert.equal(gapped.streak(), 0, 'a five day gap resets the streak');
});

test('insights and report read like a notebook entry', () => {
  const { habits, clock } = setup();
  for (let i = 0; i < 3; i++) {
    clock.at(`2026-09-${19 + i}T07:30:00`);
    habits.observe('wake');
    habits.observe('message');
    habits.observe('tool', { name: 'get_weather' });
    clock.at(`2026-09-${19 + i}T09:00:00`);
    habits.observe('topic', { topic: 'weather' });
  }
  const insights = habits.insights();
  assert.ok(insights.length >= 3);
  assert.ok(insights.some((i) => /known you for 3 days/.test(i)));
  assert.ok(insights.some((i) => /weather/.test(i)));
  const report = habits.report();
  assert.equal(report.ok, true);
  assert.ok(report.summary.length > 30);
  assert.ok(report.profile.known_days === 3);
  assert.equal(report.profile.favourite_gadget, 'get_weather');
  assert.ok(report.profile.top_topics.includes('weather'));
});

test('a fresh install gives friendly defaults instead of NaN', () => {
  const { habits } = setup();
  const profile = habits.profile();
  assert.equal(profile.known_days, 0);
  assert.equal(profile.streak_days, 0);
  assert.equal(profile.usually_awake_from, null);
  assert.equal(profile.favourite_gadget, null);
  assert.deepEqual(profile.likes, []);
  assert.equal(habits.avgSessionMinutes(), 0);
  assert.ok(habits.insights()[0].length > 10);
  const report = habits.report();
  assert.ok(!/NaN|undefined/.test(JSON.stringify(report.profile)));
});

test('quiet hours wrap around midnight correctly', () => {
  const night = at('2026-09-21T23:30:00');
  const early = at('2026-09-21T02:00:00');
  const midday = at('2026-09-21T12:00:00');
  assert.equal(isQuiet(night, '23:00', '07:00'), true);
  assert.equal(isQuiet(early, '23:00', '07:00'), true);
  assert.equal(isQuiet(midday, '23:00', '07:00'), false);
  assert.equal(isQuiet(night, '09:00', '17:00'), false);
  assert.equal(isQuiet(midday, '09:00', '17:00'), true);
  assert.equal(isQuiet(midday, '12:00', '12:00'), false, 'zero-length quiet time is disabled');
});

test('nudges respect cooldowns, quiet hours and enabled flag', () => {
  const { habits, clock } = setup();
  for (let i = 0; i < 4; i++) {
    clock.at(`2026-09-${18 + i}T09:00:00`);
    habits.observe('message');
    habits.observe('tool', { name: 'get_weather' });
  }
  const opts = { quietStart: '23:00', quietEnd: '07:00', minGapMs: 30 * 60000, enabled: true };
  const first = habits.suggestNudge(opts);
  assert.ok(first, 'a nudge is offered when there is something to say');
  assert.equal(habits.suggestNudge(opts), null, 'cooldown stops spam');
  clock.advance(31 * 60000);
  assert.ok(habits.suggestNudge(opts));
  assert.equal(habits.suggestNudge({ ...opts, enabled: false }), null);

  clock.at('2026-09-21T03:00:00');
  assert.equal(habits.suggestNudge({ ...opts, minGapMs: 0 }), null, 'quiet hours are respected');
});

test('streaks and huge histories stay bounded', () => {
  const { habits, clock } = setup();
  for (let d = 0; d < 200; d++) {
    clock.at(at('2025-01-01T09:00:00') + d * 86400000);
    habits.observe('message');
  }
  const keys = Object.keys(habits.state.days);
  assert.ok(keys.length <= 120, `history should be capped, got ${keys.length}`);
  assert.ok(habits.state.wakeTimes.length <= 30);
  assert.ok(habits.state.sessions.length <= 60);
});

test('corrupt stored state is repaired instead of crashing', () => {
  const store = makeStore({ 'pip.habits': JSON.stringify({ hours: [1, 2, 3], tools: null }) });
  const habits = new Habits({ store, clock: () => Date.now() });
  assert.equal(habits.state.hours.length, 24);
  assert.doesNotThrow(() => habits.observe('message'));
  assert.doesNotThrow(() => habits.topTools());
  assert.doesNotThrow(() => habits.report());
});
