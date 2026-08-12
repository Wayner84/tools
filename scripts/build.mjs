import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const tools = JSON.parse(await readFile(path.join(root, 'data/tools.json'), 'utf8'));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'src'), dist, { recursive: true });
await mkdir(path.join(dist, 'data'), { recursive: true });
await writeFile(path.join(dist, 'data/tools.json'), `${JSON.stringify(tools, null, 2)}\n`);
await writeFile(path.join(dist, '.nojekyll'), '');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
for (const t of tools) {
  const dir = path.join(dist, t.slug);
  await mkdir(dir, { recursive: true });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1;url=${esc(t.launchUrl)}"><title>Launching ${esc(t.name)}…</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b10;color:#f4f7fb;font-family:system-ui}.box{max-width:560px;padding:36px;border:1px solid #263142;background:#0e131b}small{color:#62ddff}h1{margin:.6rem 0}p{color:#9aa7b8;line-height:1.6}a{color:#080b10;background:#b9ff66;padding:12px 16px;text-decoration:none;font-weight:700}.back{background:none;color:#9aa7b8;padding:0;margin-left:16px}</style></head><body><main class="box"><small>WAYNE / TOOL DECK</small><h1>${esc(t.name)}</h1><p>${esc(t.description)}</p><p>This route opens the ${t.hosting === 'wayne-hosted' ? 'Wayne-hosted' : 'canonical'} application. If it does not open automatically:</p><a href="${esc(t.launchUrl)}">Launch now ↗</a><a class="back" href="../">Back to tools</a></main><script>setTimeout(()=>location.replace(${JSON.stringify(t.launchUrl)}),350)</script></body></html>`;
  await writeFile(path.join(dir, 'index.html'), html);
}
console.log(`Built ${tools.length} tool routes in dist/`);