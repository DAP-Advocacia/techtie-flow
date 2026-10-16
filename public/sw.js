// Service worker do TechTie Flow. Objetivo: o app abrir como "aplicativo" no celular (instalável) e a casca
// carregar mesmo com a rede ruim. NÃO guarda dados: a API, o WebSocket e as mídias nunca passam pelo cache
// (conversa e contato são dados de cliente e dependem de permissão do momento).
// Estratégia: rede primeiro (sempre a versão nova após um deploy); cache só como reserva se a rede falhar.
const CACHE = 'ttf-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fontes e afins: com o navegador
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return; // dados nunca no cache

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch {
        const hit = (await caches.match(req)) || (req.mode === 'navigate' ? await caches.match('/') : null);
        return hit || new Response('Sem conexão com o servidor.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })()
  );
});
