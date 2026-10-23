'use strict';
// Importar e exportar contatos e negócios em CSV. As regras de leitura da linha (telefone, e-mail, valor, etapa…) são as de
// shared/import/rules.js — as MESMAS da prévia na tela. Aqui o MOTOR decide (`import` + `create`, e `export`), cada negócio é
// checado como na criação normal (responsável, etapa final) e o que não puder entrar fica de fora com o motivo (nunca falha tudo).
//  - Contatos já existentes (mesmo telefone ou e-mail na empresa, mesmo os que a pessoa não enxerga) são pulados, sem dizer de quem são.
//  - Negócio só se liga a contato que a pessoa PODE ler; sem contato visível e com os dados do contato, cria um novo (se puder).
//  - Exportar não gera arquivo no servidor: a tela monta o CSV com o que já leu; esta rota confere a permissão e REGISTRA na auditoria.
const crypto = require('crypto');
const { withTenant } = require('../db-tenant');

const ms = 2_500_000; // corpo de até ~2,5 MB (2000 linhas com folga)
const rulesPromise = import('../../shared/import/rules.js');
const MAX_SKIPPED_SHOWN = 300;

module.exports = function registerImportRoutes(H) {
  const { route, must, bad, HttpError, uuidOr400, tx, listWhere, getAccess, audit, primaryTeam, pool } = H;

  const own = (access) => ({ id: crypto.randomUUID(), tenantId: access.tenantId, ownerId: access.userId, teamId: primaryTeam(access) });
  const cap = (list) => ({ skipped: list.slice(0, MAX_SKIPPED_SHOWN), skippedTotal: list.length });
  const allRows = (access, sql, params = []) => withTenant(pool, { tenantId: access.tenantId, userId: access.userId, readScopes: 'tenant', readOnly: true }, async (c) => (await c.query(sql, params)).rows);

  // ===================================================================== exportar (confere e registra)
  route('POST', '/api/exports', async ({ req, access, body }) => {
    const entity = String(body.entity || '');
    if (!['contact', 'deal'].includes(entity)) throw bad('Só dá para exportar contatos e negócios.');
    const count = Math.floor(Number(body.count));
    if (!(count >= 0 && count <= 1e6)) throw bad('Quantidade inválida.');
    must(access, entity, 'export', own(access), { rowCount: count });
    await tx(pool, access, (c) => audit(c, access, req, `${entity}.export`, entity, null, { rows: count }));
    return { ok: true };
  });

  // ===================================================================== importar contatos
  route(
    'POST',
    '/api/import/contacts',
    async ({ req, access, body }) => {
      const R = await rulesPromise;
      if (!Array.isArray(body.rows) || !body.rows.length) throw bad('Não há linhas para importar.');
      if (body.rows.length > R.MAX_ROWS) throw bad(`Importe até ${R.MAX_ROWS} linhas por vez.`);
      const row = own(access);
      must(access, 'contact', 'import', row, { rowCount: body.rows.length });
      must(access, 'contact', 'create', row);
      const raws = body.rows.map((r, i) => ({ line: Number(r?.line) || i + 2, name: r?.name, company: r?.company, phone: r?.phone, email: r?.email, source: r?.source }));
      // existentes na EMPRESA toda (inclusive os que a pessoa não enxerga: o telefone é único por empresa)
      const have = await allRows(access, 'SELECT phone, lower(email) AS email FROM contacts');
      const plan = R.planContacts(raws, { phones: new Set(have.map((x) => x.phone).filter(Boolean)), emails: new Set(have.map((x) => x.email).filter(Boolean)) });
      const skipped = [...plan.skipped];
      let created = 0;
      await tx(pool, access, async (c) => {
        for (const { line, value: v } of plan.create) {
          const r = await c.query('INSERT INTO contacts (tenant_id, owner_id, team_id, name, phone, email, source, company) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id', [access.tenantId, row.ownerId, row.teamId, v.name, v.phone, v.email, v.source, v.company]);
          if (r.rowCount) created++;
          else skipped.push({ line, reason: 'Já existe um contato com este telefone' });
        }
        await audit(c, access, req, 'contact.import', 'contact', null, { rows: raws.length, created, skipped: skipped.length });
      });
      return { created, ...cap(skipped.sort((a, b) => a.line - b.line)) };
    },
    { limit: ms }
  );

  // ===================================================================== importar negócios (num funil)
  route(
    'POST',
    '/api/import/deals',
    async ({ req, access, body }) => {
      const R = await rulesPromise;
      if (!Array.isArray(body.rows) || !body.rows.length) throw bad('Não há linhas para importar.');
      if (body.rows.length > R.MAX_ROWS) throw bad(`Importe até ${R.MAX_ROWS} linhas por vez.`);
      const pipelineId = uuidOr400(body.pipelineId, 'Funil');
      must(access, 'deal', 'import', own(access), { rowCount: body.rows.length });
      const skipped = [];
      let created = 0;
      let contactsCreated = 0;
      await tx(pool, access, async (c) => {
        const stages = (await c.query('SELECT id, name, kind FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position', [pipelineId])).rows;
        if (!stages.length) throw bad('Funil não encontrado.');
        const users = (await c.query("SELECT id, name, email FROM users WHERE status = 'active'")).rows;
        // contatos que a pessoa PODE ler (é neles que o negócio se liga)
        const cw = listWhere(access, 'contact', 'read');
        const visible = (await c.query(`SELECT t.id, t.name, t.phone, lower(t.email) AS email FROM contacts t WHERE ${cw.sql}`, cw.params)).rows;
        const everyPhone = new Set((await allRows(access, 'SELECT phone FROM contacts WHERE phone IS NOT NULL')).map((x) => x.phone));
        const byPhone = new Map(visible.filter((x) => x.phone).map((x) => [x.phone, x.id]));
        const byEmail = new Map(visible.filter((x) => x.email).map((x) => [x.email, x.id]));
        const byName = new Map();
        for (const x of visible) byName.set(R.fold(x.name), byName.has(R.fold(x.name)) ? null : x.id); // nome repetido = não casa (ambíguo)
        const owners = new Map(); // acesso de cada responsável, uma vez só
        for (const [i, raw] of body.rows.entries()) {
          const line = Number(raw?.line) || i + 2;
          const skip = (reason) => skipped.push({ line, reason });
          const v = R.validateDeal({ title: raw?.title, value: raw?.value, stage: raw?.stage, expectedClose: raw?.expectedClose, owner: raw?.owner, contactName: raw?.contactName, contactPhone: raw?.contactPhone, contactEmail: raw?.contactEmail }, { stages, users });
          if (!v.ok) {
            skip(v.reason);
            continue;
          }
          const d = v.value;
          const ownerId = d.ownerId || access.userId;
          let owner = owners.get(ownerId);
          if (!owner) {
            owner = ownerId === access.userId ? access : await getAccess(pool, { userId: ownerId, tenantId: access.tenantId });
            owners.set(ownerId, owner);
          }
          if (!owner || owner.user.status !== 'active') {
            skip('O responsável precisa ser um usuário ativo');
            continue;
          }
          const stage = stages.find((s) => s.id === d.stageId);
          const dealRow = { id: crypto.randomUUID(), tenantId: access.tenantId, ownerId, teamId: owner.teamIds[0] || null, pipelineId, stageId: d.stageId, status: stage.kind, value: d.value };
          const create = access.E.decide(access.ctx, 'deal', 'create', dealRow);
          if (create.effect !== 'allow') {
            skip('Seu perfil não permite criar este negócio (responsável ou funil)');
            continue;
          }
          if (stage.kind !== 'open') {
            const mv = access.E.decide(access.ctx, 'deal', 'move', dealRow, { fromStageId: null, toStageId: stage.id, fromStageKind: null, toStageKind: stage.kind });
            if (mv.effect !== 'allow') {
              skip(`Seu perfil não permite criar negócio já em “${stage.name}”`);
              continue;
            }
          }
          // contato: telefone > e-mail > nome (só contatos que a pessoa lê); sem achar, cria um novo se houver dados e permissão
          let contactId = null;
          if (d.contact) {
            const k = d.contact;
            contactId = (k.phone && byPhone.get(k.phone)) || (k.email && byEmail.get(k.email)) || (!k.phone && !k.email && k.name ? byName.get(R.fold(k.name)) : null) || null;
            if (!contactId) {
              if (k.phone && everyPhone.has(k.phone)) {
                skip('O contato já existe, mas você não pode vê-lo para ligar o negócio');
                continue;
              }
              if (!k.name && !k.phone && !k.email) {
                // nada a criar
              } else if (access.E.decide(access.ctx, 'contact', 'create', { tenantId: access.tenantId, ownerId, teamId: dealRow.teamId }).effect !== 'allow') {
                skip('Seu perfil não permite criar o contato do negócio');
                continue;
              } else {
                const name = k.name || k.email || `+${k.phone}`;
                const ins = await c.query('INSERT INTO contacts (tenant_id, owner_id, team_id, name, phone, email, source) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id', [access.tenantId, ownerId, dealRow.teamId, name.slice(0, 200), k.phone, k.email, 'import']);
                if (!ins.rowCount) {
                  skip('O contato já existe, mas você não pode vê-lo para ligar o negócio');
                  continue;
                }
                contactId = ins.rows[0].id;
                contactsCreated++;
                if (k.phone) {
                  byPhone.set(k.phone, contactId);
                  everyPhone.add(k.phone);
                }
                if (k.email) byEmail.set(k.email, contactId);
              }
            }
          }
          await c.query('INSERT INTO deals (id, tenant_id, owner_id, team_id, title, pipeline_id, stage_id, status, value, contact_id, expected_close) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [dealRow.id, access.tenantId, ownerId, dealRow.teamId, d.title, pipelineId, d.stageId, stage.kind, d.value, contactId, d.expectedClose]);
          created++;
        }
        await audit(c, access, req, 'deal.import', 'deal', null, { rows: body.rows.length, created, skipped: skipped.length, contactsCreated });
      });
      return { created, contactsCreated, ...cap(skipped.sort((a, b) => a.line - b.line)) };
    },
    { limit: ms }
  );
};
