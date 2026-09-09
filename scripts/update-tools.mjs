import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const file = 'data/tools.json';
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wayne-tools-updater',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithRetry(url, { fetcher, attempts, wait }) {
  let response;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetcher(url, { headers });
      if (response.ok || response.status === 404 || (response.status < 500 && response.status !== 429)) return response;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await wait(250 * (2 ** (attempt - 1)));
  }
  if (lastError) throw lastError;
  return response;
}

export async function updateToolMetadata(tools, options = {}) {
  const fetcher = options.fetcher || globalThis.fetch;
  const attempts = options.attempts || 3;
  const wait = options.wait || delay;

  for (const tool of tools) {
    if (!tool.sourceRepo) continue;
    const api = `https://api.github.com/repos/${tool.sourceRepo}`;
    const repoResponse = await fetchWithRetry(api, { fetcher, attempts, wait });
    if (!repoResponse.ok) throw new Error(`${tool.sourceRepo}: repository lookup failed (${repoResponse.status})`);
    const repo = await repoResponse.json();
    if (typeof repo.default_branch !== 'string' || !repo.default_branch) throw new Error(`${tool.sourceRepo}: invalid repository metadata`);

    const releaseResponse = await fetchWithRetry(`${api}/releases/latest`, { fetcher, attempts, wait });
    if (releaseResponse.ok) {
      const release = await releaseResponse.json();
      if (typeof release.tag_name !== 'string' || !release.tag_name) throw new Error(`${tool.sourceRepo}: invalid release metadata`);
      tool.tracked = { kind: 'release', value: release.tag_name, publishedAt: release.published_at || null };
    } else if (releaseResponse.status === 404) {
      const commitResponse = await fetchWithRetry(`${api}/commits/${encodeURIComponent(repo.default_branch)}`, { fetcher, attempts, wait });
      if (!commitResponse.ok) throw new Error(`${tool.sourceRepo}: commit lookup failed (${commitResponse.status})`);
      const commit = await commitResponse.json();
      if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(commit.sha)) throw new Error(`${tool.sourceRepo}: invalid commit metadata`);
      tool.tracked = { kind: 'commit', value: commit.sha, publishedAt: commit.commit?.committer?.date || null };
    } else {
      console.warn(`${tool.sourceRepo}: release lookup failed (${releaseResponse.status}); preserving previous metadata`);
    }
    tool.defaultBranch = repo.default_branch;
  }
  return tools;
}

export async function updateFile(path = file) {
  const tools = JSON.parse(await readFile(path, 'utf8'));
  const updated = await updateToolMetadata(tools);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`);
  await rename(temporary, path);
  console.log(`Updated ${updated.filter((tool) => tool.sourceRepo).length} GitHub-backed tools`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await updateFile();
}
