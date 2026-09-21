<div align="center">

# 🥦 Plus Ultra Puppet

**A tiny, cute, drag-anywhere AI puppet that lives on your phone screen, talks back, calls tools, watches over you, learns your habits — and costs nothing, ever.**

No account. No API key. No credit card. No server of your own.

</div>

---

## What is this?

Pip is a little hand-drawn puppet hero with the *personality* of Izuku "Deku" Midoriya —
earnest, kind, analytical, mutters while he thinks, never gives up, and shouts **PLUS ULTRA!**
when things go right.

He is a **Progressive Web App**: installable on Android or iPhone from the browser,
works offline, and talks to a pool of **free, keyless AI gateways** so you never pay a rupee.

| | |
|---|---|
| 🧍 **On your screen** | He sits at the bottom of the screen, blinks, glances around, mutters, stretches and cheers on his own. |
| 🖐 **Drag him** | Grab him, throw him across the screen, watch him bounce, squish, land and wobble. Double-tap = celebration. Long-press = his notebook. |
| 🗣 **Talk to him** | Hold the 🎙️ button and speak (free in-browser speech recognition, or keyless Whisper if the browser can't). He answers **out loud** with a cartoon-hero voice. |
| 🧠 **He thinks with free AI** | Pollinations · LLM7 · OVHcloud AI Endpoints · Kilo Gateway · Puter.js — plus optional free-tier keys (Groq, Gemini, OpenRouter…) and local bridges (Cactus **Needle 26M**, Ollama). |
| 🔧 **He calls tools** | 28 real gadgets: weather, web search, Wikipedia, dictionary, translation, maths, timers, reminders, notes, coin flip, dice, news, jokes, pep talks, device status, puppet control… |
| 👁 **He watches over you** | Optional presence camera — analysed **on-device at 32×24**, frame by frame. He only ever derives *"someone moved / someone's here"*. Frames are **never stored, never uploaded**, and there is a test that enforces it. |
| 📓 **He learns your habits** | When you wake, when you go quiet, which gadgets you reach for, your streaks, your topics — all in localStorage, all inspectable, all deletable. |
| 🎭 **You control his personality** | Four dials (energy / cheer / mutter / chatty) and three persona packs (Deku-ish, calm hero, hype hero). He never swears. Not once. |

---

## Quick start (30 seconds)

```bash
git clone <this repo> && cd Upload
npm run dev            # → http://0.0.0.0:5173
```

Open it on your phone (same Wi-Fi) or run it locally. Nothing else to configure —
Pip probes whichever free gateways are reachable and starts answering.

```bash
npm run icons          # regenerate assets/puppet/pip.svg + app icons from js/puppet-art.js
npm run lint           # static self-check: files, imports, DOM ids, SVG parts, tools, gateways
npm test               # unit tests
npm run test:system    # full-app tests in jsdom (boot, journeys, chaos)
npm run test:agents    # ⭐ TEN AGENTS SIMULTANEOUSLY — the whole fleet
```

**Install it like an app**

* **Android / Chrome:** open the page → ⋮ → *Add to Home screen* (or tap **Install now** in Pip's Settings).
* **iPhone / Safari:** Share → *Add to Home Screen*.
* **Real native shell:** `android/` contains a tiny WebView wrapper — open it in Android Studio and hit Run (see `android/README.md`). Or wrap any URL with `npx pwa-to-apk` / Bubblewrap.

Camera and microphone need **https or localhost** (a browser rule). Over LAN, use the tunnel/host
of your choice, or install the Android shell.

---

## The free AI brains (and why they are free)

Pip is not tied to one provider. `js/gateways.js` holds a catalog of OpenAI-compatible
endpoints that need **no key at all**, verified against the public
[freellmpool provider catalog](https://github.com/0xzr/freellmpool):

| Gateway | Base URL | Key? | Notes |
|---|---|---|---|
| Pollinations | `text.pollinations.ai/openai` | none | anonymous, per-IP limits, the default brain |
| LLM7 | `api.llm7.io/v1` | none (placeholder `unused`) | ~10 req/min anonymous |
| OVHcloud AI Endpoints | `oai.endpoints.kepler.ai.cloud.ovh.net/v1` | none | ~12 req/min; also **keyless Whisper** (speech→text) and **keyless BGE embeddings** |
| Kilo Gateway | `api.kilo.ai/api/gateway` | none | ~200 req/h per IP |
| OpenCode Zen | `opencode.ai/zen/v1` | none | promo routes, off by default until a probe succeeds |
| Puter.js | `js.puter.com/v2` | none | extra chat + cloud voices ("user-pays" model) |
| Groq / Gemini / OpenRouter / Mistral / Cerebras / HF | … | **optional free-tier key** | paste one in Settings → Brains to jump the queue |

Optional keys are stored **only in your device's localStorage** and never leave it except
as the `Authorization` header of that provider.

### How the pool behaves

* **Health memory** — each gateway keeps ok/fail counts, latency EWMA, cooldown timers and
  "blocked" flags, persisted across restarts.
* **Ordering** — keyless tier 1 first; your own keyed gateway jumps to the front.
* **Hedging** — if the favourite is slow (> ~5.5 s), the next free brain starts in parallel and
  the first good answer wins; the loser is aborted.
* **Failover** — it walks up to 4 gateways, then falls back to Pip's own offline brain.
* **Politeness** — a small `minIntervalMs` per gateway keeps him inside free-tier rate limits.
* **Private mode** — one switch: no network at all, forever. Gadgets that need the internet
  simply decline, sweetly.

### The tiny tool-calling model (your "needle2" ask)

Real on-device function calling is on the menu: `js/gateways.js` ships a **Needle bridge**
(`needle --serve`, Cactus Compute's 26 M-parameter tool-calling model — *"a single 8–29 MB
binary"*, Apache-2.0) and an **Ollama bridge**. Point Pip at either in Settings → Brains and
tool calls run entirely on your own hardware.

When those aren't running, Pip uses **`js/nlu.js` — "needle-lite"**: a distilled,
dependency-free intent router + slot filler that turns

> "remind me to stretch in 20 minutes"

into

> `{ name: "set_reminder", arguments: { text: "stretch", at: 1789… } }`

in well under a millisecond, offline, deterministically, and it is heavily unit-tested
(19 routing cases + slot-filling + edge cases). Same interface, no Python required.

---

## Pip's gadgets (28 tools, all free)

| Group | Tools |
|---|---|
| Time & sky | `get_time` `get_date` `get_weather` |
| Knowledge | `web_search` (DuckDuckGo → Wikipedia fallback) `wikipedia` `define` `translate` `calculate` |
| Life admin | `set_timer` `set_reminder` `remember` `recall` `forget` `add_note` `list_notes` |
| Self-aware | `habit_report` `who_am_i` `device_status` `self_test` |
| Play | `coin_flip` `roll_dice` `random_fact` `tell_joke` `motivate` |
| Body | `emote` `sleep_puppet` `wake_puppet` |
| News | `tech_news` (Hacker News front page) |

Every tool returns `{ ok, speak, data?, error? }` and **never throws** — a broken gadget makes
Pip apologise, not crash.

---

## Architecture

```
index.html ── css/{reset,app,puppet,panel}.css ── js/main.js  (the only DOM-aware file)
                                                      │
     ┌────────────────────────────────────────────────┴─────────────────────────────┐
     │                                                                              │
  js/core/bus.js      event bus (brain ↔ puppet ↔ UI ↔ tests)
  js/core/util.js     pure helpers (time parsing, maths, stats)  ← fully unit tested
  js/core/store.js    namespaced localStorage wrapper (quota-safe, injectable)
     │
  js/gateways.js      free-gateway pool: health, hedging, failover, embeddings, Whisper, Needle bridge
  js/nlu.js           needle-lite: local intent routing + slot filling
  js/tools.js         the 28 gadgets + Toolkit sandbox
  js/brain.js         one full turn: route → tool → prompt → answer → mood
  js/personality.js   Deku-inspired persona packs, system prompt, offline replies, profanity scrub
  js/memory.js        the hero notebook (embeddings + lexical recall, profile extraction)
  js/habits.js        on-device habit statistics, streaks, quiet hours, nudges
  js/perception.js    presence camera (32×24, on-device), motion sensors, battery/network/geo
  js/speech.js        speaking chain + listening chain, voice presets, mute handling
  js/scheduler.js     timers, reminders, follow-up nags
  js/puppet-art.js    Pip's body — original hand-written SVG (single source of truth for the icons)
  js/puppet.js        animation state machine, drag physics, gestures, idle life
```

**Privacy model**

* Everything persists in `localStorage` under the `pip.` prefix. Export / import / wipe are one tap.
* The camera stream never leaves `js/perception.js`. It is downscaled to 32×24, reduced to luma
  and a coarse skin-tone score, then discarded. `perception.privacyInvariants()` asserts
  `framesStored === 0 && uploads === 0` — and the chaos system test asserts it after
  a full session of watching, talking and dragging.
* Private mode hard-disables every network call including the offline-capable tools.

---

## Testing: unit + system + **10 agents at once**

210 tests currently pass. Nothing in the repo is untested hand-waving:

```
tests/helpers.mjs          jsdom harness, fake clock, fake fetch, fake phone (battery/geo/camera/motion)
tests/unit/               14 suites — pure logic, no network
  util · bus-store · gateways · nlu · tools · personality · memory ·
  habits · perception · speech · brain · scheduler · puppet · puppet-art
tests/system/              3 suites — the real app inside jsdom
  boot.test.js        cold boot, onboarding, first conversation, self-test, reload, sheets
  journeys.test.js    hold-to-talk, drag & fling, timers, habits, presence, dials, private mode
  resilience.test.js  every gateway down, garbage responses, airplane mode, hostile storage,
                      denied camera/mic, 30 rapid messages, unicode, shutdown/reboot
tests/run-agents.mjs  ⭐ spawns TEN independent worker processes, shards the suites by weight,
                      prints a fleet table, writes artifacts/agents-report.json, fails the build
                      if any agent fails
```

```bash
npm run test:agents
```

```
  agent  name              suites  tests  ok   fail   time
  ────────────────────────────────────────────────────────────────
  ✓    1  unit-core            2     19    19     0   12.1s
  ✓    2  unit-ai              2     21    21     0   15.6s
  …
  ✓   10  sentinel            1      8     8     0    0.7s
  ────────────────────────────────────────────────────────────────
  PASSED  210 passing, 0 failing across 10 agents in 53.0s wall clock
```

`npm run lint` additionally proves, statically, that every file referenced by
`index.html`/`manifest`/`sw.js` exists, every ES import resolves, every `getElementById`
the code uses exists in the HTML, every SVG part `css/puppet.css` animates exists in
`js/puppet-art.js`, every tool is well-formed, and there is at least the expected number of
keyless gateways.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | zero-dependency static server on `0.0.0.0:5173` (phone-friendly) |
| `npm test` | unit suites |
| `npm run test:system` | system suites |
| `npm run test:agents` | **10 parallel agents, the whole fleet** |
| `npm run lint` | static self-check |
| `npm run icons` | rebuild `assets/puppet/pip.svg` + app icons (pure JS rasteriser, no deps) |

Dev dependency: `jsdom` (tests only). The app itself ships **zero** runtime dependencies.

---

## FAQ

**Is this really free?** Yes for the AI: keyless gateways + free public APIs for weather, search,
dictionary, translation and news. Your phone's data plan is the only bill.

**Is Pip the real Deku?** No. He is an original fan-made puppet with a Deku-*inspired* personality
(earnestness, muttering, notebook, never giving up, "Plus Ultra"). No MHA artwork, character
design or dialogue is bundled — `js/puppet-art.js` is hand-written SVG of a little green hero
with freckles and an antenna.

**Does he listen all the time?** Only when you hold the mic button — or if you explicitly switch on
*"Auto-wake on voice"*, which keeps the free in-browser recognizer running locally and only reacts
to "hey Pip".

**Does the camera record me?** No. See the privacy model above; the code and the tests both say so.

**Will the free gateways always work?** They change without notice. That is exactly why there are
six of them, a health tracker, hedging, failover, optional free-tier keys, local bridges — and an
offline brain that always answers in character.

---

MIT licensed. Go be a hero. **Plus Ultra!** 🥦
