// Servidor do TechTie Flow. Dois modos, no mesmo processo:
//  * PROTÓTIPO (padrão): serve public/ (+ /shared) e cai no index.html para rotas do SPA.
//    Sem banco nem WhatsApp — dados fictícios no navegador (public/js/mock/).
//  * OPERAÇÃO: com DATABASE_URL + AUTH_TOKEN_SECRET, liga também a API (/api/*), o WebSocket
//    (/ws) e o canal de WhatsApp (Baileys). Veja .env.example e docs/piloto.md.
const http = require('http');
const fs = require('fs');
const path = require('path');

const { config, assertApiConfig } = require('./config');
require('./logging').silenceSignalNoise(); // não imprime dump de sessão do libsignal (contém chaves privadas)

const PORT = config.port;
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

// ---- modo operação ----------------------------------------------------------
let api = null;
let hub = null;
let channel = null;
let pool = null;
if (config.apiEnabled) {
  assertApiConfig();
  ({ pool } = require('./db'));
  const { createHub } = require('./api/ws');
  const { createApp } = require('./api/app');
  hub = createHub({ pool, config });
  // Agente de IA (OpenAI): a chave vem do ambiente do servidor; sem ela a IA fica desligada (o resto funciona igual)
  const openai = require('./ai/openai').createOpenAI({ apiKey: config.openaiKey, model: config.openaiModel });
  const ai = require('./ai/runtime').createAiRuntime({ pool, getChannel: () => channel, notify: hub.notify, openai, config });
  if (config.whatsappEnabled) channel = require('./channels/baileys').createBaileysChannel({ pool, config, notify: hub.notify, ai });
  api = createApp({ pool, config, hub, channel, openai });
  console.log(`[techtie-flow] Agente de IA: ${openai.configured ? `OpenAI configurada (${openai.model})` : 'sem OPENAI_API_KEY (IA desligada)'}`);
}

const server = http.createServer(async (req, res) => {
  if (api && (await api.handle(req, res))) return;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'requisição inválida');
  }

  // Modo operação: o front descobre sozinho que há API (mesma origem) — sem editar arquivo.
  if (pathname === '/config.js' && api) {
    return send(res, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }, 'window.__TTF__ = { live: true, apiUrl: "" };\n');
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

if (hub) hub.attach(server);

server.listen(PORT, () => {
  console.log(`[techtie-flow] ${api ? 'operação (API + WebSocket' + (channel ? ' + WhatsApp)' : ')') : 'protótipo'} em http://localhost:${PORT}`);
  // retoma, escalonado, as sessões de WhatsApp já pareadas (sem bloquear o servidor)
  channel?.resumeAll();
});

// Uma falha isolada (ex.: socket do WhatsApp) não pode derrubar a API para todos os tenants.
process.on('unhandledRejection', (err) => console.error('[server] promessa rejeitada sem tratamento:', err?.message || err));
process.on('uncaughtException', (err) => console.error('[server] exceção não capturada:', err?.message || err));

// Encerramento limpo (deploy/reinício): fecha conexões e o pool antes de sair.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] ${sig}: encerrando…`);
    hub?.close();
    server.close(() => (pool ? pool.end().finally(() => process.exit(0)) : process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
