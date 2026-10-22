'use strict';
// API HTTP do TechTie Flow (JSON). Regras de ouro:
//  1. Toda decisão de acesso é do MOTOR (shared/permissions) no servidor; o front só reflete.
//  2. Listagem = WHERE compilado pelo motor (nunca "carregar tudo e filtrar depois").
//  3. Acesso por id = o registro é lido DO BANCO (com RLS + filtro do motor), e só então decidido.
//  4. O contexto das operações (etapa de destino, quem pediu…) é derivado AQUI, do banco —
//     nunca copiado do corpo da requisição.
const crypto = require('crypto');
const { hashPassword, verifyPassword, passwordProblem, signToken, verifyToken, newInviteToken, hashInviteToken, makeLimiter } = require('../auth');
const { getAccess, invalidate, tx, listWhere, canAccess } = require('./access');
const { withTenant } = require('../db-tenant');
const { toApiConversation } = require('./ws');
const { downloadMediaByFilename } = require('../media');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Seu perfil não permite esta ação.') => new HttpError(403, m);
const notFound = (m = 'Não encontrado.') => new HttpError(404, m);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ms = (d) => (d ? new Date(d).getTime() : null);
// coluna `date`: o pg devolve meia-noite LOCAL; lê pelos componentes locais para não deslocar o dia
const dateStr = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d || null);
const parseDay = (v) => {
  if (v === null || v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!d || d.getMonth() !== Number(m[2]) - 1 || d.getFullYear() < 2000 || d.getFullYear() > 2100) throw bad('Data inválida.');
  return String(v);
};
const num = (v) => (v === null || v === undefined ? null : Number(v));

// --------------------------------------------------------------------- mapeamentos DB → API
const apiContact = (r) => ({ id: r.id, name: r.name, company: r.company || '', phone: r.phone ? `+${r.phone}` : '', email: r.email || '', ownerId: r.owner_id, teamId: r.team_id, source: r.source || '', tags: [], status: r.status || null, createdAt: ms(r.created_at) });
const apiDeal = (r) => ({ id: r.id, title: r.title, contactId: r.contact_id, pipelineId: r.pipeline_id, stageId: r.stage_id, value: num(r.value) ?? 0, ownerId: r.owner_id, teamId: r.team_id, status: r.status, createdAt: ms(r.created_at), stageChangedAt: ms(r.stage_changed_at), items: Array.isArray(r.items) ? r.items : [], proposalSentAt: ms(r.proposal_sent_at), expectedClose: dateStr(r.expected_close), lastMessage: '' });
const apiInstance = (r) => ({ id: r.id, name: r.name, channel: r.channel, status: r.status, phone: r.phone || '', attentionReason: r.attention_reason || null, ownerId: r.owner_id || null, teamId: r.team_id || null, ownerName: r.owner_name || '', aiActive: !!r.ai_active });
const apiMessage = (r) => ({
  id: r.id,
  type: r.kind === 'note' ? 'note' : r.kind === 'system' ? 'system' : r.direction === 'in' ? 'in' : 'out',
  kind: r.kind,
  text: r.body || '',
  mediaUrl: r.media_url || null,
  mime: r.media_mime || null,
  at: ms(r.created_at),
  authorId: r.author_id || null,
  byAi: !!r.by_ai,
  status: r.status,
});
// linhas no formato que o MOTOR espera (atributos do catálogo)
const convRow = (r) => ({ id: r.id, tenantId: r.tenant_id, ownerId: r.owner_id, teamId: r.team_id, assigneeId: r.assignee_id, instanceId: r.instance_id, status: r.status });
const dealRow = (r, sharedWith) => ({ id: r.id, tenantId: r.tenant_id, ownerId: r.owner_id, teamId: r.team_id, pipelineId: r.pipeline_id, stageId: r.stage_id, status: r.status, value: num(r.value), sharedWith });

// --------------------------------------------------------------------- infraestrutura HTTP
async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Corpo grande demais.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : (() => { throw bad('JSON inválido.'); })();
  } catch (e) {
    throw e instanceof HttpError ? e : bad('JSON inválido.');
  }
}

function createApp({ pool, config, hub, channel, openai }) {
  /** IP do cliente: com TRUST_PROXY, o primeiro de X-Forwarded-For; senão o do socket. */
  const ipOf = (req) => (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const routes = [];
  const route = (method, p, handler, { auth = true, limit } = {}) => routes.push({ method, auth, limit, handler, re: new RegExp('^' + p.replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)') + '/?$') });
  // 10 tentativas por (IP + e-mail) e um teto bem mais alto por IP: um escritório inteiro atrás do
  // mesmo IP (NAT) não pode ficar bloqueado por causa de poucos erros de digitação.
  const loginLimiter = makeLimiter(10, 10 * 60 * 1000);
  const loginIpLimiter = makeLimiter(300, 10 * 60 * 1000);
  const ipLimiter = makeLimiter(600, 60 * 1000);
  const inviteLimiter = makeLimiter(20, 10 * 60 * 1000);

  const sendJson = (res, status, data, extra = {}) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(body);
  };

  const uuidOr400 = (v, what) => {
    if (!UUID.test(String(v || ''))) throw bad(`${what} inválido.`);
    return String(v).toLowerCase();
  };

  /** Decide pelo motor e lança 403 com o motivo quando negado. Devolve a decisão. */
  function must(access, entity, action, row, context) {
    const d = access.E.decide(access.ctx, entity, action, row, context);
    if (d.effect === 'allow') return d;
    if (d.effect === 'approval') throw new HttpError(409, 'Esta ação precisa da aprovação de um gestor.');
    const why = { mfa_required: 'Ação sensível: ative a verificação em duas etapas (MFA).', subject_inactive: 'Seu acesso está inativo.' }[d.reason];
    throw forbidden(why);
  }

  const withShares = async (c, entity, row) => {
    const r = await c.query('SELECT subject_type AS type, subject_id AS id, level FROM resource_shares WHERE entity = $1 AND resource_id = $2', [entity, row.id]);
    return { ...row, sharedWith: r.rows };
  };

  /** Conversa visível ao usuário (filtro do motor + RLS) ou 404 — sem revelar que existe. */
  async function visibleConversation(c, access, id) {
    const w = listWhere(access, 'conversation', 'read');
    const r = await c.query(`SELECT t.* FROM conversations t WHERE t.id = $${w.params.length + 1} AND ${w.sql}`, [...w.params, id]);
    if (!r.rowCount) throw notFound('Conversa não encontrada.');
    return r.rows[0];
  }
  async function visibleDeal(c, access, id) {
    const w = listWhere(access, 'deal', 'read');
    const r = await c.query(`SELECT t.* FROM deals t WHERE t.id = $${w.params.length + 1} AND ${w.sql}`, [...w.params, id]);
    if (!r.rowCount) throw notFound('Negócio não encontrado.');
    return r.rows[0];
  }
  const primaryTeam = (access) => access.teamIds[0] || null;
  /**
   * Endereço público para links (convites). Se o pedido veio do PRÓPRIO site (Origin = mesmo host que atendeu),
   * vale o endereço que a pessoa está usando agora — assim um APP_URL velho (ex.: domínio antigo do Coolify) não
   * gera link quebrado. Qualquer outra origem é ignorada e vale o APP_URL configurado.
   */
  const publicBase = (req) => {
    const origin = String(req.headers.origin || '');
    const host = String((config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim().toLowerCase();
    try {
      if (origin && host && new URL(origin).host.toLowerCase() === host) return origin.replace(/\/$/, '');
    } catch {
      /* Origin inválida: cai no APP_URL */
    }
    return config.appUrl || '';
  };
  /** Definição do perfil (de fábrica ou do tenant). Lê do BANCO: o cache de acesso não conhece perfil recém-criado. */
  async function roleDefinition(c, access, rid) {
    const sys = access.E.SYSTEM_ROLES.find((r) => r.id === rid);
    if (sys) return { def: sys, system: true };
    if (!UUID.test(String(rid))) return null;
    const r = (await c.query('SELECT * FROM roles WHERE id = $1', [String(rid).toLowerCase()])).rows[0];
    return r ? { def: { ...r.definition, id: r.id, name: r.name, description: r.description || '', tenantId: r.tenant_id, system: false }, system: false } : null;
  }
  /** Trilha de auditoria NA MESMA transação da mudança (append-only no banco). */
  const audit = (c, access, req, action, entity, entityId, diff) =>
    c.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      access.tenantId, access.userId, action, entity, entityId, diff ? JSON.stringify(diff) : null, /^[0-9a-f:.]+$/i.test(req ? ipOf(req) : '') ? ipOf(req).replace(/^::ffff:/, '') : null,
    ]);

  // ===================================================================== AUTENTICAÇÃO
  route(
    'POST',
    '/api/auth/login',
    async ({ req, body }) => {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const ip = ipOf(req);
      // só tentativas que FALHAM contam por (IP + e-mail): entrar certo não gasta o limite
      if (!loginLimiter.peek(`${ip}|${email}`) || !loginIpLimiter(ip)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
      const found = EMAIL.test(email) ? (await pool.query('SELECT * FROM auth_lookup($1)', [email])).rows[0] : null;
      // sempre gasta o tempo de uma verificação de senha (não revela se o e-mail existe)
      const ok = await verifyPassword(password, found?.password_hash);
      if (found && found.locked_until && new Date(found.locked_until) > new Date()) throw new HttpError(429, 'Conta temporariamente bloqueada por tentativas erradas. Tente mais tarde.');
      if (!found || !ok) {
        loginLimiter(`${ip}|${email}`);
        if (found) await pool.query('SELECT auth_login_result($1, false)', [found.user_id]);
        throw new HttpError(401, 'E-mail ou senha incorretos.');
      }
      const access = await getAccess(pool, { userId: found.user_id, tenantId: found.tenant_id });
      if (!access || access.user.status !== 'active') throw new HttpError(403, 'Conta inativa. Fale com o administrador.');
      await pool.query('SELECT auth_login_result($1, true)', [found.user_id]);
      const token = signToken({ sub: found.user_id, tid: found.tenant_id }, config.authSecret, config.tokenTtlSeconds);
      return { token, expiresIn: config.tokenTtlSeconds, user: access.user };
    },
    { auth: false }
  );

  route(
    'POST',
    '/api/auth/accept-invite',
    async ({ req, body }) => {
      if (!inviteLimiter(ipOf(req))) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
      const problem = passwordProblem(body.password);
      if (problem) throw bad(problem);
      const hash = await hashPassword(body.password);
      const ok = (await pool.query('SELECT auth_accept_invite($1, $2) AS ok', [hashInviteToken(String(body.token || '')), hash])).rows[0].ok;
      if (!ok) throw bad('Convite inválido ou expirado.');
      return { ok: true };
    },
    { auth: false }
  );

  route('GET', '/api/health', async () => ({ ok: true }), { auth: false });

  route('POST', '/api/ws-ticket', async ({ access }) => ({ ticket: signToken({ sub: access.userId, tid: access.tenantId, kind: 'ws' }, config.authSecret, 30) }));

  route('GET', '/api/me', async ({ access }) => ({ user: access.user, tenant: { id: access.tenantId, name: access.tenant?.name }, permissions: access.E.effectiveMatrix(access.ctx) }));

  // ===================================================================== BOOTSTRAP
  // Estado inicial da tela, já FILTRADO pelo motor (o front nunca recebe o que não pode ver).
  route('GET', '/api/bootstrap', async ({ access }) => {
    const { E } = access;
    return tx(
      pool,
      access,
      async (c) => {
        const where = (entity) => listWhere(access, entity, 'read');
        const q = (table, entity, order, limit) => {
          const w = where(entity);
          return c.query(`SELECT t.* FROM ${table} t WHERE ${w.sql} ORDER BY ${order} LIMIT ${limit}`, w.params);
        };
        // em sequência: um cliente do pg não deve receber consultas simultâneas (deprecado no pg 9)
        const contacts = await q('contacts', 'contact', 't.created_at DESC', 2000);
        const deals = await q('deals', 'deal', 't.created_at DESC', 2000);
        const convs = await q('conversations', 'conversation', 't.last_message_at DESC NULLS LAST', 500);
        // Quem pode ver uma conversa precisa saber QUEM é o contato dela (nome/telefone), mesmo que o
        // contato em si não esteja no seu escopo (contato criado pelo WhatsApp não tem dono nem equipe).
        // Exceção estreita: só os contatos das conversas que o motor já liberou, lidos fora do teto de
        // leitura por escopo (RLS camada 2) e passando pela ocultação de campos do perfil.
        const have = new Set(contacts.rows.map((r) => r.id));
        const missing = [...new Set(convs.rows.map((r) => r.contact_id).filter((cid) => cid && !have.has(cid)))];
        const viaConversation = missing.length
          ? (await withTenant(pool, { tenantId: access.tenantId, userId: access.userId, readScopes: 'tenant', readOnly: true }, (c2) => c2.query('SELECT * FROM contacts WHERE id = ANY($1::uuid[])', [missing]))).rows
          : [];
        const readUsers = canAccess(access, 'user', 'read');
        const users = (await c.query('SELECT id, name, email, status, mfa_enabled FROM users ORDER BY name')).rows;
        // Todos recebem o PRÓPRIO perfil (o front calcula menu e telas com ele); os dos outros, só quem lê usuários.
        const roleLinks = (await c.query(readUsers ? 'SELECT user_id, system_role_id, role_id FROM user_roles' : 'SELECT user_id, system_role_id, role_id FROM user_roles WHERE user_id = $1', readUsers ? [] : [access.userId])).rows;
        const memberLinks = (await c.query('SELECT team_id, user_id FROM team_members')).rows;
        // Funis e números passam pelo filtro do motor (recorte por funil/número do perfil). Quem lê negócios mas
        // não tem pipeline.read (ex.: Financeiro) continua vendo os funis dos seus negócios.
        const pw = listWhere(access, 'pipeline', 'read');
        const pipelines = canAccess(access, 'pipeline', 'read')
          ? (await c.query(`SELECT t.id, t.name FROM pipelines t WHERE ${pw.sql} ORDER BY t.name`, pw.params)).rows
          : canAccess(access, 'deal', 'read') ? (await c.query('SELECT id, name FROM pipelines ORDER BY name')).rows : [];
        const stages = pipelines.length ? (await c.query('SELECT id, pipeline_id, name, kind FROM pipeline_stages WHERE pipeline_id = ANY($1::uuid[]) ORDER BY pipeline_id, position', [pipelines.map((p) => p.id)])).rows : [];
        const iw = listWhere(access, 'instance', 'read');
        const instances = canAccess(access, 'instance', 'read') ? (await c.query(`SELECT t.id, t.name, t.channel, t.status, t.phone, t.attention_reason, t.owner_id, t.team_id, t.ai_active, (SELECT u.name FROM users u WHERE u.id = t.owner_id) AS owner_name FROM instances t WHERE ${iw.sql} ORDER BY t.name`, iw.params)).rows : [];
        const teams = (await c.query('SELECT id, name, parent_id FROM teams ORDER BY name')).rows;

        // com quem cada negócio visível está compartilhado (a tela mostra e edita)
        const shareRows = deals.rows.length ? (await c.query("SELECT resource_id, subject_type AS type, subject_id AS id, level FROM resource_shares WHERE entity = 'deal' AND resource_id = ANY($1::uuid[])", [deals.rows.map((d) => d.id)])).rows : [];
        const sharedOf = (dealId) => shareRows.filter((x) => x.resource_id === dealId).map(({ type, id, level }) => ({ type, id, level }));
        const products = canAccess(access, 'product', 'read') ? (await c.query('SELECT id, name, unit, price FROM products WHERE active ORDER BY name')).rows : [];

        const taskW = listWhere(access, 'task', 'read');
        const taskRows = canAccess(access, 'task', 'read')
          ? (await c.query(`SELECT t.* FROM tasks t WHERE (${taskW.sql}) AND (t.status <> 'done' OR t.completed_at > now() - interval '30 days') ORDER BY t.due_at NULLS LAST, t.created_at DESC LIMIT 2000`, taskW.params)).rows
          : [];
        const taskShares = taskRows.length ? (await c.query("SELECT resource_id, subject_type AS type, subject_id AS id, level FROM resource_shares WHERE entity = 'task' AND resource_id = ANY($1::uuid[])", [taskRows.map((t) => t.id)])).rows : [];

        const dealByContact = new Map();
        for (const d of deals.rows) if (d.contact_id && !dealByContact.has(d.contact_id)) dealByContact.set(d.contact_id, d.id);
        const readRoles = canAccess(access, 'role', 'read');
        // perfis do tenant lidos do BANCO (o cache de acesso não conhece um perfil recém-criado)
        // Quem NÃO lê perfis recebe ao menos a definição dos PRÓPRIOS perfis personalizados: o front calcula menu
        // e telas com ela (sem isso, quem tem um perfil personalizado aparece como "Sem perfil" e sem acesso a nada).
        const tenantRoles = (
          readRoles
            ? await c.query('SELECT * FROM roles ORDER BY name')
            : await c.query('SELECT r.* FROM roles r WHERE r.id IN (SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id IS NOT NULL) ORDER BY r.name', [access.userId])
        ).rows.map((r) => apiRole(r));
        return {
          tenant: { id: access.tenantId, name: access.tenant?.name, policy: access.tenant?.settings || {} },
          currentUserId: access.userId,
          users: users.map((u) => ({
            id: u.id,
            tenantId: access.tenantId,
            name: u.name,
            email: readUsers || u.id === access.userId ? u.email : null,
            status: u.status,
            mfa: u.mfa_enabled,
            roleIds: readUsers || u.id === access.userId ? roleLinks.filter((l) => l.user_id === u.id).map((l) => l.system_role_id || l.role_id) : [],
            teamIds: memberLinks.filter((m) => m.user_id === u.id).map((m) => m.team_id),
          })),
          roles: [...E.SYSTEM_ROLES, ...tenantRoles],
          teams: teams.map((t) => ({ id: t.id, name: t.name, parentId: t.parent_id, members: memberLinks.filter((m) => m.team_id === t.id).length, pipelineId: null })),
          pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, teamId: null, stages: stages.filter((s) => s.pipeline_id === p.id).map((s) => ({ id: s.id, name: s.name, kind: s.kind, accent: s.kind === 'won' ? 'var(--green)' : s.kind === 'lost' ? 'var(--red)' : 'var(--acc)' })) })),
          // maskRow: campos que o perfil não pode ver (telefone, valor…) NEM saem do servidor
          contacts: [...contacts.rows, ...viaConversation].map((r) => apiContact(E.maskRow(access.ctx, 'contact', r))),
          deals: deals.rows.map((r) => ({ ...apiDeal(E.maskRow(access.ctx, 'deal', r)), sharedWith: sharedOf(r.id) })),
          agent: canAccess(access, 'ai_agent', 'read') ? await aiH.loadAgent(c) : undefined,
          tasks: taskRows.map((r) => taskH.apiTask(r, taskShares.filter((x) => x.resource_id === r.id).map(({ type, id, level }) => ({ type, id, level })))),
          products: products.map((r) => ({ id: r.id, name: r.name, unit: r.unit, price: Number(r.price) })),
          conversations: convs.rows.map((r) => ({ ...toApiConversation(r), dealId: dealByContact.get(r.contact_id) || null })),
          // "qr"/"conectando"/"fila" só valem se a sessão existe de fato agora; se o servidor reiniciou ou a
          // sessão caiu, o que está gravado é passado: informa "desconectada" (e a tela oferece reconectar).
          instances: instances.map((r) => apiInstance(['qr', 'connecting', 'queued', 'connected'].includes(r.status) && channel?.has && !channel.has({ id: r.id, tenantId: access.tenantId }) ? { ...r, status: 'disconnected' } : r)),
          permissions: E.effectiveMatrix(access.ctx),
        };
      },
      { readOnly: true }
    );
  });

  // ===================================================================== CONVERSAS
  route('GET', '/api/conversations/:id/messages', async ({ access, params, query }) => {
    const id = uuidOr400(params.id, 'Conversa');
    const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), 300);
    return tx(
      pool,
      access,
      async (c) => {
        await visibleConversation(c, access, id); // 404 se não puder ver
        const r = await c.query('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id LIMIT $2) m ORDER BY created_at, id', [id, limit]);
        return { messages: r.rows.map(apiMessage) };
      },
      { readOnly: true }
    );
  });

  route('POST', '/api/conversations/:id/messages', async ({ access, params, body }) => {
    const id = uuidOr400(params.id, 'Conversa');
    const kind = body.kind === 'note' ? 'note' : 'text';
    const text = String(body.text ?? '').trim();
    if (!text) throw bad('Escreva uma mensagem.');
    if (text.length > 4000) throw bad('Mensagem longa demais (máx. 4.000 caracteres).');
    const result = await tx(pool, access, async (c) => {
      const conv = await visibleConversation(c, access, id);
      must(access, 'conversation', kind === 'note' ? 'note' : 'send_message', convRow(conv));
      return postOut(c, access, conv, kind, text);
    });
    announce(access, result);
    return result;
  });

  route('POST', '/api/conversations/:id/read', async ({ access, params }) => {
    const id = uuidOr400(params.id, 'Conversa');
    await tx(pool, access, async (c) => {
      const conv = await visibleConversation(c, access, id);
      // só quem pode atender zera a não lida (supervisor/leitor não "consome" a fila de quem atende)
      const row = convRow(conv);
      const can = access.E.decide(access.ctx, 'conversation', 'send_message', row).effect === 'allow' || access.E.decide(access.ctx, 'conversation', 'note', row).effect === 'allow';
      if (can) await c.query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [id]);
    });
    return { ok: true };
  });

  route('PATCH', '/api/conversations/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Conversa');
    const conv = await tx(pool, access, async (c) => {
      const cur = await visibleConversation(c, access, id);
      const row = convRow(cur);
      let { assignee_id: assignee, team_id: team, status } = cur;
      if (body.status !== undefined) {
        if (!['open', 'queue', 'resolved'].includes(body.status)) throw bad('Status inválido.');
        must(access, 'conversation', 'resolve', row);
        status = body.status;
      }
      if (body.assigneeId !== undefined) {
        must(access, 'conversation', 'transfer', row);
        if (body.assigneeId === null) {
          assignee = null;
          team = null;
          if (status !== 'resolved') status = 'queue';
        } else {
          const to = uuidOr400(body.assigneeId, 'Destino');
          const target = await getAccess(pool, { userId: to, tenantId: access.tenantId });
          if (!target || target.user.status !== 'active') throw bad('O destino precisa ser um usuário ativo.');
          // o destino precisa poder ler E responder a conversa já atribuída a ele
          const asTarget = { ...row, assigneeId: to, teamId: target.teamIds[0] || null };
          if (target.E.decide(target.ctx, 'conversation', 'read', asTarget).effect !== 'allow') throw bad('O destino não tem permissão para atender esta conversa.');
          assignee = to;
          team = target.teamIds[0] || null;
          if (status === 'queue') status = 'open';
        }
      }
      const r = await c.query('UPDATE conversations SET assignee_id = $2, team_id = $3, status = $4 WHERE id = $1 RETURNING *', [id, assignee, team, status]);
      if (assignee !== cur.assignee_id) await audit(c, access, req, 'conversation.transfer', 'conversation', id, { from: cur.assignee_id, to: assignee });
      if (status !== cur.status && status === 'resolved') await audit(c, access, req, 'conversation.resolve', 'conversation', id, null);
      return toApiConversation(r.rows[0]);
    });
    return { conversation: conv };
  });


  /** Avisa em tempo real (só quem pode ler a conversa) que há mensagem nova. */
  const announce = (access, result) =>
    hub
      ?.emit(access.tenantId, { type: 'message', conversation: result.conversation, message: result.message }, { entity: 'conversation', row: { id: result.conversation.id, tenantId: access.tenantId, assigneeId: result.conversation.assigneeId, instanceId: result.conversation.instanceId, status: result.conversation.status } })
      .catch(() => {});

  /**
   * Grava (e, se for texto, ENVIA pelo WhatsApp) uma mensagem de saída numa conversa já liberada pelo motor.
   * Usada pela caixa de entrada e pelo envio de proposta. `id` da conversa vem de `conv.id`.
   */
  async function postOut(c, access, conv, kind, text) {
    const id = conv.id;
    let waId = null;
    if (kind === 'text') {
      const inst = (await c.query('SELECT id, name, channel, status FROM instances WHERE id = $1', [conv.instance_id])).rows[0];
      if (!channel) throw new HttpError(503, 'Canal de WhatsApp indisponível.');
      // O que está gravado pode estar velho (servidor reiniciado, sessão caída): vale a sessão VIVA.
      if (!inst || inst.status !== 'connected' || (channel.has && !channel.has({ id: inst.id, tenantId: access.tenantId }))) {
        throw new HttpError(409, 'O WhatsApp desta conversa está desconectado. Vá em Instâncias e reconecte o número.');
      }
      try {
        const sent = await channel.sendText({ id: inst.id, tenantId: access.tenantId }, conv.phone, text);
        waId = sent?.id || null;
      } catch (e) {
        throw new HttpError(e.status === 409 ? 409 : 502, e.status === 409 ? e.message : `Não foi possível enviar pelo WhatsApp agora (${String(e.message).slice(0, 120)}). Tente de novo.`);
      }
    }
    const msg = (
      await c.query(
        `INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, kind, body, author_id, status)
         VALUES ($1, $2, $3, 'out', $4, $5, $6, 'sent') RETURNING *`,
        [access.tenantId, id, waId, kind, text, access.userId]
      )
    ).rows[0];
    // responder uma conversa da fila a atribui a quem respondeu (só se o motor permitir a transferência)
    let assign = conv.assignee_id === null && kind === 'text' && access.E.decide(access.ctx, 'conversation', 'transfer', convRow(conv)).effect === 'allow';
    const upd = (
      await c.query(
        `UPDATE conversations SET
            last_message_at = CASE WHEN $2 THEN now() ELSE last_message_at END,
            last_message    = CASE WHEN $2 THEN left($3, 300) ELSE last_message END,
            assignee_id     = CASE WHEN $4 THEN $5::uuid ELSE assignee_id END,
            team_id         = CASE WHEN $4 THEN $6::uuid ELSE team_id END,
            status          = CASE WHEN $4 OR status = 'resolved' THEN 'open' ELSE status END,
      -- um humano respondeu: o Agente de IA para de responder esta conversa
      ai_paused       = CASE WHEN $2 THEN true ELSE ai_paused END
          WHERE id = $1 RETURNING *`,
        [id, kind === 'text', text, assign, access.userId, primaryTeam(access)]
      )
    ).rows[0];
    return { message: apiMessage(msg), conversation: toApiConversation(upd) };
  }

  // ===================================================================== CONTATOS E NEGÓCIOS
  route('POST', '/api/contacts', async ({ access, body }) => {
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').replace(/\D/g, '');
    const email = body.email ? String(body.email).trim().toLowerCase() : null;
    const company = body.company ? String(body.company).trim().slice(0, 200) || null : null;
    if (!name || name.length > 200) throw bad('Informe o nome (até 200 caracteres).');
    if (phone && !/^[0-9]{8,15}$/.test(phone)) throw bad('Telefone inválido (8 a 15 dígitos).');
    if (email && !EMAIL.test(email)) throw bad('E-mail inválido.');
    const row = { id: crypto.randomUUID(), tenantId: access.tenantId, ownerId: access.userId, teamId: primaryTeam(access) };
    must(access, 'contact', 'create', row);
    try {
      const r = await tx(pool, access, (c) => c.query('INSERT INTO contacts (id, tenant_id, owner_id, team_id, name, phone, email, source, company) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [row.id, row.tenantId, row.ownerId, row.teamId, name, phone || null, email, 'manual', company]));
      return { contact: apiContact(r.rows[0]) };
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'Já existe um contato com este telefone.');
      throw e;
    }
  });

  route('POST', '/api/deals', async ({ req, access, body }) => {
    const expectedClose = body.expectedClose === undefined ? null : parseDay(body.expectedClose);
    const title = String(body.title || '').trim();
    if (!title || title.length > 200) throw bad('Informe o título (até 200 caracteres).');
    const pipelineId = uuidOr400(body.pipelineId, 'Funil');
    const stageId = uuidOr400(body.stageId, 'Etapa');
    const contactId = body.contactId ? uuidOr400(body.contactId, 'Contato') : null;
    const value = body.value === undefined || body.value === null || body.value === '' ? null : Number(body.value);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1e12)) throw bad('Valor inválido.');
    return tx(pool, access, async (c) => {
      const st = (await c.query('SELECT kind FROM pipeline_stages WHERE id = $1 AND pipeline_id = $2', [stageId, pipelineId])).rows[0];
      if (!st) throw bad('A etapa não pertence a este funil.');
      // quem cria define o responsável; só cria para outra pessoa quem puder (a decisão é sobre o registro final)
      const ownerId = body.ownerId ? uuidOr400(body.ownerId, 'Responsável') : access.userId;
      const owner = ownerId === access.userId ? access : await getAccess(pool, { userId: ownerId, tenantId: access.tenantId });
      if (!owner || owner.user.status !== 'active') throw bad('O responsável precisa ser um usuário ativo.');
      const row = { id: crypto.randomUUID(), tenantId: access.tenantId, ownerId, teamId: owner.teamIds[0] || null, pipelineId, stageId, status: st.kind, value };
      must(access, 'deal', 'create', row);
      const r = await c.query('INSERT INTO deals (id, tenant_id, owner_id, team_id, title, pipeline_id, stage_id, status, value, contact_id, expected_close) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [row.id, row.tenantId, row.ownerId, row.teamId, title, pipelineId, stageId, row.status, value, contactId, expectedClose]);
      await audit(c, access, req, 'deal.create', 'deal', row.id, { title, stageId });
      return { deal: apiDeal(r.rows[0]) };
    });
  });

  route('PATCH', '/api/deals/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Negócio');
    return tx(pool, access, async (c) => {
      const cur = await visibleDeal(c, access, id);
      const before = await withShares(c, 'deal', dealRow(cur));
      const patch = {}; // chaves do catálogo (camelCase) — só as que o cliente PODE pedir
      const sets = [];
      const vals = [];
      const set = (col, v) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length + 1}`);
      };
      let context;
      if (body.title !== undefined) {
        const t = String(body.title).trim();
        if (!t || t.length > 200) throw bad('Título inválido.');
        patch.title = t;
        set('title', t);
      }
      if (body.value !== undefined && body.items === undefined) {
        const v = Number(body.value);
        if (!Number.isFinite(v) || v < 0 || v > 1e12) throw bad('Valor inválido.');
        patch.value = v;
        set('value', v);
      }
      if (body.expectedClose !== undefined) set('expected_close', parseDay(body.expectedClose));
      if (body.items !== undefined) {
        if (!Array.isArray(body.items) || body.items.length > 50) throw bad('Itens da proposta inválidos.');
        const ids = body.items.map((i) => uuidOr400(i?.productId, 'Produto'));
        const prods = ids.length ? (await c.query('SELECT id, name, unit, price FROM products WHERE id = ANY($1::uuid[]) AND active', [ids])).rows : [];
        const items = body.items.map((i) => {
          const pr = prods.find((x) => x.id === String(i.productId).toLowerCase());
          if (!pr) throw bad('Produto inexistente ou arquivado.');
          const qty = Math.floor(Number(i.qty));
          if (!(qty >= 1 && qty <= 100000)) throw bad('Quantidade inválida.');
          const unitPrice = Number(pr.price);
          return { productId: pr.id, name: pr.name, qty, unitPrice, note: qty > 1 ? `${qty} × ${pr.unit}` : pr.unit, total: Math.round(qty * unitPrice * 100) / 100 };
        });
        patch.items = items;
        set('items', JSON.stringify(items));
        if (items.length) {
          // o valor do negócio acompanha a proposta (sem itens, mantém o valor estimado)
          patch.value = Math.round(items.reduce((n, i) => n + i.total, 0) * 100) / 100;
          set('value', patch.value);
        }
      }
      if (body.stageId !== undefined) {
        const to = uuidOr400(body.stageId, 'Etapa');
        const stages = (await c.query('SELECT id, kind FROM pipeline_stages WHERE pipeline_id = $1 AND id IN ($2, $3)', [cur.pipeline_id, to, cur.stage_id])).rows;
        const dest = stages.find((s) => s.id === to);
        if (!dest) throw bad('A etapa não pertence ao funil deste negócio.');
        const from = stages.find((s) => s.id === cur.stage_id);
        // contexto da movimentação: DERIVADO DO BANCO (o cliente não pode declarar "etapa aberta")
        context = { fromStageId: cur.stage_id, toStageId: to, fromStageKind: from?.kind || 'open', toStageKind: dest.kind };
        patch.stageId = to;
        patch.status = dest.kind;
        set('stage_id', to);
        set('status', dest.kind);
        sets.push('stage_changed_at = now()');
      }
      if (body.ownerId !== undefined) {
        const to = uuidOr400(body.ownerId, 'Responsável');
        const target = await getAccess(pool, { userId: to, tenantId: access.tenantId });
        if (!target || target.user.status !== 'active') throw bad('O responsável precisa ser um usuário ativo.');
        patch.ownerId = to;
        patch.teamId = target.teamIds[0] || null;
        set('owner_id', to);
        set('team_id', patch.teamId);
      }
      if (!sets.length) throw bad('Nada para alterar.');
      const check = access.E.checkPatch(access.ctx, 'deal', before, patch, context);
      if (!check.ok) throw forbidden(check.denied.some((d) => d.reason === 'immutable') ? 'Campo não editável.' : 'Seu perfil não permite esta alteração.');
      // a etapa só muda se o motor também permitir `move` com o contexto real (negação do SDR p/ Ganho etc.)
      if (context) must(access, 'deal', 'move', before, context);
      const r = await c.query(`UPDATE deals SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals]);
      const edited = ['title', 'value', 'items', 'expectedClose'].filter((k) => body[k] !== undefined);
      if (edited.length) await audit(c, access, req, 'deal.update', 'deal', id, { fields: edited });
      if (context || patch.ownerId) await audit(c, access, req, context ? 'deal.move' : 'deal.transfer', 'deal', id, context ? { from: context.fromStageId, to: context.toStageId } : { from: cur.owner_id, to: patch.ownerId });
      return { deal: apiDeal(r.rows[0]) };
    });
  });

  // ===================================================================== INSTÂNCIAS (WhatsApp)
  route('POST', '/api/instances', async ({ req, access, body }) => {
    const name = String(body.name || '').trim();
    if (!name || name.length > 200) throw bad('Informe o nome (até 200 caracteres).');
    // Quem cria vira o RESPONSÁVEL: o número nasce PESSOAL dele (as conversas dele vão direto para ele).
    // Quem tem alcance "tudo" pode criar um número da empresa (sem responsável) com companyNumber:true.
    const asCompany = { tenantId: access.tenantId, ownerId: null, teamId: null };
    const company = body.companyNumber === true && access.E.decide(access.ctx, 'instance', 'create', asCompany).effect === 'allow';
    const row = company ? asCompany : { tenantId: access.tenantId, ownerId: access.userId, teamId: primaryTeam(access) };
    must(access, 'instance', 'create', row);
    const r = await tx(pool, access, async (c) => {
      const ins = await c.query("INSERT INTO instances (tenant_id, name, channel, status, owner_id, team_id) VALUES ($1, $2, 'baileys', 'disconnected', $3, $4) RETURNING *", [access.tenantId, name, row.ownerId, row.teamId]);
      await audit(c, access, req, 'instance.create', 'instance', ins.rows[0].id, { personal: !company });
      return ins;
    });
    return { instance: apiInstance({ ...r.rows[0], owner_name: company ? '' : access.user.name }) };
  });

  const loadInstance = async (access, id, action) => {
    const row = (await tx(pool, access, (c) => c.query('SELECT * FROM instances WHERE id = $1', [id]), { readOnly: true })).rows[0];
    if (!row) throw notFound('Número não encontrado.');
    must(access, 'instance', action, { id: row.id, tenantId: access.tenantId, ownerId: row.owner_id, teamId: row.team_id });
    return row;
  };

  route('POST', '/api/instances/:id/connect', async ({ access, params }) => {
    const inst = await loadInstance(access, uuidOr400(params.id, 'Número'), 'connect');
    if (!channel) throw new HttpError(503, 'Canal de WhatsApp indisponível neste servidor.');
    if (inst.channel !== 'baileys') throw bad('Este número usa a API oficial (conexão por Meta Business).');
    await channel.connect({ id: inst.id, tenantId: access.tenantId });
    return { ok: true };
  });

  route('GET', '/api/instances/:id/qr', async ({ access, params }) => {
    const inst = await loadInstance(access, uuidOr400(params.id, 'Número'), 'connect');
    return channel ? channel.state({ id: inst.id, tenantId: access.tenantId }) : { status: inst.status, qr: null };
  });

  route('POST', '/api/instances/:id/disconnect', async ({ access, params }) => {
    const inst = await loadInstance(access, uuidOr400(params.id, 'Número'), 'connect');
    if (channel) await channel.disconnect({ id: inst.id, tenantId: access.tenantId });
    return { ok: true };
  });

  // Remove o número: encerra a sessão (apaga as credenciais) e apaga o registro. Conversas do número só saem
  // com `?withConversations=1` e só se o usuário puder apagar TODAS elas (o motor decide, conversa a conversa).
  route('DELETE', '/api/instances/:id', async ({ req, access, params, query }) => {
    const id = uuidOr400(params.id, 'Número');
    const inst = await loadInstance(access, id, 'delete');
    const withConversations = query.get('withConversations') === '1';
    const stats = (await tx(pool, access, (c) => c.query('SELECT (SELECT count(*)::int FROM conversations WHERE instance_id = $1) AS convs, (SELECT count(*)::int FROM calls WHERE instance_id = $1) AS calls', [id]), { readOnly: true })).rows[0];
    if (stats.calls) throw new HttpError(409, `Este número tem ${stats.calls} chamada(s) registrada(s). Apague-as antes de remover.`);
    if (stats.convs && !withConversations) throw new HttpError(409, `Há ${stats.convs} ${stats.convs === 1 ? 'conversa' : 'conversas'} neste número. Confirme para apagá-las junto com o número.`);
    await tx(pool, access, async (c) => {
      if (stats.convs) {
        const dw = listWhere(access, 'conversation', 'delete');
        const allowed = (await c.query(`SELECT count(*)::int n FROM conversations t WHERE t.instance_id = $${dw.params.length + 1} AND (${dw.sql})`, [...dw.params, id])).rows[0].n;
        if (allowed !== stats.convs) throw forbidden('Você não pode apagar todas as conversas deste número, então ele não pode ser removido.');
        await c.query('DELETE FROM conversations WHERE instance_id = $1', [id]);
      }
      await c.query('DELETE FROM instances WHERE id = $1', [id]);
      await audit(c, access, req, 'instance.delete', 'instance', id, { name: inst.name, conversations: stats.convs });
    });
    // só depois de apagar o registro: encerra a sessão e apaga as credenciais (um "permissão negada" acima não derruba o número)
    if (channel) await channel.disconnect({ id, tenantId: access.tenantId }).catch(() => {});
    return { ok: true };
  });

  require('./dashboard')({ pool, route, must, tx, listWhere, canAccess, ttlMs: config.dashboardCacheMs });
  const taskH = { pool, route, must, bad, notFound, uuidOr400, tx, listWhere, getAccess, audit, withShares, primaryTeam, hub };
  require('./routes-tasks')(taskH);
  const aiH = { pool, route, must, bad, notFound, HttpError, uuidOr400, tx, audit, openai };
  require('./ai-routes')(aiH);
  require('./routes-crm')({ pool, route, must, bad, forbidden, notFound, HttpError, uuidOr400, tx, listWhere, getAccess, audit, withShares, visibleDeal, convRow, dealRow, apiContact, apiDeal, apiInstance, postOut, announce, EMAIL });

  // ===================================================================== USUÁRIOS
  route('POST', '/api/users/invite', async ({ req, access, body }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim() || email.split('@')[0];
    if (!EMAIL.test(email) || email.length > 254) throw bad('E-mail inválido.');
    if (name.length > 200) throw bad('Nome longo demais.');
    must(access, 'user', 'create', { tenantId: access.tenantId });
    must(access, 'role', 'assign', { tenantId: access.tenantId });
    const roleId = String(body.roleId || '');
    const found = await tx(pool, access, (c) => roleDefinition(c, access, roleId), { readOnly: true });
    if (!found) throw bad('Perfil inexistente.');
    const roleDef = found.def;
    const sysRole = found.system ? roleDef : null;
    const tenantRole = found.system ? null : roleDef;
    // "ninguém concede o que não tem": o perfil atribuído não pode exceder o poder de quem convida
    const esc = access.E.checkNoEscalation(access.ctx, roleDef);
    if (!esc.ok) throw forbidden('Você não pode atribuir um perfil com mais poder do que o seu.');
    const teamId = body.teamId ? uuidOr400(body.teamId, 'Equipe') : null;
    const invite = newInviteToken();
    const userId = crypto.randomUUID();
    try {
      await tx(pool, access, async (c) => {
        await c.query("INSERT INTO users (id, tenant_id, email, name, status) VALUES ($1, $2, $3, $4, 'invited')", [userId, access.tenantId, email, name]);
        await c.query('INSERT INTO user_roles (tenant_id, user_id, system_role_id, role_id, granted_by) VALUES ($1, $2, $3, $4, $5)', [access.tenantId, userId, sysRole ? roleDef.id : null, tenantRole ? roleDef.id : null, access.userId]);
        if (teamId) await c.query('INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1, $2, $3)', [access.tenantId, teamId, userId]);
        await c.query('SELECT auth_register($1, $2, $3)', [userId, email, invite.hash]);
        await audit(c, access, req, 'user.invite', 'user', userId, { email, role: roleDef.name });
      });
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'Já existe uma conta com este e-mail.');
      if (e.code === '23503') throw bad('Equipe inexistente.');
      throw e;
    }
    const base = publicBase(req);
    return { userId, inviteUrl: `${base}/#/accept?token=${invite.token}`, expiresInDays: 7 };
  });

  route('PATCH', '/api/users/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Usuário');
    if (!['active', 'suspended'].includes(body.status)) throw bad('Status inválido.');
    must(access, 'user', 'update', { tenantId: access.tenantId });
    if (id === access.userId) throw bad('Você não pode alterar o seu próprio status.');
    await tx(pool, access, async (c) => {
      const users = (await c.query('SELECT u.id, u.tenant_id, u.status FROM users u')).rows;
      const roleLinks = (await c.query('SELECT user_id, system_role_id, role_id FROM user_roles')).rows;
      const target = users.find((u) => u.id === id);
      if (!target) throw notFound('Usuário não encontrado.');
      if (!['active', 'suspended'].includes(target.status)) throw bad('O usuário ainda não aceitou o convite.');
      const asList = users.map((u) => ({ id: u.id, tenantId: u.tenant_id, status: u.status, roleIds: roleLinks.filter((l) => l.user_id === u.id).map((l) => l.system_role_id || l.role_id) }));
      if (access.E.wouldRemoveLastAdmin(asList, access.ctx.roles, access.tenantId, { userId: id, status: body.status })) throw bad('Isto deixaria a empresa sem nenhum administrador ativo.');
      await c.query('UPDATE users SET status = $2 WHERE id = $1', [id, body.status]);
      await audit(c, access, req, body.status === 'suspended' ? 'user.suspend' : 'user.reactivate', 'user', id, { from: target.status, to: body.status });
    });
    invalidate(access.tenantId, id);
    return { ok: true };
  });


  // Troca TODOS os perfis de um usuário (substitui o conjunto). Travas: quem altera precisa de
  // role.assign; não altera os próprios perfis; só concede/retira perfil que ELE MESMO poderia conceder
  // (anti-escalonamento, nos dois sentidos: não dá o que não tem nem rebaixa quem tem mais poder);
  // nunca deixa a empresa sem administrador ativo.
  route('POST', '/api/users/:id/roles', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Usuário');
    must(access, 'role', 'assign', { tenantId: access.tenantId });
    if (id === access.userId) throw bad('Você não pode alterar os seus próprios perfis.');
    const wanted = Array.isArray(body.roleIds) ? [...new Set(body.roleIds.map((r) => String(r).toLowerCase()))] : null;
    if (!wanted || wanted.length < 1 || wanted.length > 10) throw bad('Escolha de 1 a 10 perfis.');
    await tx(pool, access, async (c) => {
      const defOf = async (rid) => (await roleDefinition(c, access, rid))?.def || null;
      const wantedDefs = [];
      for (const rid of wanted) wantedDefs.push((await defOf(rid)) || (() => { throw bad('Perfil inexistente.'); })());
      const users = (await c.query('SELECT u.id, u.tenant_id, u.status FROM users u')).rows;
      const links = (await c.query('SELECT user_id, system_role_id, role_id FROM user_roles')).rows;
      const target = users.find((u) => u.id === id);
      if (!target) throw notFound('Usuário não encontrado.');
      const current = links.filter((l) => l.user_id === id).map((l) => l.system_role_id || l.role_id);
      for (const def of wantedDefs) {
        if (!current.includes(def.id) && !access.E.checkNoEscalation(access.ctx, def).ok) throw forbidden('Você não pode atribuir um perfil com mais poder do que o seu.');
      }
      for (const rid of current) {
        const def = !wanted.includes(rid) ? await defOf(rid) : null;
        if (def && !access.E.checkNoEscalation(access.ctx, def).ok) throw forbidden('Você não pode retirar um perfil com mais poder do que o seu.');
      }
      if (access.E.wouldRemoveLastAdmin(users.map((u) => ({ id: u.id, tenantId: u.tenant_id, status: u.status, roleIds: links.filter((l) => l.user_id === u.id).map((l) => l.system_role_id || l.role_id) })), access.ctx.roles, access.tenantId, { userId: id, roleIds: wanted })) {
        throw bad('Isto deixaria a empresa sem nenhum administrador ativo.');
      }
      await c.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      for (const def of wantedDefs) {
        const sys = access.E.SYSTEM_ROLES.some((r) => r.id === def.id);
        await c.query('INSERT INTO user_roles (tenant_id, user_id, system_role_id, role_id, granted_by) VALUES ($1, $2, $3, $4, $5)', [access.tenantId, id, sys ? def.id : null, sys ? null : def.id, access.userId]);
      }
      await audit(c, access, req, 'role.assign', 'user', id, { from: current, to: wanted });
    });
    invalidate(access.tenantId, id);
    return { ok: true };
  });

  // Troca as equipes de um usuário. Equipe define o alcance de "Equipe" e "Equipe e subequipes", então
  // mexer nela é mexer em permissão: exige user.update e não vale para si mesmo.
  route('POST', '/api/users/:id/teams', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Usuário');
    must(access, 'user', 'update', { tenantId: access.tenantId });
    if (id === access.userId) throw bad('Você não pode alterar a sua própria equipe.');
    const teamIds = Array.isArray(body.teamIds) ? [...new Set(body.teamIds.map((t) => uuidOr400(t, 'Equipe')))] : null;
    if (!teamIds || teamIds.length > 20) throw bad('Lista de equipes inválida.');
    await tx(pool, access, async (c) => {
      if (!(await c.query('SELECT 1 FROM users WHERE id = $1', [id])).rowCount) throw notFound('Usuário não encontrado.');
      if (teamIds.length && (await c.query('SELECT id FROM teams WHERE id = ANY($1::uuid[])', [teamIds])).rowCount !== teamIds.length) throw bad('Equipe inexistente.');
      const before = (await c.query('SELECT team_id FROM team_members WHERE user_id = $1', [id])).rows.map((r) => r.team_id);
      await c.query('DELETE FROM team_members WHERE user_id = $1', [id]);
      for (const t of teamIds) await c.query('INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1, $2, $3)', [access.tenantId, t, id]);
      await audit(c, access, req, 'user.teams', 'user', id, { from: before, to: teamIds });
    });
    invalidate(access.tenantId, id);
    return { ok: true };
  });

  // ===================================================================== PERFIS DO TENANT
  // Perfis de fábrica vivem no código e são imutáveis; estes são os do tenant (tabela roles, JSONB).
  const apiRole = (r) => ({ ...r.definition, id: r.id, name: r.name, description: r.description || '', tenantId: r.tenant_id, system: false });

  /** Valida o perfil candidato pelo MOTOR e recusa escalonamento (o ator só concede o que ele mesmo tem). */
  function vetRole(access, id, { name, description, definition }) {
    const nm = String(name ?? '').trim();
    if (!nm || nm.length > 60) throw bad('Nome do perfil: de 1 a 60 caracteres.');
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw bad('Definição do perfil inválida.');
    if (JSON.stringify(definition).length > 100000) throw bad('Definição do perfil grande demais.');
    const def = { grants: definition.grants ?? [], denies: definition.denies ?? [], partitions: definition.partitions ?? {}, fields: definition.fields ?? [] };
    const candidate = { id, name: nm, description: String(description ?? '').slice(0, 500), tenantId: access.tenantId, system: false, ...def };
    const errors = access.E.validateRole(candidate);
    if (errors.length) throw bad(`Perfil inválido: ${errors.slice(0, 3).map((e) => e.message).join('; ')}`);
    if (!access.E.checkNoEscalation(access.ctx, candidate).ok) throw forbidden('Você não pode criar ou alterar um perfil com mais poder do que o seu.');
    return { candidate, def };
  }

  route('POST', '/api/roles', async ({ req, access, body }) => {
    must(access, 'role', 'create', { tenantId: access.tenantId });
    const id = crypto.randomUUID();
    const { candidate, def } = vetRole(access, id, body);
    const cloned = access.E.SYSTEM_ROLES.some((r) => r.id === body.clonedFrom) ? body.clonedFrom : null;
    const role = await tx(pool, access, async (c) => {
      const r = (await c.query('INSERT INTO roles (id, tenant_id, name, description, cloned_from, definition) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *', [id, access.tenantId, candidate.name, candidate.description, cloned, JSON.stringify(def)])).rows[0];
      await audit(c, access, req, 'role.create', 'role', id, { name: candidate.name });
      return apiRole(r);
    });
    return { role };
  });

  route('PATCH', '/api/roles/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Perfil');
    must(access, 'role', 'update', { tenantId: access.tenantId });
    const result = await tx(pool, access, async (c) => {
      const cur = (await c.query('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('Perfil não encontrado.');
      const before = apiRole(cur);
      const { candidate, def } = vetRole(access, id, { name: body.name ?? before.name, description: body.description ?? before.description, definition: body.definition ?? { grants: before.grants, denies: before.denies, partitions: before.partitions, fields: before.fields } });
      const r = (await c.query('UPDATE roles SET name = $2, description = $3, definition = $4::jsonb WHERE id = $1 RETURNING *', [id, candidate.name, candidate.description, JSON.stringify(def)])).rows[0];
      await audit(c, access, req, 'role.update', 'role', id, { changes: access.E.diffRoles(before, candidate).length });
      const holders = (await c.query('SELECT user_id FROM user_roles WHERE role_id = $1', [id])).rows;
      return { role: apiRole(r), holders: holders.map((h) => h.user_id) };
    });
    for (const uid of result.holders) invalidate(access.tenantId, uid);
    return { role: result.role };
  });

  route('DELETE', '/api/roles/:id', async ({ req, access, params }) => {
    const id = uuidOr400(params.id, 'Perfil');
    must(access, 'role', 'delete', { tenantId: access.tenantId });
    await tx(pool, access, async (c) => {
      const cur = (await c.query('SELECT name FROM roles WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('Perfil não encontrado.');
      const used = (await c.query('SELECT count(*)::int n FROM user_roles WHERE role_id = $1', [id])).rows[0].n;
      if (used) throw new HttpError(409, `${used === 1 ? '1 usuário usa' : `${used} usuários usam`} este perfil. Troque o perfil deles antes de excluir.`);
      await c.query('DELETE FROM roles WHERE id = $1', [id]);
      await audit(c, access, req, 'role.delete', 'role', id, { name: cur.name });
    });
    return { ok: true };
  });

  // ===================================================================== MÍDIA
  route('GET', '/api/whatsapp/media/:filename', async ({ access, params, res }) => {
    const media = `/api/whatsapp/media/${params.filename}`;
    const msg = await tx(pool, access, async (c) => {
      const m = (await c.query('SELECT conversation_id FROM messages WHERE media_url = $1 LIMIT 1', [media])).rows[0];
      if (!m) throw notFound();
      await visibleConversation(c, access, m.conversation_id); // só quem vê a conversa vê a mídia
      return m;
    }, { readOnly: true });
    void msg;
    let file;
    try {
      file = await downloadMediaByFilename(decodeURIComponent(params.filename));
    } catch {
      throw notFound();
    }
    res.writeHead(200, { 'Content-Type': file.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    res.end(file.buffer);
    return undefined; // resposta já enviada
  });

  // ===================================================================== despacho
  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  /** Atende /api/*. Devolve false se a URL não for da API (o servidor segue para os estáticos). */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    try {
      if (!ipLimiter(ipOf(req))) throw new HttpError(429, 'Muitas requisições.');
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw notFound('Rota inexistente.');
      const params = { ...(url.pathname.match(r.re)?.groups || {}) };
      let access = null;
      if (r.auth) {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        const claims = m && verifyToken(m[1], config.authSecret);
        if (!claims || claims.kind || !UUID.test(claims.sub || '') || !UUID.test(claims.tid || '')) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
        access = await getAccess(pool, { userId: claims.sub, tenantId: claims.tid });
        if (!access || access.user.status !== 'active') throw new HttpError(401, 'Sessão inválida.');
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req, r.limit);
      const out = await r.handler({ req, res, params, query: url.searchParams, body, access });
      if (out !== undefined) sendJson(res, 200, out);
    } catch (e) {
      if (res.headersSent) return true;
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
      else {
        console.error('[api] erro interno:', e);
        sendJson(res, 500, { error: 'Erro interno.' });
      }
    }
    return true;
  }

  return { handle };
}

module.exports = { createApp, HttpError };
