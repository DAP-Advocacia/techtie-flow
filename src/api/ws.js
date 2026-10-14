'use strict';
// Tempo real (WebSocket). Cada evento é entregue SÓ a quem o motor permitiria ler aquele dado:
// broadcast para o tenant inteiro vazaria conversa de um atendente para os outros.
const { WebSocketServer } = require('ws');
const { verifyToken } = require('../auth');
const { getAccess } = require('./access');

const toApiConversation = (c) => ({
  id: c.id,
  contactId: c.contact_id,
  instanceId: c.instance_id,
  assigneeId: c.assignee_id || null,
  status: c.status,
  unread: c.unread_count || 0,
  lastMessage: c.last_message || '',
  lastMessageAt: c.last_message_at ? new Date(c.last_message_at).getTime() : null,
});

function createHub({ pool, config }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set(); // { ws, userId, tenantId }

  wss.on('connection', (ws, _req, who) => {
    const client = { ws, userId: who.sub, tenantId: who.tid };
    clients.add(client);
    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
    ws.on('message', () => {}); // o canal é só servidor → cliente; ignora o que vier
    ws.send(JSON.stringify({ type: 'ready' }));
  });

  /** Anexa ao servidor HTTP: GET /ws?ticket=… (ticket de 30 s emitido por POST /api/ws-ticket). */
  function attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') return socket.destroy();
      const origin = req.headers.origin;
      if (origin && config.corsOrigins.length && !config.corsOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      const who = verifyToken(url.searchParams.get('ticket'), config.authSecret);
      if (!who || who.kind !== 'ws') {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, who));
    });
  }

  /**
   * Notifica os clientes do tenant que PODEM ver o recurso.
   * `check` = { entity, action, row } (decisão do motor) — sem `check`, vai a todos do tenant.
   */
  async function emit(tenantId, event, check) {
    const text = JSON.stringify(event);
    for (const client of [...clients]) {
      if (client.tenantId !== tenantId || client.ws.readyState !== 1) continue;
      try {
        if (check) {
          const access = await getAccess(pool, { userId: client.userId, tenantId });
          if (!access) continue;
          if (access.E.decide(access.ctx, check.entity, check.action || 'read', check.row).effect !== 'allow') continue;
        }
        client.ws.send(text);
      } catch {
        /* um cliente com problema não pode impedir a entrega aos outros */
      }
    }
  }

  /** Ponte dos canais: `notify('message'|'instance', payload)`. */
  function notify(type, p) {
    if (type === 'message') {
      const conv = toApiConversation(p.conversation);
      const row = { id: conv.id, tenantId: p.tenantId, ownerId: null, teamId: p.conversation.team_id || null, assigneeId: conv.assigneeId, instanceId: conv.instanceId, status: conv.status };
      emit(p.tenantId, { type: 'message', conversation: conv, message: p.message }, { entity: 'conversation', row }).catch(() => {});
    } else if (type === 'instance') {
      const inst = { id: p.instance.id, name: p.instance.name, channel: p.instance.channel, status: p.instance.status, phone: p.instance.phone || null, attentionReason: p.instance.attention_reason || null, ownerId: p.instance.owner_id || null, teamId: p.instance.team_id || null };
      // o QR dá acesso à conta de WhatsApp: só vai a quem pode conectar números
      emit(p.tenantId, { type: 'instance', instance: inst, qr: p.qr || null }, { entity: 'instance', action: p.qr ? 'connect' : 'read', row: { id: inst.id, tenantId: p.tenantId, ownerId: inst.ownerId, teamId: inst.teamId } }).catch(() => {});
    }
  }

  const close = () => {
    for (const c of clients) c.ws.terminate();
    wss.close();
  };
  return { attach, emit, notify, close, size: () => clients.size };
}

module.exports = { createHub, toApiConversation };
