import test from 'node:test';
import assert from 'node:assert/strict';
import { Speech, VOICE_PRESETS } from '../../js/speech.js';
import { Bus } from '../../js/core/bus.js';
import { makeStore, makePool } from '../helpers.mjs';

/** A tiny fake Web Speech API. */
function fakeWin({ voices = [{ name: 'Google UK English Male', lang: 'en-GB' }, { name: 'Zira', lang: 'en-US' }], browserFails = false, recognition = null, puter = null } = {}) {
  const spoken = [];
  class FakeUtterance {
    constructor(text) {
      this.text = text;
    }
  }
  const win = {
    innerWidth: 390,
    SpeechSynthesisUtterance: FakeUtterance,
    speechSynthesis: {
      getVoices: () => voices,
      speak(u) {
        spoken.push(u.text);
        setTimeout(() => {
          if (browserFails) u.onerror?.(new Error('voice engine died'));
          else {
            u.onstart?.();
            u.onend?.();
          }
        }, 1);
      },
      cancel() {},
    },
    puter,
  };
  if (recognition) win.SpeechRecognition = recognition;
  return { win, spoken };
}

test('voice presets exist for every persona', () => {
  assert.deepEqual(Object.keys(VOICE_PRESETS), ['deku', 'calm', 'hype']);
  for (const p of Object.values(VOICE_PRESETS)) {
    assert.ok(p.pitch > 0 && p.rate > 0);
    assert.ok(Array.isArray(p.prefer));
  }
  assert.ok(VOICE_PRESETS.deku.pitch > 1, 'the deku persona has a bright cartoon pitch');
});

test('speaks through the browser engine and reports the path used', async () => {
  const { win, spoken } = fakeWin();
  const speech = new Speech({ win, store: makeStore() });
  let started = false;
  let ended = false;
  const res = await speech.speak('Plus Ultra!', { onStart: () => (started = true), onEnd: () => (ended = true) });
  assert.equal(res.ok, true);
  assert.equal(res.via, 'browser');
  assert.deepEqual(spoken, ['Plus Ultra!']);
  assert.equal(started, true);
  assert.equal(ended, true);
  assert.equal(speech.utterances, 1);
});

test('text is cleaned before speaking and empty text is skipped', async () => {
  const { win, spoken } = fakeWin();
  const speech = new Speech({ win });
  await speech.speak('**Hero** `code` # heading\n\n  spaced   out ');
  assert.deepEqual(spoken, ['Hero code heading spaced out']);
  const empty = await speech.speak('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.via, 'empty');
});

test('a muted puppet resolves instantly so the rest of the app keeps working', async () => {
  const { win, spoken } = fakeWin();
  const speech = new Speech({ win, enabled: false });
  let ended = false;
  const res = await speech.speak('you cannot hear this', { onEnd: () => (ended = true) });
  assert.equal(res.via, 'muted');
  assert.equal(ended, true);
  assert.deepEqual(spoken, []);
  speech.setEnabled(true);
  await speech.speak('now you can', { force: true });
  assert.deepEqual(spoken, ['now you can']);
});

test('falls back to puter when the browser has no voice engine', async () => {
  const played = [];
  const puter = {
    ai: {
      txt2speech: async (text) => {
        const audio = {
          play: () => {
            played.push(text);
            setTimeout(() => audio.onended?.(), 1);
            return { catch: () => {} };
          },
          onended: null,
        };
        return audio;
      },
    },
  };
  const win = { puter, Audio: undefined };
  const speech = new Speech({ win, store: makeStore() });
  const res = await speech.speak('hello from puter');
  assert.equal(res.via, 'puter');
  assert.deepEqual(played, ['hello from puter']);
});

test('falls back to pollinations audio when browser and puter are unavailable', async () => {
  const created = [];
  const win = {
    Audio: class {
      constructor(src) {
        created.push(src);
        setTimeout(() => this.onended?.(), 1);
      }
      play() {
        this.onplay?.();
        return { catch: () => {} };
      }
    },
  };
  const speech = new Speech({ win });
  const res = await speech.speak('hello from the hive');
  assert.equal(res.via, 'pollinations');
  assert.match(created[0], /^https:\/\/gen\.pollinations\.ai\/audio\//);
  assert.match(decodeURIComponent(created[0]), /hello from the hive/);
});

test('private mode blocks the pollinations fallback but keeps speaking locally', async () => {
  const win = {
    Audio: class {
      constructor(src) {
        throw new Error('should not be constructed');
      }
    },
  };
  const pool = makePool();
  pool.setPrivateMode(true);
  const speech = new Speech({ win, pool });
  const res = await speech.speak('secret');
  assert.equal(res.ok, false);
  assert.equal(res.via, 'none');
  assert.ok(res.errors.some((e) => /private-mode/i.test(e)));
});

test('voice picking prefers the persona list and persists a manual choice', () => {
  const { win } = fakeWin();
  const store = makeStore();
  const speech = new Speech({ win, store, preset: 'calm' });
  assert.equal(speech.pickVoice().name, 'Google UK English Male');
  speech.setPreset('hype');
  assert.equal(speech.pickVoice().name, 'Zira');
  const chosen = speech.setVoiceByName('Google UK English Male');
  assert.equal(chosen.name, 'Google UK English Male');
  assert.equal(store.get('voiceName'), 'Google UK English Male');
  const noVoices = new Speech({ win: { ...win, speechSynthesis: { getVoices: () => [] } } });
  assert.equal(noVoices.pickVoice(), null);
  assert.equal(noVoices.setVoiceByName('nope'), null);
});

test('listening uses the free in-browser recognizer first', async () => {
  let started = 0;
  class FakeRecognition {
    start() {
      started++;
      setTimeout(() => {
        this.onresult?.({
          results: [
            Object.assign([{ transcript: 'hey pip what is the weather' }], { isFinal: true }),
          ],
        });
      }, 1);
    }
    stop() {}
  }
  const win = { SpeechRecognition: FakeRecognition };
  const speech = new Speech({ win });
  assert.equal(speech.listenSupported, true);
  const res = await speech.listen();
  assert.equal(res.ok, true);
  assert.equal(res.via, 'webspeech');
  assert.match(res.text, /weather/);
  assert.equal(started, 1);
  assert.equal(speech.listening, false, 'listening flag resets');
});

test('listening reports partials and handles silence', async () => {
  class FakeRecognition {
    start() {
      setTimeout(() => {
        this.onresult?.({ results: [Object.assign([{ transcript: 'half a sen' }], { isFinal: false })] });
        this.onend?.();
      }, 1);
    }
    stop() {}
  }
  const speech = new Speech({ win: { SpeechRecognition: FakeRecognition } });
  const partials = [];
  const res = await speech.listen({ onPartial: (p) => partials.push(p), timeoutMs: 50 });
  assert.deepEqual(partials, ['half a sen']);
  assert.equal(res.ok, false);
  assert.match(res.error, /no speech detected/);
});

test('listening degrades to recorder + keyless whisper', async () => {
  const tracks = [];
  class FakeRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
    }
    start() {
      this.state = 'recording';
      setTimeout(() => this.onstop?.(), 5);
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: { size: 10, type: 'audio/webm' } });
      this.onstop?.();
    }
  }
  const win = {
    MediaRecorder: FakeRecorder,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => tracks.push(1) }] }) } },
    Blob,
  };
  const pool = makePool();
  const speech = new Speech({ win, pool });
  const res = await speech.listen({ timeoutMs: 30 });
  assert.equal(res.ok, true);
  assert.equal(res.via, 'ovh-whisper');
  assert.equal(res.text, 'transcribed words');
  assert.equal(tracks.length, 1, 'microphone track is released');
});

test('a denied microphone returns a friendly error instead of throwing', async () => {
  const win = {
    MediaRecorder: class {},
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('Permission denied'); } } },
  };
  const speech = new Speech({ win, pool: makePool() });
  const res = await speech.listen();
  assert.equal(res.ok, false);
  assert.match(res.error, /Permission denied/);
});

test('devices without any speech input say so kindly', async () => {
  const speech = new Speech({ win: {} });
  assert.equal(speech.listenSupported, false);
  const res = await speech.listen();
  assert.equal(res.ok, false);
  assert.match(res.error, /no speech recognition/);
});

test('stop() cancels playback and the bus announces state changes', async () => {
  const { win } = fakeWin();
  const bus = new Bus();
  const events = [];
  bus.on('*', (payload, event) => events.push(event));
  const speech = new Speech({ win, bus });
  await speech.speak('hello');
  speech.stop();
  assert.equal(speech.speaking, false);
  assert.ok(events.includes('speech:spoke'));
  const filler = speech.filler();
  assert.ok(filler.length > 1);
});
