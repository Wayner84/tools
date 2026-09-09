import test from 'node:test';
import assert from 'node:assert/strict';
import { updateToolMetadata } from '../scripts/update-tools.mjs';

const original = {
  slug: 'example', sourceRepo: 'owner/repo', defaultBranch: 'main',
  tracked: { kind: 'release', value: 'v1.0.0', publishedAt: '2026-01-01T00:00:00Z' },
};

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('metadata update preserves valid prior data when release lookup has a transient failure', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/owner/repo')) return response(200, { default_branch: 'main' });
    return response(503);
  };
  const [updated] = await updateToolMetadata([structuredClone(original)], { fetcher, attempts: 2, wait: async () => {} });
  assert.deepEqual(updated.tracked, original.tracked);
  assert.equal(calls.filter((url) => url.endsWith('/releases/latest')).length, 2);
});

test('metadata update falls back to a validated commit only when no release exists', async () => {
  const fetcher = async (url) => {
    if (url.endsWith('/owner/repo')) return response(200, { default_branch: 'main' });
    if (url.endsWith('/releases/latest')) return response(404);
    return response(200, { sha: 'a'.repeat(40), commit: { committer: { date: '2026-02-02T00:00:00Z' } } });
  };
  const [updated] = await updateToolMetadata([structuredClone(original)], { fetcher, wait: async () => {} });
  assert.deepEqual(updated.tracked, { kind: 'commit', value: 'a'.repeat(40), publishedAt: '2026-02-02T00:00:00Z' });
});

test('metadata update retries a transient network rejection', async () => {
  let calls = 0;
  const fetcher = async (url) => {
    calls += 1;
    if (calls === 1) throw new TypeError('network down');
    if (url.endsWith('/owner/repo')) return response(200, { default_branch: 'main' });
    return response(200, { tag_name: 'v2.0.0', published_at: '2026-03-03T00:00:00Z' });
  };
  const [updated] = await updateToolMetadata([structuredClone(original)], { fetcher, attempts: 3, wait: async () => {} });
  assert.equal(calls, 3);
  assert.equal(updated.tracked.value, 'v2.0.0');
});

test('metadata update rethrows the last network error after retry exhaustion', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new TypeError(`network down ${calls}`); };
  await assert.rejects(
    () => updateToolMetadata([structuredClone(original)], { fetcher, attempts: 3, wait: async () => {} }),
    /network down 3/
  );
  assert.equal(calls, 3);
});

test('metadata update never writes malformed commit metadata', async () => {
  const fetcher = async (url) => {
    if (url.endsWith('/owner/repo')) return response(200, { default_branch: 'main' });
    if (url.endsWith('/releases/latest')) return response(404);
    return response(403, { message: 'rate limited' });
  };
  await assert.rejects(() => updateToolMetadata([structuredClone(original)], { fetcher, attempts: 1, wait: async () => {} }), /commit lookup.*403/i);
});
