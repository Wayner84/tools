import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const updateWorkflow = await readFile('.github/workflows/update-tools.yml', 'utf8');

test('metadata workflow explicitly dispatches deployment after its bot push', () => {
  assert.match(updateWorkflow, /actions:\s*write/);
  assert.match(updateWorkflow, /gh workflow run pages\.yml --ref main/);
  assert.match(updateWorkflow, /npm run build/);
});
