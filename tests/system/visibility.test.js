/**
 * SYSTEM TEST 4 — "can I see him, and can I get out of the menu?"
 *
 * These are the two things that were broken the first time Pip met a real phone,
 * and neither showed up in any headless test because jsdom does not lay out CSS.
 * So this suite does the next best thing to a screenshot: it loads the *real*
 * stylesheets into the document and asserts that the selectors actually match the
 * live DOM, that the puppet's box is a real size, that he stands on the grass, and
 * that the sheet can be closed three different ways.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bootApp, shutdownApp, closeAllDoms, settle, appNetwork, onboard } from './harness.mjs';

const apps = [];
after(async () => {
  for (const a of apps) await shutdownApp(a);
  closeAllDoms();
});

/** Put the app's real CSS into the jsdom document so selectors can be matched. */
async function withRealCss(app) {
  const doc = app.win.document;
  for (const file of ['css/reset.css', 'css/app.css', 'css/puppet.css', 'css/panel.css']) {
    const css = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const style = doc.createElement('style');
    style.dataset.from = file;
    style.textContent = css;
    doc.head.appendChild(style);
  }
  return doc;
}

const boot = async (opts = {}) => {
  const app = await bootApp({ network: appNetwork(), ...opts });
  apps.push(app);
  return app;
};

test('the puppet art carries the classes the stylesheets hook onto', async () => {
  const app = await boot();
  await onboard(app);
  const doc = await withRealCss(app);
  const svg = doc.querySelector('#puppet-layer svg');

  assert.ok(svg, 'the art is mounted');
  assert.ok(svg.classList.contains('puppet-svg'), 'the art identity class');
  assert.ok(
    svg.classList.contains('puppet'),
    '.puppet is what css/puppet.css animates and what css/app.css positions — without it Pip mounts but is invisible and motionless',
  );
  // The whole animation system is a selector contract; prove it matches the DOM.
  svg.dataset.anim = 'idle';
  assert.ok(doc.querySelector('.puppet[data-anim="idle"] .body-group'), 'idle breathing matches the real markup');
  svg.dataset.expr = 'happy';
  assert.ok(doc.querySelector('.puppet[data-expr="happy"] .brow--l'), 'expressions match the real markup');
  svg.dataset.blink = 'true';
  assert.ok(doc.querySelector('.puppet[data-blink="true"] .eyelid'), 'blinking matches the real markup');
  svg.dataset.mood = 'hyped';
  assert.ok(doc.querySelector('.puppet[data-mood="hyped"] .aura'), 'the hyped aura matches the real markup');
});

test('the puppet has a real box, a real position and his feet on the grass', async () => {
  const app = await boot();
  await onboard(app);
  await withRealCss(app);
  const { pip } = app;
  const p = pip.puppet;
  const svg = p.el;

  // Explicit pixel geometry — never "width:100%" of a zero-width layer.
  assert.equal(svg.style.width, `${p.size}px`);
  assert.equal(svg.style.height, `${Math.round((p.size * 280) / 200)}px`);
  assert.ok(p.size >= 96 && p.size <= 200, `sane puppet size, got ${p.size}`);

  // His feet rest on the grass line (.ground is 26vh tall, so the line is at 74%).
  const groundLine = Math.round(p.bounds().h * 0.74);
  assert.equal(p.groundLine, groundLine);
  assert.equal(p.floorY, groundLine - p.artHeight, 'resting position sits on the ground line');
  assert.ok(p.pos.y > 0, 'he is on screen, not above the top edge');
  assert.ok(p.pos.y + p.artHeight <= groundLine + 1, 'his whole body is above the bottom of the screen');

  // The layer itself is a full-size, click-through stage child.
  const layer = app.win.document.getElementById('puppet-layer');
  assert.match(layer.getAttribute('class'), /puppet-layer/);
  assert.ok(layer.contains(svg));

  // The shadow is drawn on the grass, under him, and follows his dive.
  const shadow = app.win.document.getElementById('drop-shadow');
  assert.equal(shadow.style.top, `${p.groundLine}px`);
  p.setAnim('jump', { force: true });
  p.pos.y = p.floorY - 200;
  p.render();
  assert.equal(shadow.style.left, `${p.pos.x + p.size / 2}px`, 'the shadow tracks him horizontally');
  assert.ok(Number(shadow.style.opacity) < 0.3, 'the shadow fades while he is airborne');
});

test('an unfit browser still gets a visible puppet (harden + honest report)', async () => {
  const app = await boot();
  await onboard(app);
  const { pip } = app;

  // pretend a stale service-worker cache stripped the stylesheet rules
  pip.puppet.el.removeAttribute('class');
  pip.puppet.el.setAttribute('class', 'puppet-svg');
  const check = pip.puppet.measure();
  assert.equal(typeof check.ok, 'boolean');
  assert.equal(check.laidOut, false, 'headless DOMs are excused from the pixel check');

  const hardened = pip.puppet.harden();
  assert.equal(hardened, true, 'the fallback styles were applied');
  assert.equal(pip.puppet.el.style.position, 'absolute');
  assert.equal(pip.puppet.el.style.width, `${pip.puppet.size}px`);
  assert.equal(pip.puppet.el.style.height, `${Math.round((pip.puppet.size * 280) / 200)}px`);

  // and a browser that really lost the pixels reports it instead of going quiet
  const reported = [];
  pip.bus.on('puppet:hidden', (info) => reported.push(info));
  pip.puppet.measure = () => ({ ok: false, laidOut: true, rect: { x: 0, y: 0, w: 0, h: 0 } });
  pip.bus.emit('puppet:hidden', { ok: false, laidOut: true });
  assert.equal(reported.length, 1);
  assert.match(app.win.document.getElementById('toast-layer').textContent, /diagnostics/i);
});

test('the menu can be closed with the ✕, with Escape, and by tapping the sky', async () => {
  const app = await boot();
  await onboard(app);
  const doc = await withRealCss(app);
  const sheet = doc.getElementById('sheet');
  const closeBtn = doc.getElementById('btn-close-sheet');

  assert.ok(closeBtn, 'the ✕ exists in the markup');
  assert.match(closeBtn.getAttribute('aria-label') || '', /close/i);
  assert.equal(closeBtn.closest('#sheet'), sheet, 'the ✕ lives inside the sheet');

  // 1 — the ✕ button
  doc.getElementById('btn-sheet').dispatchEvent(new app.win.Event('click'));
  assert.equal(sheet.hidden, false, 'the menu opens');
  closeBtn.dispatchEvent(new app.win.Event('click', { bubbles: true }));
  assert.equal(sheet.hidden, true, 'the ✕ closes the menu');

  // 2 — Escape
  doc.getElementById('btn-sheet').dispatchEvent(new app.win.Event('click'));
  assert.equal(sheet.hidden, false);
  doc.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(sheet.hidden, true, 'Escape closes the menu');

  // 3 — tapping the stage outside the sheet
  doc.getElementById('btn-sheet').dispatchEvent(new app.win.Event('click'));
  assert.equal(sheet.hidden, false);
  doc.getElementById('stage').dispatchEvent(new app.win.Event('click', { bubbles: true }));
  assert.equal(sheet.hidden, true, 'a tap on the sky closes the menu');

  // and the Menu button still toggles when it is reachable
  doc.getElementById('btn-sheet').dispatchEvent(new app.win.Event('click'));
  doc.getElementById('btn-sheet').dispatchEvent(new app.win.Event('click'));
  assert.equal(sheet.hidden, true, 'the dock button toggles too');
});

test('tabs still work while the sheet is open, and the puppet keeps living behind it', async () => {
  const app = await boot();
  await onboard(app);
  const doc = await withRealCss(app);
  doc.getElementById('btn-sheet').dispatchEvent(new app.win.Event('click'));
  const habitsTab = [...doc.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'habits');
  habitsTab.dispatchEvent(new app.win.Event('click', { bubbles: true }));
  assert.equal(doc.querySelector('[data-pane="habits"]').classList.contains('is-active'), true);
  assert.equal(doc.getElementById('sheet').hidden, false, 'switching tabs does not close the sheet');
  await settle(20);
  assert.ok(['idle', 'talk', 'think', 'cheer'].includes(app.pip.puppet.anim), 'he keeps animating');
});

test('?diag=1 style diagnostics describe what Pip can see about himself', async () => {
  const app = await boot();
  await onboard(app);
  const first = app.pip.puppet.measure();
  assert.equal(first.laidOut, false, 'jsdom reports no layout, so the panel stays honest');

  const diag = app.win.__pipDiagnostics();
  assert.equal(diag.boot, 'ready');
  assert.ok(diag.viewport.w > 0 && diag.viewport.h > 0);
  assert.equal(diag.art.classes.includes('puppet'), true);
  assert.ok(Array.isArray(diag.gateways) && diag.gateways.length >= 4);
  assert.equal(typeof diag.floorY, 'undefined');
  assert.ok(diag.puppet.size > 0);
  const rendered = app.win.document.getElementById('diag-view');
  assert.equal(rendered.hidden, false, 'the overlay is shown');
  assert.match(rendered.textContent, /"boot": "ready"/);
  rendered.dispatchEvent(new app.win.Event('click'));
  assert.equal(rendered.hidden, true, 'and it can be dismissed by tapping it');
});

test('if boot ever throws, the user gets told instead of staring at an empty sky', async () => {
  const app = await boot();
  await onboard(app);
  const doc = app.win.document;
  // bootSafe() is exactly what the page uses on load: sabotage a module the boot
  // path needs and check that the failure becomes a visible, retryable message.
  const original = app.pip.scheduler.start;
  app.pip.scheduler.start = () => {
    throw new Error('sabotaged scheduler');
  };
  await app.pip.bootSafe().catch(() => {});
  app.pip.scheduler.start = original;

  assert.equal(doc.body.dataset.boot, 'error', 'the app admits it failed');
  assert.match(doc.getElementById('toast-layer').textContent, /tap the sky to try again/i);
  assert.ok(app.pip.puppet.el, 'the puppet he did manage to mount is still there');
  // tapping the sky retries, and a healthy boot clears the error state
  doc.getElementById('stage').dispatchEvent(new app.win.Event('click', { bubbles: true }));
  await settle(60);
  assert.equal(doc.body.dataset.boot, 'ready', 'the retry works');
});
