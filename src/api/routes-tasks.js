'use strict';
// Tarefas: individuais (responsável = dono), compartilháveis e delegáveis; avulsas ou ligadas a negócio/contato.
// Mesmas regras de ouro do app.js: o MOTOR decide; o registro é lido do banco com o filtro do motor; o contexto
// nunca vem do corpo da requisição.
//  - Delegar = trocar o responsável (`task.transfer`). Quem delegou continua VENDO a tarefa (regra de fábrica por
//    `createdBy`); por isso a delegação não passa pelo "resultado ainda no meu escopo" do checkPatch.
//  - Vínculos (negócio/contato) só com registros que o próprio usuário pode ler.
//  - Histórico (delegou, concluiu, compartilhou…) e comentários ficam em task_comments (só inserção).

const STATUSES = ['todo', 'doing', 'waiting', 'done'];
const PRIORITIES = ['normal', 'high', 'urgent'];
const STATUS_TEXT = { todo: 'A fazer', doing: 'Em andamento', waiting: 'Aguardando', done: 'Feita' };
const ms = (d) => (d ? new Date(d).getTime() : null);

module.exports = function registerTaskRoutes(H) {
  const { route, must, bad, notFound, uuidOr400, tx, listWhere, getAccess, audit, withShares, primaryTeam, hub } = H;

  const apiTask = (r, sharedWith = []) => ({
    id: r.id,
    title: r.title,
    description: r.description || '',
    status: r.status,
    priority: r.priority,
    dueAt: ms(r.due_at),
    dueHasTime: !!r.due_has_time,
    ownerId: r.owner_id,
    teamId: r.team_id,
    createdBy: r.created_by,
    dealId: r.deal_id,
    contactId: r.contact_id,
    checklist: Array.isArray(r.checklist) ? r.checklist : [],
    completedAt: ms(r.completed_at),
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    sharedWith,
  });
  const taskRow = (r) => ({ id: r.id, tenantId: r.tenant_id, ownerId: r.owner_id, teamId: r.team_id, status: r.status, priority: r.priority, dealId: r.deal_id, contactId: r.contact_id, createdBy: r.created_by });
  H.apiTask = apiTask;

  async function visibleTask(c, access, id) {
    const w = listWhere(access, 'task', 'read');
    const r = await c.query(`SELECT t.* FROM tasks t WHERE t.id = $${w.params.length + 1} AND ${w.sql}`, [...w.params, id]);
    if (!r.rowCount) throw notFound('Tarefa não encontrada.');
    return r.rows[0];
  }

  /** Quem pode ver a tarefa agora: a notificação em tempo real vai só para essas pessoas (decisão do motor por conexão). */
  const announce = (access, r, shared = []) =>
    hub?.emit(access.tenantId, { type: 'tasks', taskId: r.id }, { entity: 'task', row: { ...taskRow(r), sharedWith: shared } }).catch(() => {});

  const event = (c, access, taskId, body) => c.query("INSERT INTO task_comments (tenant_id, task_id, author_id, kind, body) VALUES ($1, $2, $3, 'event', $4)", [access.tenantId, taskId, access.userId, body]);
  const nameOf = async (c, id) => (await c.query('SELECT name FROM users WHERE id = $1', [id])).rows[0]?.name || 'alguém';

  function parseDue(v) {
    if (v === null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(String(v));
    if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > Date.UTC(2100, 0, 1)) throw bad('Prazo inválido.');
    return new Date(t).toISOString();
  }
  function parseChecklist(list) {
    if (!Array.isArray(list) || list.length > 50) throw bad('Checklist inválido (até 50 itens).');
    return list.map((i, n) => {
      const text = String(i?.text ?? '').trim();
      if (!text || text.length > 300) throw bad('Cada item do checklist precisa ter de 1 a 300 caracteres.');
      return { id: String(i?.id || `i${n}${Math.random().toString(36).slice(2, 6)}`).slice(0, 40), text, done: i?.done === true };
    });
  }
  /** Negócio/contato só se o usuário puder LER o registro (senão a tarefa vazaria o título ao colaborador). */
  async function linkable(c, access, entity, table, id, label) {
    if (id === null || id === undefined || id === '') return null;
    const uid = uuidOr400(id, label);
    const w = listWhere(access, entity, 'read');
    const r = await c.query(`SELECT t.* FROM ${table} t WHERE t.id = $${w.params.length + 1} AND ${w.sql}`, [...w.params, uid]);
    if (!r.rowCount) throw bad(`${label} inexistente ou fora do seu acesso.`);
    return r.rows[0];
  }

  // ===================================================================== CRIAR
  route('POST', '/api/tasks', async ({ req, access, body }) => {
    const title = String(body.title || '').trim();
    if (!title || title.length > 500) throw bad('Informe o título da tarefa (até 500 caracteres).');
    const description = body.description ? String(body.description).slice(0, 10000) : null;
    const priority = body.priority === undefined ? 'normal' : body.priority;
    if (!PRIORITIES.includes(priority)) throw bad('Prioridade inválida.');
    const status = body.status === undefined ? 'todo' : body.status;
    if (!STATUSES.includes(status)) throw bad('Status inválido.');
    const dueAt = body.dueAt === undefined ? null : parseDue(body.dueAt);
    const checklist = body.checklist === undefined ? [] : parseChecklist(body.checklist);
    const out = await tx(H.pool, access, async (c) => {
      const deal = await linkable(c, access, 'deal', 'deals', body.dealId, 'Negócio');
      let contact = await linkable(c, access, 'contact', 'contacts', body.contactId, 'Contato');
      if (deal && !contact && deal.contact_id) contact = { id: deal.contact_id }; // o contato do negócio vem junto
      // a tarefa nasce do usuário; passar para outra pessoa é DELEGAR (exige `transfer`)
      const mine = { id: 'novo', tenantId: access.tenantId, ownerId: access.userId, teamId: primaryTeam(access), status, priority, dealId: deal?.id || null, contactId: contact?.id || null, createdBy: access.userId };
      must(access, 'task', 'create', mine);
      let ownerId = access.userId;
      let teamId = primaryTeam(access);
      let delegatedTo = null;
      if (body.ownerId && String(body.ownerId).toLowerCase() !== access.userId) {
        must(access, 'task', 'transfer', mine);
        ownerId = uuidOr400(body.ownerId, 'Responsável');
        const target = await getAccess(H.pool, { userId: ownerId, tenantId: access.tenantId });
        if (!target || target.user.status !== 'active') throw bad('O responsável precisa ser um usuário ativo.');
        teamId = target.teamIds[0] || null;
        delegatedTo = target.user.name;
      }
      const r = (
        await c.query(
          `INSERT INTO tasks (tenant_id, owner_id, team_id, title, description, status, priority, due_at, due_has_time, deal_id, contact_id, created_by, checklist, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb, CASE WHEN $6 = 'done' THEN now() END) RETURNING *`,
          [access.tenantId, ownerId, teamId, title, description, status, priority, dueAt, !!(dueAt && body.dueHasTime), deal?.id || null, contact?.id || null, access.userId, JSON.stringify(checklist)]
        )
      ).rows[0];
      if (delegatedTo) await event(c, access, r.id, `${access.user.name} delegou esta tarefa para ${delegatedTo}`);
      await audit(c, access, req, 'task.create', 'task', r.id, { delegated: !!delegatedTo, dealId: r.deal_id });
      return r;
    });
    announce(access, out);
    return { task: apiTask(out) };
  });

  // ===================================================================== EDITAR
  route('PATCH', '/api/tasks/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Tarefa');
    const out = await tx(H.pool, access, async (c) => {
      const cur = await visibleTask(c, access, id);
      const before = await withShares(c, 'task', taskRow(cur));
      must(access, 'task', 'update', before);
      const sets = ['updated_at = now()'];
      const vals = [];
      const set = (col, v, cast = '') => {
        vals.push(v);
        sets.push(`${col} = $${vals.length + 1}${cast}`);
      };
      let statusEvent = null;
      if (body.title !== undefined) {
        const t = String(body.title).trim();
        if (!t || t.length > 500) throw bad('Título inválido (de 1 a 500 caracteres).');
        set('title', t);
      }
      if (body.description !== undefined) set('description', body.description ? String(body.description).slice(0, 10000) : null);
      if (body.priority !== undefined) {
        if (!PRIORITIES.includes(body.priority)) throw bad('Prioridade inválida.');
        set('priority', body.priority);
      }
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) throw bad('Status inválido.');
        if (body.status !== cur.status) {
          set('status', body.status);
          sets.push(body.status === 'done' ? 'completed_at = now()' : 'completed_at = NULL');
          statusEvent = body.status === 'done' ? 'marcou como feita' : cur.status === 'done' ? `reabriu a tarefa (${STATUS_TEXT[body.status]})` : `mudou o status para ${STATUS_TEXT[body.status]}`;
        }
      }
      if (body.dueAt !== undefined) {
        const d = parseDue(body.dueAt);
        set('due_at', d);
        set('due_has_time', !!(d && body.dueHasTime));
      } else if (body.dueHasTime !== undefined && cur.due_at) set('due_has_time', !!body.dueHasTime);
      if (body.checklist !== undefined) set('checklist', JSON.stringify(parseChecklist(body.checklist)), '::jsonb');
      if (body.dealId !== undefined) {
        const deal = await linkable(c, access, 'deal', 'deals', body.dealId, 'Negócio');
        set('deal_id', deal?.id || null);
        if (deal?.contact_id && body.contactId === undefined && !cur.contact_id) set('contact_id', deal.contact_id);
      }
      if (body.contactId !== undefined) {
        const contact = await linkable(c, access, 'contact', 'contacts', body.contactId, 'Contato');
        set('contact_id', contact?.id || null);
      }
      if (sets.length === 1) throw bad('Nada para alterar.');
      const r = (await c.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals])).rows[0];
      if (statusEvent) await event(c, access, id, `${access.user.name} ${statusEvent}`);
      await audit(c, access, req, 'task.update', 'task', id, { fields: Object.keys(body).filter((k) => ['title', 'description', 'priority', 'status', 'dueAt', 'dueHasTime', 'checklist', 'dealId', 'contactId'].includes(k)) });
      return { r, shared: before.sharedWith };
    });
    announce(access, out.r, out.shared);
    return { task: apiTask(out.r, out.shared) };
  });

  // ===================================================================== DELEGAR
  route('POST', '/api/tasks/:id/delegate', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Tarefa');
    const to = uuidOr400(body.ownerId, 'Responsável');
    const out = await tx(H.pool, access, async (c) => {
      const cur = await visibleTask(c, access, id);
      const before = await withShares(c, 'task', taskRow(cur));
      must(access, 'task', 'transfer', before);
      if (to === cur.owner_id) throw bad('A tarefa já é desta pessoa.');
      const target = await getAccess(H.pool, { userId: to, tenantId: access.tenantId });
      if (!target || target.user.status !== 'active') throw bad('O responsável precisa ser um usuário ativo.');
      const r = (await c.query('UPDATE tasks SET owner_id = $2, team_id = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, to, target.teamIds[0] || null])).rows[0];
      await event(c, access, id, to === access.userId ? `${access.user.name} assumiu a tarefa` : `${access.user.name} delegou a tarefa para ${target.user.name}`);
      await audit(c, access, req, 'task.delegate', 'task', id, { from: cur.owner_id, to });
      return { r, shared: before.sharedWith, from: cur.owner_id };
    });
    announce(access, out.r, out.shared);
    // quem perdeu a tarefa também precisa saber (a conexão dele decide se ainda pode vê-la)
    hub?.emit(access.tenantId, { type: 'tasks', taskId: id }, { entity: 'task', row: { ...taskRow(out.r), ownerId: out.from, sharedWith: [] } }).catch(() => {});
    return { task: apiTask(out.r, out.shared) };
  });

  // ===================================================================== COMPARTILHAR
  route('POST', '/api/tasks/:id/shares', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Tarefa');
    if (!['user', 'team'].includes(body.type) || !['read', 'edit'].includes(body.level)) throw bad('Informe com quem compartilhar e o nível (leitura ou edição).');
    const subjectId = uuidOr400(body.id, body.type === 'user' ? 'Usuário' : 'Equipe');
    const out = await tx(H.pool, access, async (c) => {
      const cur = await visibleTask(c, access, id);
      must(access, 'task', 'share', await withShares(c, 'task', taskRow(cur)));
      const ok = (await c.query(body.type === 'user' ? "SELECT name FROM users WHERE id = $1 AND status = 'active'" : 'SELECT name FROM teams WHERE id = $1', [subjectId])).rows[0];
      if (!ok) throw bad(body.type === 'user' ? 'Usuário inexistente ou inativo.' : 'Equipe inexistente.');
      await c.query(
        `INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level, created_by) VALUES ($1, 'task', $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, entity, resource_id, subject_type, subject_id) DO UPDATE SET level = EXCLUDED.level`,
        [access.tenantId, id, body.type, subjectId, body.level, access.userId]
      );
      await event(c, access, id, `${access.user.name} compartilhou com ${body.type === 'team' ? 'a equipe ' : ''}${ok.name} (${body.level === 'edit' ? 'edição' : 'leitura'})`);
      await audit(c, access, req, 'task.share', 'task', id, { type: body.type, subjectId, level: body.level });
      return { cur, shared: (await withShares(c, 'task', { id })).sharedWith };
    });
    announce(access, out.cur, out.shared);
    return { sharedWith: out.shared };
  });

  route('DELETE', '/api/tasks/:id/shares/:type/:subjectId', async ({ req, access, params }) => {
    const id = uuidOr400(params.id, 'Tarefa');
    if (!['user', 'team'].includes(params.type)) throw bad('Tipo inválido.');
    const subjectId = uuidOr400(params.subjectId, 'Destino');
    const out = await tx(H.pool, access, async (c) => {
      const cur = await visibleTask(c, access, id);
      must(access, 'task', 'share', await withShares(c, 'task', taskRow(cur)));
      await c.query("DELETE FROM resource_shares WHERE entity = 'task' AND resource_id = $1 AND subject_type = $2 AND subject_id = $3", [id, params.type, subjectId]);
      await audit(c, access, req, 'task.unshare', 'task', id, { type: params.type, subjectId });
      return { cur, shared: (await withShares(c, 'task', { id })).sharedWith };
    });
    announce(access, out.cur, out.shared);
    return { sharedWith: out.shared };
  });

  // ===================================================================== EXCLUIR
  route('DELETE', '/api/tasks/:id', async ({ req, access, params }) => {
    const id = uuidOr400(params.id, 'Tarefa');
    const cur = await tx(H.pool, access, async (c) => {
      const row = await visibleTask(c, access, id);
      must(access, 'task', 'delete', await withShares(c, 'task', taskRow(row)));
      await c.query('DELETE FROM tasks WHERE id = $1', [id]);
      await audit(c, access, req, 'task.delete', 'task', id, { title: row.title });
      return row;
    });
    announce(access, cur);
    return { ok: true };
  });

  // ===================================================================== COMENTÁRIOS E HISTÓRICO
  route('GET', '/api/tasks/:id/comments', async ({ access, params }) => {
    const id = uuidOr400(params.id, 'Tarefa');
    return tx(
      H.pool,
      access,
      async (c) => {
        await visibleTask(c, access, id);
        const rows = (await c.query('SELECT id, author_id, kind, body, created_at FROM task_comments WHERE task_id = $1 ORDER BY created_at, id LIMIT 500', [id])).rows;
        return { comments: rows.map((r) => ({ id: r.id, authorId: r.author_id, kind: r.kind, text: r.body, at: ms(r.created_at) })) };
      },
      { readOnly: true }
    );
  });

  route('POST', '/api/tasks/:id/comments', async ({ access, params, body }) => {
    const id = uuidOr400(params.id, 'Tarefa');
    const text = String(body.text || '').trim();
    if (!text || text.length > 5000) throw bad('Escreva o comentário (até 5000 caracteres).');
    return tx(H.pool, access, async (c) => {
      await visibleTask(c, access, id); // quem enxerga a tarefa pode comentar
      const r = (await c.query("INSERT INTO task_comments (tenant_id, task_id, author_id, kind, body) VALUES ($1, $2, $3, 'comment', $4) RETURNING id, author_id, kind, body, created_at", [access.tenantId, id, access.userId, text])).rows[0];
      await c.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [id]);
      return { comment: { id: r.id, authorId: r.author_id, kind: r.kind, text: r.body, at: ms(r.created_at) } };
    });
  });

};
