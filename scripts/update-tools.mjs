import { readFile, writeFile } from 'node:fs/promises';

const file = 'data/tools.json';
const tools = JSON.parse(await readFile(file, 'utf8'));
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wayne-tools-updater',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

for (const t of tools) {
  if (!t.sourceRepo) continue;
  const repo = await fetch(`https://api.github.com/repos/${t.sourceRepo}`, { headers }).then((r) => {
    if (!r.ok) throw new Error(`${t.sourceRepo}: ${r.status}`);
    return r.json();
  });
  const release = await fetch(`https://api.github.com/repos/${t.sourceRepo}/releases/latest`, { headers });
  if (release.ok) {
    const x = await release.json();
    t.tracked = { kind: 'release', value: x.tag_name, publishedAt: x.published_at };
  } else {
    const x = await fetch(`https://api.github.com/repos/${t.sourceRepo}/commits/${repo.default_branch}`, { headers }).then((r) => r.json());
    t.tracked = { kind: 'commit', value: x.sha, publishedAt: x.commit?.committer?.date || null };
  }
  t.defaultBranch = repo.default_branch;
}
await writeFile(file, `${JSON.stringify(tools, null, 2)}\n`);
console.log(`Updated ${tools.filter((t) => t.sourceRepo).length} GitHub-backed tools`);