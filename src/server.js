// Servidor estático do protótipo do TechTie Flow: serve public/ e cai no
// index.html para rotas desconhecidas. Sem dependências e sem tocar no
// Baileys/Supabase — o protótipo roda 100% com dados fictícios no navegador
// (public/js/mock/). A API real (auth, tenants, WhatsApp) entra depois,
// em cima deste mesmo processo.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3333);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'requisição inválida');
  }

  if (pathname === '/healthz') {
    return send(res, 200, { 'Content-Type': 'application/json' }, '{"ok":true}');
  }

  // /shared/* = módulos isomórficos (ex.: motor de permissões) que o navegador
  // importa e o backend também; o resto vem de public/.
  const useShared = pathname.startsWith('/shared/');
  const baseDir = useShared ? SHARED_DIR : PUBLIC_DIR;
  const relative = useShared ? pathname.slice('/shared'.length) : pathname;

  // Resolve dentro do diretório base e recusa qualquer coisa que escape dele
  // (path traversal via ../ ou caminho absoluto).
  const requested = path.normalize(path.join(baseDir, relative));
  const insidePublic = requested === baseDir || requested.startsWith(baseDir + path.sep);
  if (!insidePublic) {
    return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'acesso negado');
  }

  let file = requested;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    // Pedido de arquivo com extensão que não existe = 404 de verdade; rota
    // do SPA (sem extensão) cai no index.html.
    if (path.extname(pathname)) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'não encontrado');
    }
    file = path.join(PUBLIC_DIR, 'index.html');
  }

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  // Protótipo em desenvolvimento: sem cache, pra ver cada edição na hora.
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'erro ao ler arquivo');
    send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store' }, data);
  });
});

server.listen(PORT, () => {
  console.log(`[techtie-flow] protótipo em http://localhost:${PORT}`);
});
