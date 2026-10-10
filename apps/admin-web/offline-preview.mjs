import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  response.setHeader('Cache-Control', 'no-store');
  if (pathname.startsWith('/api/')) {
    response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'API bağlantısı bu önizlemede kapalı.' }));
    return;
  }
  const target = resolve(dist, `.${decodeURIComponent(pathname)}`);
  if (target !== dist && !target.startsWith(dist + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const file = (await stat(target)).isFile() ? target : resolve(dist, 'index.html');
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
}).listen(3001, '127.0.0.1', () => {
  process.stdout.write('Offline arayüz önizlemesi: http://127.0.0.1:3001\n');
});
