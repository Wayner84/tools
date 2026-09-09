import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { validateCatalogue } from '../src/app.js';

const root = process.cwd();
const dist = path.join(root, 'dist');
const catalogueSource = await readFile(path.join(root, 'data/tools.json'), 'utf8');
const tools = validateCatalogue(JSON.parse(catalogueSource));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'src'), dist, { recursive: true });
await mkdir(path.join(dist, 'data'), { recursive: true });
await writeFile(path.join(dist, 'data/tools.json'), catalogueSource);
await writeFile(path.join(dist, '.nojekyll'), '');

const esc = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

for (const tool of tools) {
  let launchUrl;
  try {
    launchUrl = new URL(tool.launchUrl);
  } catch {
    throw new Error(`Invalid launch URL for ${tool.slug}`);
  }
  if (launchUrl.protocol !== 'https:' || launchUrl.username || launchUrl.password) {
    throw new Error(`Unsafe launch URL for ${tool.slug}`);
  }

  const directory = path.join(dist, tool.slug);
  await mkdir(directory, { recursive: true });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><title>Open ${esc(tool.name)} | Wayne’s Tools</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b10;color:#f4f7fb;font-family:system-ui}.box{max-width:640px;margin:20px;padding:36px;border:1px solid #263142;background:#0e131b}small{color:#62ddff;text-transform:uppercase}h1{margin:.6rem 0}p,dl{color:#9aa7b8;line-height:1.6}dt{color:#f4f7fb;font-weight:700}dd{margin:0 0 .75rem}.actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.launch{color:#080b10;background:#b9ff66;padding:12px 16px;text-decoration:none;font-weight:700}.back{color:#9aa7b8}</style></head><body><main class="box"><small>WAYNE / TOOL DECK · ${esc(tool.destinationType)}</small><h1>${esc(tool.name)}</h1><p>${esc(tool.description)}</p><p>This destination is outside Tool Deck. It will open only when you choose to continue.</p><dl><dt>Operator</dt><dd>${esc(tool.operator)}</dd><dt>Data boundary</dt><dd>${esc(tool.dataBoundary)}</dd><dt>Functional check</dt><dd>${esc(tool.functionalCheck)}</dd></dl><div class="actions"><a class="launch" href="${esc(launchUrl.href)}" rel="noopener noreferrer">Continue to ${esc(tool.destinationType)} ↗</a><a class="back" href="../">Back to tools</a></div></main></body></html>`;
  await writeFile(path.join(directory, 'index.html'), html);
}

console.log(`Built ${tools.length} tool routes in dist/`);
