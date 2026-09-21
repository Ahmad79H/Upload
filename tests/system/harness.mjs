/**
 * System-test harness: boots the REAL app (js/main.js, real modules, real DOM)
 * inside jsdom with only the network stubbed, so these tests exercise the same
 * path a phone does.
 */
import { makeDom, installGlobals, fetchStub, jsonResponse, closeAllDoms, settle } from '../helpers.mjs';

let bootCounter = 0;

/** A fetch stub that behaves like the free gateways + free tool APIs. */
export function appNetwork({ reply = 'Plus Ultra, partner!', failAll = false, malformed = false, chatDelayMs = 0, seen = [] } = {}) {
  return fetchStub(async (url) => {
    seen.push(url);
    if (failAll) throw new TypeError('Failed to fetch');
    if (chatDelayMs) await new Promise((r) => setTimeout(r, chatDelayMs));
    if (/chat\/completions$/.test(url)) {
      if (malformed) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }, text: async () => '<html>proxy error</html>' };
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: reply } }] });
    }
    if (/open-meteo\.com\/v1\/forecast/.test(url)) {
      return jsonResponse({
        current: { temperature_2m: 33.2, weather_code: 1, wind_speed_10m: 8, relative_humidity_2m: 40 },
        daily: { temperature_2m_max: [36], temperature_2m_min: [24], precipitation_probability_max: [10] },
      });
    }
    if (/geocoding-api/.test(url)) return jsonResponse({ results: [{ name: 'Lahore', country: 'Pakistan', latitude: 31.5, longitude: 74.3 }] });
    if (/duckduckgo/.test(url)) return jsonResponse({ AbstractText: 'Deku is a hero who never gives up.', AbstractURL: 'https://example.org/deku' });
    if (/wikipedia/.test(url)) return jsonResponse({ extract: 'Izuku Midoriya studies at U.A. High.', pages: [{ key: 'Deku' }], content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Deku' } } });
    if (/dictionaryapi/.test(url)) return jsonResponse([{ meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a puppet hero' }] }] }]);
    if (/mymemory/.test(url)) return jsonResponse({ responseData: { translatedText: 'ہیلو' } });
    if (/hn\.algolia/.test(url)) return jsonResponse({ hits: [{ title: 'Free AI everywhere', points: 100 }] });
    if (/embeddings/.test(url)) return jsonResponse({ data: [{ embedding: new Array(256).fill(0.1) }, { embedding: new Array(256).fill(0.2) }] });
    if (/audio\/transcriptions/.test(url)) return jsonResponse({ text: 'what is the weather in lahore' });
    return jsonResponse({}, { status: 404 });
  });
}

/** A fake SpeechRecognition that returns a scripted phrase. */
export function fakeRecognition(phrase = 'hello pip') {
  return class FakeRecognition {
    constructor() {
      this.started = 0;
    }
    start() {
      this.started++;
      setTimeout(() => {
        this.onresult?.({
          results: [Object.assign([{ transcript: phrase }], { isFinal: true })],
        });
      }, 2);
    }
    stop() {}
  };
}

/**
 * Boot a completely fresh copy of the app (new module instances, new DOM).
 * @param {{network?: object, seed?: object, settings?: object, beforeImport?: (win) => void}} opts
 */
export async function bootApp({ network = appNetwork(), seed = {}, beforeImport = null, withRecognition = null, mute = true } = {}) {
  const cacheBust = ++bootCounter;
  const dom = await makeDom();
  const win = installGlobals(dom.window);
  win.__PIP_TEST__ = true;
  for (const [key, value] of Object.entries(seed)) win.localStorage.setItem(`pip.${key}`, JSON.stringify(value));
  globalThis.fetch = network;
  if (withRecognition) win.SpeechRecognition = withRecognition;
  beforeImport?.(win);
  const mod = await import(`../../js/main.js?boot=${cacheBust}`);
  await mod.__pip.boot();
  // System tests drive the pipeline, not the audio device, so voice is muted by
  // default (the muted path is a documented code path). Pass mute:false to test TTS.
  if (mute) mod.__pip.speech.setEnabled(false);
  await settle(20);
  return { dom, win, mod, pip: mod.__pip, network };
}

/** Complete onboarding the way a user does. */
export async function onboard(app, { name = 'Ahmad', persona = 'deku', mute = true } = {}) {
  const doc = app.win.document;
  doc.getElementById('ob-name').value = name;
  doc.getElementById('ob-persona').value = persona;
  doc.getElementById('ob-start').dispatchEvent(new app.win.Event('click'));
  await settle(30);
  if (mute) app.pip.speech.setEnabled(false);
  return app;
}

export async function shutdownApp(app) {
  try {
    app.mod.shutdown();
  } catch {
    /* ignore */
  }
  await settle(5);
}

export { closeAllDoms, settle, jsonResponse, fetchStub };
