import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PUPPET_SVG, ICON_SVG, PUPPET_PARTS } from '../../js/puppet-art.js';
import { trackDom, closeAllDoms } from '../helpers.mjs';

after(closeAllDoms);

test('the puppet art is inline SVG with no scripts or events', () => {
  assert.match(PUPPET_SVG.trim(), /^<svg/);
  assert.match(ICON_SVG.trim(), /^<svg/);
  for (const svg of [PUPPET_SVG, ICON_SVG]) {
    assert.ok(!/<script/i.test(svg));
    assert.ok(!/\son\w+\s*=/i.test(svg), 'no inline event handlers in artwork');
    assert.ok(!/javascript:/i.test(svg));
  }
});

test('every animation part the CSS needs exists exactly once', () => {
  for (const part of PUPPET_PARTS) {
    const matches = PUPPET_SVG.match(new RegExp(`class="[^"]*\\b${part}\\b`, 'g')) || [];
    assert.ok(matches.length >= 1, `missing part .${part}`);
  }
  for (const pair of ['leg--l', 'leg--r', 'arm--l', 'arm--r', 'brow--l', 'brow--r']) {
    assert.ok(PUPPET_SVG.includes(pair), `missing ${pair}`);
  }
  assert.equal((PUPPET_SVG.match(/class="eyelid"/g) || []).length, 2, 'two eyelids for blinking');
  assert.equal((PUPPET_SVG.match(/class="pupil"/g) || []).length, 2, 'two pupils for looking around');
});

test('gradient ids are unique and the art is self-contained', () => {
  const ids = [...PUPPET_SVG.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(PUPPET_SVG.includes(`url(#${id})`), `${id} is defined but unused`);
  assert.ok(!/xlink:href|href="#(?!pip)/.test(PUPPET_SVG), 'no external references');
});

test('the art parses as real SVG in a DOM and can be animated by attribute', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = trackDom(new JSDOM(`<!doctype html><div id="host">${PUPPET_SVG}</div>`, { pretendToBeVisual: true }));
  const svg = dom.window.document.querySelector('.puppet-svg');
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(dom.window.document.querySelectorAll('.head-group').length, 1);
  assert.equal(dom.window.document.querySelectorAll('.leg').length, 2);
  assert.equal(dom.window.document.querySelectorAll('.arm').length, 2);
  assert.ok(svg.querySelector('.mouth'));
  assert.ok(svg.querySelector('.shadow'));
  assert.ok(svg.querySelector('.aura'));
  assert.ok(svg.querySelector('.mutter'));
  assert.ok(svg.querySelector('.zzz'));
  assert.ok(svg.querySelector('.sparkle'));
  assert.ok(svg.querySelector('.cheek'));
  assert.ok(svg.querySelector('.antenna'));
  assert.ok(svg.querySelector('.costume-accent'));
  // parts carry their own transform origin so CSS transforms work everywhere
  assert.match(svg.querySelector('.body-group').getAttribute('style') || '', /transform-origin/);
  assert.match(svg.querySelector('.mutter').getAttribute('style') || '', /transform-origin/);

  svg.dataset.anim = 'talk';
  svg.dataset.expr = 'blush';
  assert.equal(svg.getAttribute('data-anim'), 'talk');
  assert.equal(svg.getAttribute('data-expr'), 'blush');
});

test('the icon art is a valid standalone document', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = trackDom(new JSDOM(`<!doctype html><body>${ICON_SVG}`));
  const svg = dom.window.document.querySelector('svg');
  assert.ok(svg);
  assert.equal(svg.getAttribute('viewBox'), '0 0 512 512');
  assert.ok(svg.querySelectorAll('ellipse').length >= 5);
  assert.ok(svg.textContent.trim() === '', 'the icon is pure shapes (no text nodes)');
});

test('the art has no copyrighted character likeness markers (fan-made puppet)', () => {
  const text = PUPPET_SVG + ICON_SVG;
  assert.ok(!/all.?might|bakugo|uraraka|midoriya|shigaraki/i.test(text), 'only original shapes and colours');
  assert.ok(text.includes('Pip the puppet hero'));
});
