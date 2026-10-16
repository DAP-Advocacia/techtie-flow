'use strict';
// Rotas do CRM que gravam de verdade: contatos (editar/excluir), negócios (excluir, compartilhar, enviar proposta),
// produtos e ajustes de número (renomear, trocar responsável, ligar a IA). Mesmas regras de ouro do app.js:
// o MOTOR decide, o registro é lido do banco com o filtro do motor e o contexto nunca vem do corpo da requisição.
// `H` traz os ajudantes do app.js (rotas, decisão, transação, serializadores).

module.exports = function registerCrmRoutes(H) {
  const { route, must, bad, forbidden, notFound, HttpError, uuidOr400, tx, listWhere, getAccess, audit, withShares, visibleDeal, convRow, apiContact, apiDeal, apiInstance, postOut, announce, EMAIL } = H;

  // ===================================================================== CONTATOS
  async function visibleContact(c, access, id) {
    const w = listWhere(access, 'contact', 'read');
    const r = await c.query(`SELECT t.* FROM contacts t WHERE t.id = $${w.params.length + 1} AND ${w.sql}`, [...w.params, id]);
    if (!r.rowCount) throw notFound('Contato não encontrado.');
    return r.rows[0];
  }
  const contactRow = (r) => ({ id: r.id, tenantId: r.tenant_id, ownerId: r.owner_id, teamId: r.team_id, source: r.source, status: r.status });

  route('PATCH', '/api/contacts/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Contato');
    try {
      return await tx(H.pool, access, async (c) => {
        const cur = await visibleContact(c, access, id);
        const before = await withShares(c, 'contact', contactRow(cur));
        const sets = [];
        const vals = [];
        const set = (col, v) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length + 1}`);
        };
        const patch = {}; // só o que o perfil pode ter restringido (campos do catálogo)
        if (body.name !== undefined) {
          const n = String(body.name).trim();
          if (!n || n.length > 200) throw bad('Informe o nome (até 200 caracteres).');
          set('name', n);
        }
        if (body.company !== undefined) {
          const co = String(body.company || '').trim();
          if (co.length > 200) throw bad('Empresa: até 200 caracteres.');
          set('company', co || null);
        }
        if (body.phone !== undefined) {
          const ph = String(body.phone || '').replace(/\D/g, '');
          if (ph && !/^[0-9]{8,15}$/.test(ph)) throw bad('Telefone inválido (8 a 15 dígitos).');
          patch.phone = ph || null;
          set('phone', ph || null);
        }
        if (body.email !== undefined) {
          const em = body.email ? String(body.email).trim().toLowerCase() : null;
          if (em && (!EMAIL.test(em) || em.length > 254)) throw bad('E-mail inválido.');
          patch.email = em;
          set('email', em);
        }
        if (!sets.length) throw bad('Nada para alterar.');
        must(access, 'contact', 'update', before);
        const check = access.E.checkPatch(access.ctx, 'contact', before, patch);
        if (!check.ok) throw forbidden('Seu perfil não permite alterar este campo.');
        const r = await c.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals]);
        await audit(c, access, req, 'contact.update', 'contact', id, { fields: Object.keys(body).filter((k) => ['name', 'company', 'phone', 'email'].includes(k)) });
        return { contact: apiContact(access.E.maskRow(access.ctx, 'contact', r.rows[0])) };
      });
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'Já existe um contato com este telefone.');
      throw e;
    }
  });

  route('DELETE', '/api/contacts/:id', async ({ req, access, params }) => {
    const id = uuidOr400(params.id, 'Contato');
    await tx(H.pool, access, async (c) => {
      const cur = await visibleContact(c, access, id);
      must(access, 'contact', 'delete', await withShares(c, 'contact', contactRow(cur)));
      // conversas e negócios guardam histórico de atendimento e venda: o contato só sai quando não há nenhum
      const n = (await c.query('SELECT (SELECT count(*)::int FROM conversations WHERE contact_id = $1) AS convs, (SELECT count(*)::int FROM deals WHERE contact_id = $1) AS deals', [id])).rows[0];
      if (n.convs) throw new HttpError(409, `Este contato tem ${n.convs} ${n.convs === 1 ? 'conversa' : 'conversas'}. Para não perder o histórico, ele não pode ser excluído.`);
      if (n.deals) throw new HttpError(409, `Este contato tem ${n.deals} ${n.deals === 1 ? 'negócio' : 'negócios'}. Exclua ou mude os negócios antes.`);
      await c.query('DELETE FROM contacts WHERE id = $1', [id]);
      await audit(c, access, req, 'contact.delete', 'contact', id, { name: cur.name });
    });
    return { ok: true };
  });

  // ===================================================================== NEGÓCIOS: excluir, compartilhar, proposta
  route('DELETE', '/api/deals/:id', async ({ req, access, params }) => {
    const id = uuidOr400(params.id, 'Negócio');
    await tx(H.pool, access, async (c) => {
      const cur = await visibleDeal(c, access, id);
      must(access, 'deal', 'delete', await withShares(c, 'deal', H.dealRow(cur)));
      await c.query('DELETE FROM deals WHERE id = $1', [id]);
      await audit(c, access, req, 'deal.delete', 'deal', id, { title: cur.title });
    });
    return { ok: true };
  });

  route('POST', '/api/deals/:id/shares', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Negócio');
    const type = body.type;
    const level = body.level;
    if (!['user', 'team'].includes(type) || !['read', 'edit'].includes(level)) throw bad('Informe com quem compartilhar e o nível (leitura ou edição).');
    const subjectId = uuidOr400(body.id, type === 'user' ? 'Usuário' : 'Equipe');
    return tx(H.pool, access, async (c) => {
      const cur = await visibleDeal(c, access, id);
      const before = await withShares(c, 'deal', H.dealRow(cur));
      must(access, 'deal', 'share', before);
      const target = (await c.query(type === 'user' ? "SELECT id FROM users WHERE id = $1 AND status = 'active'" : 'SELECT id FROM teams WHERE id = $1', [subjectId])).rowCount;
      if (!target) throw bad(type === 'user' ? 'Usuário inexistente ou inativo.' : 'Equipe inexistente.');
      await c.query(
        `INSERT INTO resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level, created_by) VALUES ($1, 'deal', $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, entity, resource_id, subject_type, subject_id) DO UPDATE SET level = EXCLUDED.level`,
        [access.tenantId, id, type, subjectId, level, access.userId]
      );
      await audit(c, access, req, 'deal.share', 'deal', id, { type, subjectId, level });
      return { sharedWith: (await withShares(c, 'deal', { id })).sharedWith };
    });
  });

  route('DELETE', '/api/deals/:id/shares/:type/:subjectId', async ({ req, access, params }) => {
    const id = uuidOr400(params.id, 'Negócio');
    if (!['user', 'team'].includes(params.type)) throw bad('Tipo inválido.');
    const subjectId = uuidOr400(params.subjectId, 'Destino');
    return tx(H.pool, access, async (c) => {
      const cur = await visibleDeal(c, access, id);
      must(access, 'deal', 'share', await withShares(c, 'deal', H.dealRow(cur)));
      await c.query("DELETE FROM resource_shares WHERE entity = 'deal' AND resource_id = $1 AND subject_type = $2 AND subject_id = $3", [id, params.type, subjectId]);
      await audit(c, access, req, 'deal.unshare', 'deal', id, { type: params.type, subjectId });
      return { sharedWith: (await withShares(c, 'deal', { id })).sharedWith };
    });
  });

  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const proposalText = (deal, contactName) => {
    const items = Array.isArray(deal.items) ? deal.items : [];
    const total = items.reduce((n, i) => n + (Number(i.total) || 0), 0);
    const first = String(contactName || '').trim().split(/\s+/)[0];
    const lines = items.map((i) => `• ${i.name} (${i.note || `${i.qty}×`}): ${BRL.format(Number(i.total) || 0)}`);
    return [`Olá${first ? `, ${first}` : ''}! Segue a proposta "${deal.title}":`, ...lines, `Total: ${BRL.format(total)}`].join('\n');
  };

  // Envia a proposta como mensagem de WhatsApp na conversa do contato do negócio (se houver e se o usuário puder escrever nela).
  route('POST', '/api/deals/:id/proposal/send', async ({ req, access, params }) => {
    const id = uuidOr400(params.id, 'Negócio');
    const out = await tx(H.pool, access, async (c) => {
      const cur = await visibleDeal(c, access, id);
      const before = await withShares(c, 'deal', H.dealRow(cur));
      // o desconto vem do banco (nunca do cliente): acima do limite do perfil, o motor exige aprovação
      must(access, 'proposal', 'send', before, { discountPct: Number(cur.discount) || 0 });
      const lv = access.E.fieldAccess(access.ctx, 'deal');
      if (lv.value === 'hidden' || lv.items === 'hidden') throw forbidden('Seu perfil não vê os preços desta proposta.');
      const items = Array.isArray(cur.items) ? cur.items : [];
      if (!items.length) throw bad('Adicione produtos ao negócio antes de enviar a proposta.');
      if (!cur.contact_id) return { result: 'no-chat' };
      const contact = (await c.query('SELECT name FROM contacts WHERE id = $1', [cur.contact_id])).rows[0];
      const w = listWhere(access, 'conversation', 'read');
      const convs = (await c.query(`SELECT t.* FROM conversations t WHERE t.contact_id = $${w.params.length + 1} AND ${w.sql} ORDER BY t.last_message_at DESC NULLS LAST`, [...w.params, cur.contact_id])).rows;
      const conv = convs.find((cv) => access.E.decide(access.ctx, 'conversation', 'send_message', convRow(cv)).effect === 'allow');
      if (!conv) {
        const any = (await c.query('SELECT 1 FROM conversations WHERE contact_id = $1 LIMIT 1', [cur.contact_id])).rowCount; // RLS de tenant apenas
        await c.query('UPDATE deals SET proposal_sent_at = now() WHERE id = $1', [id]);
        await audit(c, access, req, 'proposal.send', 'deal', id, { channel: 'none' });
        return { result: any || convs.length ? 'no-access' : 'no-chat' };
      }
      const posted = await postOut(c, access, conv, 'text', proposalText(cur, contact?.name));
      await c.query('UPDATE deals SET proposal_sent_at = now() WHERE id = $1', [id]);
      await audit(c, access, req, 'proposal.send', 'deal', id, { conversationId: conv.id });
      return { result: 'sent', posted };
    });
    if (out.posted) announce(access, out.posted);
    const deal = await tx(H.pool, access, (c) => visibleDeal(c, access, id), { readOnly: true });
    return { result: out.result, deal: apiDeal(deal), conversation: out.posted?.conversation || null, message: out.posted?.message || null };
  });

  // ===================================================================== PRODUTOS (catálogo das propostas)
  const apiProduct = (r) => ({ id: r.id, name: r.name, unit: r.unit, price: Number(r.price) });
  const productInput = (body, { partial = false } = {}) => {
    const out = {};
    if (!partial || body.name !== undefined) {
      const n = String(body.name || '').trim();
      if (!n || n.length > 200) throw bad('Informe o nome do produto (até 200 caracteres).');
      out.name = n;
    }
    if (!partial || body.unit !== undefined) {
      const u = String(body.unit || 'un').trim();
      if (!u || u.length > 40) throw bad('Unidade inválida (até 40 caracteres).');
      out.unit = u;
    }
    if (!partial || body.price !== undefined) {
      const pr = Number(body.price);
      if (!Number.isFinite(pr) || pr < 0 || pr > 1e9) throw bad('Preço inválido.');
      out.price = Math.round(pr * 100) / 100;
    }
    return out;
  };

  route('POST', '/api/products', async ({ req, access, body }) => {
    must(access, 'product', 'create', { tenantId: access.tenantId });
    const v = productInput(body);
    return tx(H.pool, access, async (c) => {
      const r = (await c.query('INSERT INTO products (tenant_id, name, unit, price) VALUES ($1, $2, $3, $4) RETURNING *', [access.tenantId, v.name, v.unit, v.price])).rows[0];
      await audit(c, access, req, 'product.create', 'product', r.id, { name: v.name });
      return { product: apiProduct(r) };
    });
  });

  route('PATCH', '/api/products/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Produto');
    must(access, 'product', 'update', { tenantId: access.tenantId });
    const v = productInput(body, { partial: true });
    if (body.active !== undefined) v.active = !!body.active;
    const keys = Object.keys(v);
    if (!keys.length) throw bad('Nada para alterar.');
    return tx(H.pool, access, async (c) => {
      const r = await c.query(`UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => v[k])]);
      if (!r.rowCount) throw notFound('Produto não encontrado.');
      await audit(c, access, req, 'product.update', 'product', id, { fields: keys });
      return { product: apiProduct(r.rows[0]) };
    });
  });

  // ===================================================================== NÚMEROS: renomear, trocar responsável, ligar a IA
  route('PATCH', '/api/instances/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Número');
    return tx(H.pool, access, async (c) => {
      const cur = (await c.query('SELECT * FROM instances WHERE id = $1', [id])).rows[0];
      if (!cur) throw notFound('Número não encontrado.');
      const row = { id: cur.id, tenantId: access.tenantId, ownerId: cur.owner_id, teamId: cur.team_id };
      const sets = [];
      const vals = [];
      const set = (col, v) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length + 1}`);
      };
      let next = row;
      const wantsEdit = body.name !== undefined || body.ownerId !== undefined;
      if (wantsEdit) must(access, 'instance', 'update', row);
      if (body.name !== undefined) {
        const n = String(body.name).trim();
        if (!n || n.length > 200) throw bad('Informe o nome (até 200 caracteres).');
        set('name', n);
      }
      if (body.ownerId !== undefined) {
        let ownerId = null;
        let teamId = null;
        if (body.ownerId) {
          ownerId = uuidOr400(body.ownerId, 'Responsável');
          const target = await getAccess(H.pool, { userId: ownerId, tenantId: access.tenantId });
          if (!target || target.user.status !== 'active') throw bad('O responsável precisa ser um usuário ativo.');
          teamId = target.teamIds[0] || null;
        }
        next = { ...row, ownerId, teamId };
        must(access, 'instance', 'update', next); // o número também precisa ser algo que o ator pode ter no resultado final
        set('owner_id', ownerId);
        set('team_id', teamId);
      }
      if (body.aiActive !== undefined) {
        must(access, 'ai_agent', 'update', { tenantId: access.tenantId });
        set('ai_active', !!body.aiActive);
      }
      if (!sets.length) throw bad('Nada para alterar.');
      sets.push('updated_at = now()');
      const r = (await c.query(`UPDATE instances SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals])).rows[0];
      const owner = r.owner_id ? (await c.query('SELECT name FROM users WHERE id = $1', [r.owner_id])).rows[0] : null;
      await audit(c, access, req, 'instance.update', 'instance', id, { fields: Object.keys(body).filter((k) => ['name', 'ownerId', 'aiActive'].includes(k)) });
      return { instance: apiInstance({ ...r, owner_name: owner?.name || '' }) };
    });
  });

};
