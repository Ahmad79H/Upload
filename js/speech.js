/**
 * PIP'S VOICE & EARS — free speech in, free speech out.
 *
 *  🗣  Speaking chain:  browser speechSynthesis (best voice for the persona)
 *                      → Puter.js TTS (keyless, if the script is loaded)
 *                      → Pollinations audio endpoint (keyless)
 *                      → silence (never an error dialog; the bubble still shows text)
 *  👂  Listening chain: Web Speech recognition (free, in-browser)
 *                      → MediaRecorder + keyless OVHcloud Whisper (own API in gateways.js)
 *
 * The puppet's mouth animation is driven by `speak()`: onstart → talk loop,
 * onend → idle. If the user mutes him, `speak()` resolves instantly so the rest
 * of the pipeline (and the tests) behave identically.
 */
import { pick } from './core/util.js';

/** Little voice-shaping presets so Pip sounds like a kid hero, not a GPS. */
export const VOICE_PRESETS = {
  deku: { pitch: 1.22, rate: 1.06, prefer: ['Google UK English Male', 'Daniel', 'Alex', 'Google US English', 'Samantha'] },
  calm: { pitch: 1.0, rate: 0.96, prefer: ['Google UK English Female', 'Serena', 'Victoria', 'Fiona'] },
  hype: { pitch: 1.35, rate: 1.18, prefer: ['Google US English', 'Zira', 'Google UK English Female'] },
};

export class Speech {
  constructor({ win = globalThis, pool = null, clock = () => Date.now(), bus = null, store = null, enabled = true, preset = 'deku' } = {}) {
    this.win = win;
    this.pool = pool;
    this.clock = clock;
    this.bus = bus;
    this.store = store;
    this.enabled = enabled;
    this.preset = preset;
    this.voice = null;
    this.speaking = false;
    this.listening = false;
    this.utterances = 0;
    this.lastError = null;
    this._recognition = null;
    this._recorder = null;
    this._chunks = [];
    this._audio = null;
    this._timers = new Set();
    this.synth = win?.speechSynthesis || null;
    this.SpeechRecognition = win?.SpeechRecognition || win?.webkitSpeechRecognition || null;
  }

  /**
   * setTimeout that works in browsers and does not hold a Node process open
   * (so headless test runs and CLI tools exit cleanly).
   */
  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    id?.unref?.();
    return id;
  }

  /* ─────────── voices ─────────── */

  voices() {
    try {
      return this.synth?.getVoices?.() || [];
    } catch {
      return [];
    }
  }

  /** Pick the nicest available voice for the current persona. */
  pickVoice(preferList = null) {
    const all = this.voices();
    if (!all.length) return null;
    const prefer = preferList || VOICE_PRESETS[this.preset]?.prefer || [];
    for (const name of prefer) {
      const hit = all.find((v) => v.name?.toLowerCase().includes(name.toLowerCase()));
      if (hit) return hit;
    }
    const en = all.find((v) => /^en/i.test(v.lang || ''));
    return en || all[0];
  }

  setVoiceByName(name) {
    const hit = this.voices().find((v) => v.name === name);
    this.voice = hit || null;
    this.store?.set('voiceName', name || null);
    return this.voice;
  }

  setPreset(preset) {
    if (!VOICE_PRESETS[preset]) return this.preset;
    this.preset = preset;
    return this.preset;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.stop();
    return this.enabled;
  }

  /* ─────────── speaking ─────────── */

  async speak(text, { preset = this.preset, onStart, onEnd, force = false } = {}) {
    const clean = String(text || '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return { ok: false, via: 'empty' };
    if (!this.enabled && !force) {
      onStart?.();
      onEnd?.();
      return { ok: true, via: 'muted' };
    }
    this.utterances++;
    const chain = [() => this._speakBrowser(clean, preset, onStart, onEnd), () => this._speakPuter(clean, onStart, onEnd), () => this._speakPollinations(clean, onStart, onEnd)];
    const errors = [];
    for (const attempt of chain) {
      try {
        const res = await attempt();
        if (res?.ok) {
          this.bus?.emit('speech:spoke', { via: res.via, chars: clean.length });
          return res;
        }
        if (res?.error) errors.push(`${res.via}: ${res.error}`);
        else if (res?.via) errors.push(res.via);
      } catch (err) {
        errors.push(err?.message || String(err));
      }
    }
    this.lastError = errors.join(' | ');
    onStart?.();
    onEnd?.();
    this.bus?.emit('speech:failed', { errors });
    return { ok: false, via: 'none', errors };
  }

  _speakBrowser(text, preset, onStart, onEnd) {
    const synth = this.synth;
    const Utterance = this.win?.SpeechSynthesisUtterance;
    if (!synth?.speak || !Utterance) return Promise.resolve({ ok: false, via: 'unsupported' });
    return new Promise((resolve) => {
      try {
        const u = new Utterance(text);
        const cfg = VOICE_PRESETS[preset] || VOICE_PRESETS.deku;
        u.pitch = cfg.pitch;
        u.rate = cfg.rate;
        u.volume = 1;
        const voice = this.voice || this.pickVoice();
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang || 'en-US';
        }
        let settled = false;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          this.speaking = false;
          onEnd?.();
          resolve({ ok, via: 'browser' });
        };
        u.onstart = () => {
          this.speaking = true;
          onStart?.();
        };
        u.onend = () => done(true);
        u.onerror = () => done(false);
        synth.speak(u);
        // safety net: some engines never fire onend
        this._later(() => done(true), Math.min(30000, 900 + text.length * 90));
      } catch (err) {
        resolve({ ok: false, via: 'browser', error: err?.message });
      }
    });
  }

  async _speakPuter(text, onStart, onEnd) {
    const puter = this.win?.puter;
    if (!puter?.ai?.txt2speech) return { ok: false, via: 'puter-absent' };
    try {
      const audio = await puter.ai.txt2speech(text.slice(0, 2800), { provider: 'openai', voice: 'nova' });
      return this._playAudio(audio, 'puter', onStart, onEnd);
    } catch (err) {
      return { ok: false, via: 'puter', error: err?.message };
    }
  }

  async _speakPollinations(text, onStart, onEnd) {
    if (this.pool?.privateMode) return { ok: false, via: 'private-mode', error: 'private mode: audio download blocked' };
    try {
      const url = `https://gen.pollinations.ai/audio/${encodeURIComponent(text.slice(0, 280))}?voice=nova`;
      const Audio = this.win?.Audio;
      if (!Audio) return { ok: false, via: 'no-audio-element' };
      const audio = new Audio(url);
      return this._playAudio(audio, 'pollinations', onStart, onEnd);
    } catch (err) {
      return { ok: false, via: 'pollinations', error: err?.message };
    }
  }

  _playAudio(audio, via, onStart, onEnd) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        this.speaking = false;
        onEnd?.();
        resolve({ ok, via });
      };
      audio.onplay = () => {
        this.speaking = true;
        onStart?.();
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      try {
        const p = audio.play?.();
        this._audio = audio;
        if (p && typeof p.then === 'function') {
          p.then(() => this._later(() => finish(true), 45000)).catch(() => finish(false));
        } else {
          // Older engines (and headless/embedded webviews) return undefined from
          // play(): make sure we never hang waiting for an event that never comes.
          this._later(() => {
            if (settled) return;
            if (audio.paused === false) this._later(() => finish(true), 45000);
            else finish(false);
          }, 900);
        }
      } catch {
        finish(false);
      }
    });
  }

  stop() {
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    try {
      this.synth?.cancel?.();
    } catch {
      /* ignore */
    }
    try {
      this._audio?.pause?.();
    } catch {
      /* ignore */
    }
    this._audio = null;
    this.speaking = false;
    return this;
  }

  /* ─────────── listening ─────────── */

  get listenSupported() {
    return !!this.SpeechRecognition || !!this._canRecord();
  }

  _canRecord() {
    return !!(this.win?.navigator?.mediaDevices?.getUserMedia && this.win?.MediaRecorder);
  }

  /**
   * Listen once. Prefers free in-browser recognition, falls back to
   * MediaRecorder + keyless Whisper.
   * @returns {Promise<{ok:boolean,text:string,via:string,error?:string}>}
   */
  async listen({ lang = 'en-US', timeoutMs = 12000, onPartial = null } = {}) {
    this.listening = true;
    this.bus?.emit('speech:listening', { on: true });
    try {
      if (this.SpeechRecognition) {
        const res = await this._listenWeb(lang, timeoutMs, onPartial);
        if (res.ok) return res;
        this.lastError = res.error;
      }
      if (this._canRecord()) return await this._listenWhisper({ timeoutMs, onPartial });
      return { ok: false, text: '', via: this.SpeechRecognition ? 'webspeech' : 'none', error: this.lastError || 'no speech recognition available on this device' };
    } finally {
      this.listening = false;
      this.bus?.emit('speech:listening', { on: false });
    }
  }

  _listenWeb(lang, timeoutMs, onPartial) {
    return new Promise((resolve) => {
      let done = false;
      let recognition;
      const finish = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          recognition?.stop?.();
        } catch {
          /* ignore */
        }
        resolve(payload);
      };
      try {
        recognition = new this.SpeechRecognition();
      } catch (err) {
        return resolve({ ok: false, text: '', via: 'webspeech', error: err?.message });
      }
      this._recognition = recognition;
      recognition.lang = lang;
      recognition.interimResults = !!onPartial;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        let finalText = '';
        let interim = '';
        for (const result of event.results) {
          if (result.isFinal) finalText += result[0].transcript;
          else interim += result[0].transcript;
        }
        if (interim && onPartial) onPartial(interim);
        if (finalText.trim()) finish({ ok: true, text: finalText.trim(), via: 'webspeech' });
      };
      recognition.onerror = (event) => finish({ ok: false, text: '', via: 'webspeech', error: event?.error || 'recognition error' });
      recognition.onend = () => finish({ ok: false, text: '', via: 'webspeech', error: 'no speech detected' });
      const timer = setTimeout(() => finish({ ok: false, text: '', via: 'webspeech', error: 'timed out' }), timeoutMs);
      try {
        recognition.start();
      } catch (err) {
        finish({ ok: false, text: '', via: 'webspeech', error: err?.message });
      }
    });
  }

  async _listenWhisper({ timeoutMs = 20000 } = {}) {
    const nav = this.win?.navigator;
    let stream;
    try {
      stream = await nav.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      return { ok: false, text: '', via: 'whisper', error: err?.message || 'microphone denied' };
    }
    return new Promise((resolve) => {
      const recorder = new this.win.MediaRecorder(stream);
      this._recorder = recorder;
      const chunks = [];
      recorder.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const { text } = await this.pool.transcribe(blob);
          resolve({ ok: !!text, text, via: 'ovh-whisper' });
        } catch (err) {
          resolve({ ok: false, text: '', via: 'ovh-whisper', error: err?.message });
        }
      };
      try {
        recorder.start();
        setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), timeoutMs);
      } catch (err) {
        resolve({ ok: false, text: '', via: 'whisper', error: err?.message });
      }
    });
  }

  stopListening() {
    try {
      this._recognition?.stop?.();
    } catch {
      /* ignore */
    }
    try {
      this._recorder?.state === 'recording' && this._recorder.stop();
    } catch {
      /* ignore */
    }
    return this;
  }

  /** Short, cute spoken filler so pauses feel alive. */
  filler() {
    return pick(['Hmm…', 'Okay!', 'Let me see…', 'Oh! I know.', 'Wait, wait…']);
  }
}
