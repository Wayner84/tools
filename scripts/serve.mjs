import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve('dist');
const host = '127.0.0.1';
const port = 4173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function resolveRequestPath(rootDirectory, requestTarget) {
  let decodedPath;
  try {
    const rawPath = String(requestTarget ?? '').split(/[?#]/, 1)[0];
    decodedPath = decodeURIComponent(rawPath).replaceAll('\\', '/');
  } catch {
    return null;
  }

  if (!decodedPath.startsWith('/') || decodedPath.includes('\0')) return null;

  let relativePath;
  if (decodedPath === '/tools' || decodedPath === '/tools/') {
    relativePath = '';
  } else if (decodedPath.startsWith('/tools/')) {
    relativePath = decodedPath.slice('/tools/'.length);
  } else {
    relativePath = decodedPath.slice(1);
  }

  const candidate = path.resolve(rootDirectory, relativePath);
  const relative = path.relative(path.resolve(rootDirectory), candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return candidate;
}

export function createDevelopmentServer(rootDirectory = root) {
  return http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('allow', 'GET, HEAD');
      response.end('Method not allowed');
      return;
    }

    try {
      let file = resolveRequestPath(rootDirectory, request.url);
      if (!file) throw new Error('Request path is outside the document root');
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const body = await readFile(file);
      response.setHeader('content-type', types[path.extname(file).toLowerCase()] || 'application/octet-stream');
      response.setHeader('x-content-type-options', 'nosniff');
      response.statusCode = 200;
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.statusCode = 404;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('Not found');
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  createDevelopmentServer().listen(port, host, () => {
    console.log(`http://localhost:${port}/tools/`);
  });
}
