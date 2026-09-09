import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { loadFavourites, loadCatalogue, matchesTool, renderToolCard, restoreRenderedFocus, saveFavourites, validateCatalogue } from '../src/app.js';

const tools = JSON.parse(await readFile('data/tools.json', 'utf8'));

test('manifest has unique valid tools', () => {
  assert.ok(tools.length >= 21);
  assert.equal(new Set(tools.map((tool) => tool.slug)).size, tools.length);
  for (const tool of tools) {
    assert.match(tool.slug, /^[a-z0-9-]+$/);
    assert.match(tool.launchUrl, /^https:\/\//);
    assert.ok(tool.name && tool.description && tool.category && tool.hosting && tool.license);
    assert.ok(tool.destinationType && tool.operator && tool.dataBoundary && tool.functionalCheck);
    assert.ok(Array.isArray(tool.aliases));
  }
});

test('developer demos and references are labelled as their actual destinations', () => {
  const expected = {
    'swagger-ui': ['Swagger Petstore demo', 'demo'],
    monaco: ['Monaco Editor playground', 'playground'],
    codemirror: ['CodeMirror playground', 'playground'],
    revealjs: ['Reveal.js framework demo', 'demo'],
    graphviz: ['Graphviz WASM documentation', 'documentation'],
    browserpdf: ['BrowserPDF image-to-PDF service', 'external service'],
  };
  for (const [slug, [name, destinationType]] of Object.entries(expected)) {
    const tool = tools.find((entry) => entry.slug === slug);
    assert.equal(tool.name, name);
    assert.equal(tool.destinationType, destinationType);
  }
});

test('drawio points to Wayne deployment', () => {
  assert.equal(tools.find((tool) => tool.slug === 'drawio').launchUrl, 'https://wayner84.github.io/drawio/src/main/webapp/');
});

test('build emits every stable route', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  for (const tool of tools) await access(`dist/${tool.slug}/index.html`);
  await access('dist/index.html');
  await access('dist/data/tools.json');
});

test('favourites degrade to an empty set when storage is denied or corrupt', () => {
  assert.deepEqual([...loadFavourites({ getItem: () => { throw new Error('denied'); } })], []);
  assert.deepEqual([...loadFavourites({ getItem: () => '{bad json' })], []);
  assert.deepEqual([...loadFavourites({ getItem: () => '{"slug":true}' })], []);
  assert.deepEqual([...loadFavourites({ getItem: () => '["cyberchef",42,"bad slug"]' })], ['cyberchef']);
});

test('catalogue loading rejects invalid data and gives a useful error', async () => {
  await assert.rejects(() => loadCatalogue(async () => ({ ok: false, status: 503 })), /catalogue.*503/i);
  await assert.rejects(() => loadCatalogue(async () => ({ ok: true, json: async () => ({ nope: true }) })), /catalogue data/i);
});

test('saving favourites is optional when storage is denied', () => {
  assert.equal(saveFavourites(new Set(['cyberchef']), { setItem: () => { throw new Error('denied'); } }), false);
});

test('accessing denied global storage cannot abort portal helpers', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new DOMException('denied', 'SecurityError'); } });
  try {
    assert.deepEqual([...loadFavourites()], []);
    assert.equal(saveFavourites(new Set(['cyberchef'])), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('catalogue validation rejects unsafe records and duplicate routes', () => {
  const valid = structuredClone(tools[0]);
  assert.throws(() => validateCatalogue([{ ...valid, sourceUrl: 'javascript:alert(1)' }]), /sourceUrl/i);
  assert.throws(() => validateCatalogue([{ ...valid, slug: '../outside' }]), /slug/i);
  assert.throws(() => validateCatalogue([valid, structuredClone(valid)]), /duplicate/i);
  assert.throws(() => validateCatalogue([{ ...valid, aliases: ['safe', 42] }]), /aliases/i);
});

test('tool cards expose named favourite state and honest destination details', () => {
  const tool = {
    slug: 'swagger-ui', name: 'Swagger Petstore demo', description: 'Demo API documentation viewer.',
    category: 'API & code', destinationType: 'demo', hosting: 'official-hosted',
    dataBoundary: 'Requests may contact APIs outside Tool Deck.', sourceUrl: 'https://example.test/source',
  };
  const html = renderToolCard(tool, 0, new Set());
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /Add Swagger Petstore demo to favourites/);
  assert.match(html, /Open demo/);
  assert.match(html, /UPSTREAM-HOSTED/);
  assert.match(html, /Requests may contact APIs outside Tool Deck/);
  assert.doesNotMatch(renderToolCard({ ...tool, sourceUrl: 'javascript:alert(1)' }, 0, new Set()), /javascript:/);
});

test('focus falls back to the favourites control when a removed card disappears', () => {
  let fallbackFocused = false;
  const grid = { querySelectorAll: () => [] };
  restoreRenderedFocus(grid, { focus: () => { fallbackFocused = true; } }, 'cyberchef');
  assert.equal(fallbackFocused, true);
});

test('search includes curated task aliases', () => {
  assert.equal(matchesTool({ name: 'IT-Tools', description: '', category: 'Developer', aliases: ['QR code', 'subnet calculator'] }, 'subnet'), true);
  assert.equal(matchesTool({ name: 'IT-Tools', description: '', category: 'Developer', aliases: ['QR code'] }, 'CAD'), false);
});

test('portal template includes the catalogue recovery control required by the runtime', async () => {
  const html = await readFile('src/index.html', 'utf8');
  assert.match(html, /<button\b[^>]*id="retry"[^>]*hidden[^>]*>[^<]*Retry[^<]*<\/button>/i);
  assert.match(html, /<span\b[^>]*id="count"[^>]*(?:role="status"|aria-live="polite")[^>]*>/i);
});

test('single-column cards can shrink to the narrow viewport', async () => {
  const css = await readFile('src/styles.css', 'utf8');
  assert.match(css, /\.card\{[^}]*min-width:\s*0/);
});
