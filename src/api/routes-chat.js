'use strict';
// Chat interno (conversa direta e grupos entre pessoas da MESMA empresa) e o perfil do próprio usuário.
//  - Só quem participa da sala lê e escreve nela (a API confere a participação em toda rota; nem o Admin lê conversa alheia).
//  - Conversa direta é uma sala por par de pessoas (dm_key); grupos têm nome e quem participa pode convidar mais gente.
//  - Só pessoas ativas (não robôs) entram. Mensagens não se editam nem se apagam. O tempo real vai SÓ aos participantes.
//  - Perfil: cada pessoa edita o PRÓPRIO nome, cargo, telefone e "sobre" (não passa pelo motor: é dado da própria pessoa).

const ms = (d) => (d ? new Date(d).getTime() : null);
const MAX_GROUP = 50;

module.exports = function registerChatRoutes(H) {
  const { route, bad, notFound, HttpError, uuidOr400, tx, audit, hub } = H;

  const apiMessage = (r) => ({ id: r.id, roomId: r.room_id, authorId: r.author_id, body: r.body, at: ms(r.created_at) });
  const apiRoom = (r, members) => ({ id: r.id, kind: r.kind, name: r.name || null, members, createdBy: r.created_by, lastAt: ms(r.last_message_at), lastBody: r.last_body || '', lastAuthorId: r.last_author_id || null, unread: r.unread || 0 });
  const tell = (access, userIds, event) => hub?.emitTo?.(access.tenantId, userIds, event);

  async function roomFor(c, access, id) {
    const r = (await c.query('SELECT r.* FROM chat_rooms r JOIN chat_members m ON m.room_id = r.id AND m.user_id = $2 WHERE r.id = $1', [id, access.userId])).rows[0];
    if (!r) throw notFound('Conversa não encontrada.');
    return r;
  }
  const membersOf = async (c, id) => (await c.query('SELECT user_id FROM chat_members WHERE room_id = $1 ORDER BY joined_at, user_id', [id])).rows.map((x) => x.user_id);

  /** Pessoas que podem entrar numa sala: ativas e que não são robô (o bootstrap só lista usuários humanos de todo modo). */
  async function activePeople(c, ids) {
    const r = await c.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'active'", [ids]);
    const ok = new Set(r.rows.map((x) => x.id));
    if (ids.some((i) => !ok.has(i))) throw bad('Só dá para conversar com pessoas ativas da empresa.');
  }

  async function loadRoom(c, access, id) {
    const r = (
      await c.query(
        `SELECT r.*, (SELECT count(*)::int FROM chat_messages m WHERE m.room_id = r.id AND m.created_at > mem.last_read_at AND m.author_id <> $2) AS unread
         FROM chat_rooms r JOIN chat_members mem ON mem.room_id = r.id AND mem.user_id = $2 WHERE r.id = $1`,
        [id, access.userId]
      )
    ).rows[0];
    return apiRoom(r, await membersOf(c, id));
  }

  // ===================================================================== salas
  route('GET', '/api/chat/rooms', async ({ access }) =>
    tx(
      H.pool,
      access,
      async (c) => {
        const rows = (
          await c.query(
            `SELECT r.*, (SELECT count(*)::int FROM chat_messages m WHERE m.room_id = r.id AND m.created_at > mem.last_read_at AND m.author_id <> $1) AS unread,
                    (SELECT array_agg(x.user_id ORDER BY x.joined_at, x.user_id) FROM chat_members x WHERE x.room_id = r.id) AS members
             FROM chat_rooms r JOIN chat_members mem ON mem.room_id = r.id AND mem.user_id = $1
             ORDER BY r.last_message_at DESC NULLS LAST, r.created_at DESC LIMIT 300`,
            [access.userId]
          )
        ).rows;
        return { rooms: rows.map((r) => apiRoom(r, r.members || [])) };
      },
      { readOnly: true }
    )
  );

  route('POST', '/api/chat/rooms', async ({ req, access, body }) => {
    const out = await tx(H.pool, access, async (c) => {
      // conversa direta: { userId }
      if (body.userId !== undefined) {
        const other = uuidOr400(body.userId, 'Pessoa');
        if (other === access.userId) throw bad('Escolha outra pessoa para conversar.');
        await activePeople(c, [other]);
        const key = [access.userId, other].sort().join(':');
        const ins = await c.query("INSERT INTO chat_rooms (tenant_id, kind, dm_key, created_by) VALUES ($1, 'dm', $2, $3) ON CONFLICT (tenant_id, dm_key) WHERE dm_key IS NOT NULL DO NOTHING RETURNING id", [access.tenantId, key, access.userId]);
        const id = ins.rows[0]?.id || (await c.query('SELECT id FROM chat_rooms WHERE dm_key = $1', [key])).rows[0].id;
        for (const u of [access.userId, other]) await c.query('INSERT INTO chat_members (tenant_id, room_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [access.tenantId, id, u]);
        return { room: await loadRoom(c, access, id), created: !!ins.rows[0] };
      }
      // grupo: { name, userIds }
      const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
      if (!name || name.length > 80) throw bad('Dê um nome ao grupo (até 80 caracteres).');
      if (!Array.isArray(body.userIds)) throw bad('Escolha as pessoas do grupo.');
      const others = [...new Set(body.userIds.map((u) => uuidOr400(u, 'Pessoa')))].filter((u) => u !== access.userId);
      if (!others.length) throw bad('Um grupo precisa de pelo menos mais uma pessoa.');
      if (others.length + 1 > MAX_GROUP) throw bad(`Grupo com no máximo ${MAX_GROUP} pessoas.`);
      await activePeople(c, others);
      const id = (await c.query("INSERT INTO chat_rooms (tenant_id, kind, name, created_by) VALUES ($1, 'group', $2, $3) RETURNING id", [access.tenantId, name, access.userId])).rows[0].id;
      for (const u of [access.userId, ...others]) await c.query('INSERT INTO chat_members (tenant_id, room_id, user_id) VALUES ($1, $2, $3)', [access.tenantId, id, u]);
      await audit(c, access, req, 'chat.group_create', 'chat_room', id, { name, members: others.length + 1 });
      return { room: await loadRoom(c, access, id), created: true };
    });
    // quem foi adicionado precisa ver a sala aparecer
    tell(access, out.room.members.filter((u) => u !== access.userId), { type: 'chat', roomId: out.room.id, kind: 'room' });
    return out;
  });

  route('POST', '/api/chat/rooms/:id/members', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Conversa');
    if (!Array.isArray(body.userIds) || !body.userIds.length) throw bad('Escolha as pessoas para adicionar.');
    const add = [...new Set(body.userIds.map((u) => uuidOr400(u, 'Pessoa')))];
    const out = await tx(H.pool, access, async (c) => {
      const room = await roomFor(c, access, id);
      if (room.kind !== 'group') throw new HttpError(409, 'Só grupos aceitam mais pessoas.');
      await activePeople(c, add);
      const have = await membersOf(c, id);
      if (new Set([...have, ...add]).size > MAX_GROUP) throw bad(`Grupo com no máximo ${MAX_GROUP} pessoas.`);
      for (const u of add) await c.query('INSERT INTO chat_members (tenant_id, room_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [access.tenantId, id, u]);
      await audit(c, access, req, 'chat.group_add', 'chat_room', id, { added: add.length });
      return { room: await loadRoom(c, access, id) };
    });
    tell(access, out.room.members, { type: 'chat', roomId: id, kind: 'room' });
    return out;
  });

  // ===================================================================== mensagens
  route('GET', '/api/chat/rooms/:id/messages', async ({ access, params, query }) => {
    const id = uuidOr400(params.id, 'Conversa');
    const b = Number(query?.get?.('before'));
    const before = b > 0 ? new Date(b) : null;
    return tx(
      H.pool,
      access,
      async (c) => {
        await roomFor(c, access, id);
        const r = await c.query('SELECT * FROM (SELECT * FROM chat_messages WHERE room_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC, id LIMIT 100) m ORDER BY created_at, id', [id, before]);
        return { messages: r.rows.map(apiMessage) };
      },
      { readOnly: true }
    );
  });

  route('POST', '/api/chat/rooms/:id/messages', async ({ access, params, body }) => {
    const id = uuidOr400(params.id, 'Conversa');
    const text = String(body.body ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) throw bad('Escreva a mensagem.');
    if (text.length > 4000) throw bad('Mensagem muito longa (até 4000 caracteres).');
    const out = await tx(H.pool, access, async (c) => {
      await roomFor(c, access, id);
      const m = (await c.query('INSERT INTO chat_messages (tenant_id, room_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING *', [access.tenantId, id, access.userId, text])).rows[0];
      await c.query('UPDATE chat_rooms SET last_message_at = $2, last_body = $3, last_author_id = $4 WHERE id = $1', [id, m.created_at, text.slice(0, 200), access.userId]);
      await c.query('UPDATE chat_members SET last_read_at = $3 WHERE room_id = $1 AND user_id = $2', [id, access.userId, m.created_at]);
      return { message: apiMessage(m), members: await membersOf(c, id) };
    });
    tell(access, out.members, { type: 'chat', roomId: id, kind: 'message', message: out.message });
    return { message: out.message };
  });

  route('POST', '/api/chat/rooms/:id/read', async ({ access, params }) => {
    const id = uuidOr400(params.id, 'Conversa');
    await tx(H.pool, access, async (c) => {
      await roomFor(c, access, id);
      await c.query('UPDATE chat_members SET last_read_at = now() WHERE room_id = $1 AND user_id = $2', [id, access.userId]);
    });
    return { ok: true };
  });

  // ===================================================================== perfil (o próprio)
  route('PATCH', '/api/me', async ({ req, access, body }) => {
    const sets = [];
    const vals = [];
    const set = (col, v) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length + 1}`);
    };
    const text = (v, max, what) => {
      const t = String(v ?? '').trim().replace(/[ \t]+/g, ' ');
      if (t.length > max) throw bad(`${what}: até ${max} caracteres.`);
      return t || null;
    };
    if (body.name !== undefined) {
      const n = text(body.name, 200, 'Nome');
      if (!n) throw bad('Informe o seu nome.');
      set('name', n);
    }
    if (body.jobTitle !== undefined) set('job_title', text(body.jobTitle, 80, 'Cargo'));
    if (body.phone !== undefined) {
      const p = text(body.phone, 30, 'Telefone');
      if (p && !/^[0-9+()\-. ]{6,30}$/.test(p)) throw bad('Telefone inválido.');
      set('phone', p);
    }
    if (body.bio !== undefined) {
      const b = String(body.bio ?? '').replace(/\r\n/g, '\n').trim();
      if (b.length > 300) throw bad('Sobre você: até 300 caracteres.');
      set('bio', b || null);
    }
    if (!sets.length) throw bad('Nada para alterar.');
    const out = await tx(H.pool, access, async (c) => {
      const r = await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, job_title, phone, bio`, [access.userId, ...vals]);
      if (!r.rowCount) throw notFound('Usuário não encontrado.');
      await audit(c, access, req, 'profile.update', 'user', access.userId, { fields: Object.keys(body).filter((k) => ['name', 'jobTitle', 'phone', 'bio'].includes(k)) });
      const u = r.rows[0];
      return { me: { id: u.id, name: u.name, jobTitle: u.job_title || '', phone: u.phone || '', bio: u.bio || '' } };
    });
    hub?.emit(access.tenantId, { type: 'directory' }).catch(() => {}); // os outros veem o nome novo
    return out;
  });
};
