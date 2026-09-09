import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolveRequestPath } from '../scripts/serve.mjs';

const root = path.resolve('dist');

test('development server contains decoded requests inside dist', () => {
  assert.equal(resolveRequestPath(root, '/tools/../package.json'), null);
  assert.equal(resolveRequestPath(root, '/tools/%2e%2e/package.json'), null);
  assert.equal(resolveRequestPath(root, '/tools/cyberchef/'), path.join(root, 'cyberchef'));
});

test('generated routes validate destinations and use an honest user-controlled interstitial', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  const route = await readFile('dist/swagger-ui/index.html', 'utf8');
  assert.doesNotMatch(route, /http-equiv="refresh"|location\.replace/);
  assert.match(route, /<meta name="robots" content="noindex,follow">/);
  assert.match(route, /Petstore demonstration/);
  assert.match(route, /outside Tool Deck/);
});
