'use strict';
// Persistência do que chega dos canais (hoje Baileys; amanhã Cloud API): contato → conversa →
// mensagem, tudo idempotente. É separado do Baileys de propósito: o canal só traduz o formato
// dele para esta chamada, e os testes exercitam a regra sem precisar de WhatsApp.
const { withTenant } = require('../db-tenant');

const KINDS = new Set(['text', 'image', 'audio', 'video', 'document', 'sticker']);
const PREVIEW = { image: '[imagem]', audio: '[áudio]', video: '[vídeo]', document: '[documento]', sticker: '[figurinha]' };
const digits = (v) => String(v || '').replace(/\D/g, '');

/**
 * Grava uma mensagem recebida (ou enviada pelo próprio celular) e devolve o que mudou.
 * @param deps { pool, notify(type, payload) }
 * @param m { tenantId, instanceId, phone, pushName, isHistory, message:{id,type,text,mediaUrl,mimetype,direction,status,createdAt} }
 * @returns {Promise<null|{duplicate:true}|{conversation, message}>}
 */
async function ingestMessage(deps, m) {
  const phone = digits(m.phone);
  if (!/^[0-9]{8,15}$/.test(phone)) return null; // sem telefone válido não há contato a associar
  const msg = m.message || {};
  const kind = KINDS.has(msg.type) ? msg.type : msg.mediaUrl ? 'document' : 'text';
  const direction = msg.direction === 'out' ? 'out' : 'in';
  const body = msg.text ? String(msg.text).slice(0, 20000) : null;
  if (!body && !msg.mediaUrl) return null;
  const when = msg.createdAt && !Number.isNaN(Date.parse(msg.createdAt)) ? new Date(msg.createdAt) : new Date();
  const bumpsUnread = direction === 'in' && !m.isHistory;

  const out = await withTenant(deps.pool, { tenantId: m.tenantId, readScopes: 'tenant' }, async (c) => {
    // contato (um por telefone no tenant)
    let contact = (await c.query('SELECT id, name FROM contacts WHERE phone = $1', [phone])).rows[0];
    if (!contact) {
      contact = (
        await c.query(
          `INSERT INTO contacts (tenant_id, name, phone, source) VALUES ($1, $2, $3, 'whatsapp')
           ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL DO UPDATE SET phone = EXCLUDED.phone
           RETURNING id, name`,
          [m.tenantId, String(m.pushName || phone).trim().slice(0, 200) || phone, phone]
        )
      ).rows[0];
    } else if (m.pushName && contact.name === phone) {
      await c.query('UPDATE contacts SET name = $2 WHERE id = $1', [contact.id, String(m.pushName).trim().slice(0, 200)]);
    }

    // conversa (uma por número de WhatsApp + contato)
    let conv = (await c.query('SELECT id FROM conversations WHERE instance_id = $1 AND contact_id = $2', [m.instanceId, contact.id])).rows[0];
    if (!conv) {
      await c.query(
        // Histórico importado no pareamento NÃO é atendimento novo: nasce "resolvida" para não lotar a
        // fila com centenas de conversas antigas. Se o cliente escrever de novo, o UPDATE abaixo a
        // reabre (volta para a fila). Conversa nascida de mensagem ao vivo entra na fila normalmente.
        // Número PESSOAL (instância com responsável): a conversa já nasce atribuída ao dono (e à equipe do
        // número), sem passar pela fila de todos. Número da empresa (sem responsável): vai para a fila.
        `INSERT INTO conversations (tenant_id, instance_id, contact_id, phone, status, assignee_id, team_id)
         SELECT $1, i.id, $3, $4, CASE WHEN i.owner_id IS NOT NULL AND $5::text = 'queue' THEN 'open' ELSE $5::text END, i.owner_id, i.team_id FROM instances i WHERE i.id = $2
         ON CONFLICT (tenant_id, instance_id, contact_id) WHERE contact_id IS NOT NULL DO NOTHING`,
        [m.tenantId, m.instanceId, contact.id, phone, m.isHistory ? 'resolved' : 'queue']
      );
      conv = (await c.query('SELECT id FROM conversations WHERE instance_id = $1 AND contact_id = $2', [m.instanceId, contact.id])).rows[0];
    }

    // mensagem: a mesma pode chegar 2x (ao vivo e no backfill de histórico) — grava uma só
    const ins = await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, kind, body, media_url, media_mime, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [m.tenantId, conv.id, msg.id || null, direction, kind, body, msg.mediaUrl || null, msg.mimetype || null, ['sent', 'delivered', 'read'].includes(msg.status) ? msg.status : 'sent', when]
    );
    if (!ins.rowCount) return { duplicate: true };

    const preview = (body || PREVIEW[kind] || '').slice(0, 300);
    const updated = await c.query(
      `UPDATE conversations
          SET last_message_at = CASE WHEN last_message_at IS NULL OR last_message_at < $2 THEN $2 ELSE last_message_at END,
              last_message    = CASE WHEN last_message_at IS NULL OR last_message_at < $2 THEN $3 ELSE last_message END,
              unread_count    = unread_count + $4,
              -- mensagem NOVA do cliente reabre conversa resolvida (histórico antigo não)
              status          = CASE WHEN status = 'resolved' AND $5 THEN (CASE WHEN assignee_id IS NULL THEN 'queue' ELSE 'open' END) ELSE status END,
              -- alguém respondeu pelo próprio celular: o Agente de IA para de responder esta conversa
              ai_paused       = CASE WHEN $6 THEN true ELSE ai_paused END
        WHERE id = $1
        RETURNING id, instance_id, contact_id, assignee_id, team_id, status, phone, unread_count, last_message, last_message_at`,
      [conv.id, when, preview, bumpsUnread ? 1 : 0, bumpsUnread, direction === 'out' && !m.isHistory]
    );
    return { conversation: updated.rows[0], message: { id: ins.rows[0].id, conversationId: conv.id, kind, direction, body, mediaUrl: msg.mediaUrl || null, at: when.getTime(), waId: msg.id || null } };
  });

  if (out && !out.duplicate && !m.isHistory) {
    deps.notify?.('message', { tenantId: m.tenantId, ...out });
    // mensagem NOVA do cliente: o Agente de IA decide se responde (ver src/ai/runtime.js)
    if (direction === 'in') deps.ai?.onInbound({ tenantId: m.tenantId, conversationId: out.conversation.id });
  }
  return out;
}

/** Atualiza o status de entrega (sent → delivered → read) de uma mensagem já gravada. */
async function updateMessageStatus(deps, { tenantId, waMessageId, status }) {
  if (!['sent', 'delivered', 'read', 'failed'].includes(status) || !waMessageId) return;
  // só avança (read > delivered > sent): evita um "delivered" atrasado desfazer um "read"
  await withTenant(deps.pool, { tenantId, readScopes: 'tenant' }, (c) =>
    c.query(
      `UPDATE messages SET status = $2
        WHERE wa_message_id = $1 AND direction = 'out'
          AND array_position(ARRAY['pending','sent','delivered','read'], status) < array_position(ARRAY['pending','sent','delivered','read'], $2)`,
      [waMessageId, status]
    )
  );
}

/** Grava o estado do número (conectado, QR, atenção…) e avisa quem pode ver. */
async function setInstanceStatus(deps, { tenantId, instanceId, status, phone, reason, qr }) {
  const row = await withTenant(deps.pool, { tenantId, readScopes: 'tenant' }, async (c) => {
    const r = await c.query(
      `UPDATE instances SET status = $2, phone = COALESCE($3, phone), attention_reason = $4, updated_at = now()
        WHERE id = $1 RETURNING id, name, channel, status, phone, attention_reason, owner_id, team_id`,
      [instanceId, status, phone || null, reason || null]
    );
    return r.rows[0];
  });
  if (row) deps.notify?.('instance', { tenantId, instance: row, qr: qr || null });
  return row;
}

module.exports = { ingestMessage, updateMessageStatus, setInstanceStatus };
