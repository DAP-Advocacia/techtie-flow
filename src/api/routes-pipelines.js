'use strict';
// Funis configuráveis pela tela: criar/renomear/excluir funil, editar etapas (nome, tipo, probabilidade, ordem) e a lista
// de motivos de perda da empresa. Mesmas regras de ouro do app.js: o MOTOR decide (entidade `pipeline`: create/update/delete),
// e quem muda a configuração nunca consegue "perder" negócio: etapa ou funil com negócios não se remove, e o tipo da
// etapa (aberta/ganha/perdida) não muda enquanto houver negócio nela — isso seria mover negócio sem passar pela regra de mover.
const { withTenant } = require('../db-tenant');

const KINDS = ['open', 'won', 'lost'];
const MAX_STAGES = 30;
const MAX_PIPELINES = 20;
const MAX_REASONS = 30;
const DEFAULT_STAGES = [['Novo', 'open'], ['Qualificação', 'open'], ['Proposta', 'open'], ['Ganho', 'won'], ['Perdido', 'lost']];
const ACCENT = { won: 'var(--green)', lost: 'var(--red)', open: 'var(--acc)' };

/** Probabilidade padrão das etapas abertas: espalhada pelo funil (3 abertas → 25, 50, 75). */
const spread = (i, n) => Math.round((100 * (i + 1)) / (n + 1));

module.exports = function registerPipelineRoutes(H) {
  const { route, must, bad, HttpError, notFound, uuidOr400, tx, audit, hub, pool } = H;

  const apiStage = (s) => ({ id: s.id, name: s.name, kind: s.kind, probability: Number(s.probability) || 0, accent: ACCENT[s.kind] || ACCENT.open });
  const apiPipeline = (p, stages) => ({ id: p.id, name: p.name, teamId: null, stages: stages.filter((s) => s.pipeline_id === p.id).map(apiStage) });
  const announce = (access) => hub?.emit(access.tenantId, { type: 'pipelines' }).catch(() => {});

  async function load(c, id) {
    const p = (await c.query('SELECT id, name FROM pipelines WHERE id = $1', [id])).rows[0];
    if (!p) throw notFound('Funil não encontrado.');
    const stages = (await c.query('SELECT id, pipeline_id, name, kind, probability FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position, created_at', [id])).rows;
    return apiPipeline(p, stages);
  }

  /** Negócios por etapa/funil, de TODOS (a trava de remoção não pode depender do que o usuário enxerga). */
  const dealCounts = (access, sql, params) => withTenant(pool, { tenantId: access.tenantId, userId: access.userId, readScopes: 'tenant', readOnly: true }, async (c) => (await c.query(sql, params)).rows);

  const cleanName = (raw, what = 'funil') => {
    const n = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!n || n.length > 200) throw bad(`Informe o nome do ${what} (até 200 caracteres).`);
    return n;
  };

  /** Valida a lista de etapas vinda da tela e normaliza (ganho = 100%, perdido = 0%). */
  function cleanStages(list) {
    if (!Array.isArray(list) || list.length < 3 || list.length > MAX_STAGES) throw bad(`O funil precisa ter de 3 a ${MAX_STAGES} etapas.`);
    const seen = new Set();
    const out = list.map((s, i) => {
      if (!s || typeof s !== 'object') throw bad('Etapa inválida.');
      const kind = String(s.kind || 'open');
      if (!KINDS.includes(kind)) throw bad('Tipo de etapa inválido.');
      const id = s.id ? uuidOr400(s.id, 'Etapa') : null;
      if (id) {
        if (seen.has(id)) throw bad('Etapa repetida.');
        seen.add(id);
      }
      let probability = kind === 'won' ? 100 : kind === 'lost' ? 0 : Number(s.probability);
      if (kind === 'open') {
        if (!Number.isFinite(probability) || probability < 0 || probability > 100) throw bad(`Probabilidade da etapa ${i + 1} inválida (0 a 100).`);
        probability = Math.round(probability);
      }
      return { id, name: cleanName(s.name, 'nome da etapa').slice(0, 200), kind, probability };
    });
    for (const [kind, label] of [['open', 'em andamento'], ['won', 'ganha'], ['lost', 'perdida']]) {
      if (!out.some((s) => s.kind === kind)) throw bad(`O funil precisa de pelo menos uma etapa ${label}.`);
    }
    return out;
  }

  const insertStages = async (c, access, pipelineId, stages) => {
    let pos = 0;
    for (const s of stages) await c.query('INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, kind, position, probability) VALUES ($1, $2, $3, $4, $5, $6)', [access.tenantId, pipelineId, s.name, s.kind, pos++, s.probability]);
  };

  const sameName = async (c, name, exceptId) => {
    const r = await c.query('SELECT 1 FROM pipelines WHERE lower(btrim(name)) = lower($1) AND ($2::uuid IS NULL OR id <> $2) LIMIT 1', [name, exceptId || null]);
    if (r.rowCount) throw new HttpError(409, 'Já existe um funil com esse nome.');
  };

  // ===================================================================== criar funil
  route('POST', '/api/pipelines', async ({ req, access, body }) => {
    must(access, 'pipeline', 'create', { tenantId: access.tenantId });
    const name = cleanName(body.name);
    let stages;
    if (body.stages !== undefined) stages = cleanStages(body.stages);
    else {
      const opens = DEFAULT_STAGES.filter(([, k]) => k === 'open').length;
      let i = 0;
      stages = DEFAULT_STAGES.map(([n, kind]) => ({ name: n, kind, probability: kind === 'won' ? 100 : kind === 'lost' ? 0 : spread(i++, opens) }));
    }
    const out = await tx(pool, access, async (c) => {
      if ((await c.query('SELECT count(*)::int AS n FROM pipelines')).rows[0].n >= MAX_PIPELINES) throw bad(`Limite de ${MAX_PIPELINES} funis por empresa.`);
      await sameName(c, name);
      const id = (await c.query('INSERT INTO pipelines (tenant_id, name) VALUES ($1, $2) RETURNING id', [access.tenantId, name])).rows[0].id;
      await insertStages(c, access, id, stages);
      await audit(c, access, req, 'pipeline.create', 'pipeline', id, { name, stages: stages.length });
      return load(c, id);
    });
    announce(access);
    return { pipeline: out };
  });

  // ===================================================================== renomear
  route('PATCH', '/api/pipelines/:id', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Funil');
    must(access, 'pipeline', 'update', { id, tenantId: access.tenantId });
    const name = cleanName(body.name);
    const out = await tx(pool, access, async (c) => {
      await load(c, id);
      await sameName(c, name, id);
      await c.query('UPDATE pipelines SET name = $2 WHERE id = $1', [id, name]);
      await audit(c, access, req, 'pipeline.update', 'pipeline', id, { name });
      return load(c, id);
    });
    announce(access);
    return { pipeline: out };
  });

  // ===================================================================== etapas (lista inteira, na ordem da tela)
  route('PUT', '/api/pipelines/:id/stages', async ({ req, access, params, body }) => {
    const id = uuidOr400(params.id, 'Funil');
    must(access, 'pipeline', 'update', { id, tenantId: access.tenantId });
    const next = cleanStages(body.stages);
    const counts = new Map((await dealCounts(access, 'SELECT stage_id, count(*)::int AS n FROM deals WHERE pipeline_id = $1 GROUP BY stage_id', [id])).map((r) => [r.stage_id, r.n]));
    const out = await tx(pool, access, async (c) => {
      const cur = (await c.query('SELECT id, name, kind FROM pipeline_stages WHERE pipeline_id = $1', [id])).rows;
      if (!(await c.query('SELECT 1 FROM pipelines WHERE id = $1', [id])).rowCount) throw notFound('Funil não encontrado.');
      const known = new Set(cur.map((s) => s.id));
      if (next.some((s) => s.id && !known.has(s.id))) throw bad('Etapa não pertence a este funil.');
      const keep = new Set(next.filter((s) => s.id).map((s) => s.id));
      for (const s of cur) {
        const n = counts.get(s.id) || 0;
        if (!keep.has(s.id) && n) throw new HttpError(409, `A etapa “${s.name}” tem ${n} ${n === 1 ? 'negócio' : 'negócios'}. Mova-${n === 1 ? 'o' : 'os'} para outra etapa antes de removê-la.`);
        const after = next.find((x) => x.id === s.id);
        if (after && after.kind !== s.kind && n) throw new HttpError(409, `A etapa “${s.name}” tem ${n} ${n === 1 ? 'negócio' : 'negócios'}: o tipo dela (em andamento, ganha ou perdida) não muda enquanto houver negócio nela.`);
      }
      const removed = cur.filter((s) => !keep.has(s.id));
      if (removed.length) await c.query('DELETE FROM pipeline_stages WHERE pipeline_id = $1 AND id = ANY($2::uuid[])', [id, removed.map((s) => s.id)]);
      let pos = 0;
      let added = 0;
      for (const s of next) {
        if (s.id) await c.query('UPDATE pipeline_stages SET name = $2, kind = $3, position = $4, probability = $5 WHERE id = $1', [s.id, s.name, s.kind, pos++, s.probability]);
        else {
          await c.query('INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, kind, position, probability) VALUES ($1, $2, $3, $4, $5, $6)', [access.tenantId, id, s.name, s.kind, pos++, s.probability]);
          added++;
        }
      }
      await audit(c, access, req, 'pipeline.stages', 'pipeline', id, { stages: next.length, added, removed: removed.length });
      return load(c, id);
    });
    announce(access);
    return { pipeline: out };
  });

  // ===================================================================== excluir funil
  route('DELETE', '/api/pipelines/:id', async ({ req, access, params }) => {
    const id = uuidOr400(params.id, 'Funil');
    must(access, 'pipeline', 'delete', { id, tenantId: access.tenantId });
    const n = (await dealCounts(access, 'SELECT count(*)::int AS n FROM deals WHERE pipeline_id = $1', [id]))[0].n;
    if (n) throw new HttpError(409, `Este funil tem ${n} ${n === 1 ? 'negócio' : 'negócios'}. Mova ou exclua ${n === 1 ? 'o negócio' : 'os negócios'} antes de apagar o funil.`);
    await tx(pool, access, async (c) => {
      const p = await load(c, id);
      if ((await c.query('SELECT count(*)::int AS n FROM pipelines')).rows[0].n <= 1) throw new HttpError(409, 'A empresa precisa de pelo menos um funil.');
      await c.query('DELETE FROM pipelines WHERE id = $1', [id]);
      await audit(c, access, req, 'pipeline.delete', 'pipeline', id, { name: p.name });
    });
    announce(access);
    return { ok: true };
  });

  // ===================================================================== motivos de perda (lista inteira)
  route('PUT', '/api/loss-reasons', async ({ req, access, body }) => {
    must(access, 'pipeline', 'update', { tenantId: access.tenantId });
    if (!Array.isArray(body.reasons) || body.reasons.length > MAX_REASONS) throw bad(`Até ${MAX_REASONS} motivos de perda.`);
    const names = body.reasons.map((r) => {
      const n = String(r ?? '').trim().replace(/\s+/g, ' ');
      if (!n || n.length > 80) throw bad('Cada motivo precisa ter de 1 a 80 caracteres.');
      return n;
    });
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw bad('Há motivos repetidos.');
    const out = await tx(pool, access, async (c) => {
      await c.query('DELETE FROM loss_reasons');
      let pos = 0;
      for (const n of names) await c.query('INSERT INTO loss_reasons (tenant_id, name, position) VALUES ($1, $2, $3)', [access.tenantId, n, pos++]);
      await audit(c, access, req, 'pipeline.loss_reasons', 'pipeline', null, { reasons: names.length });
      return (await c.query('SELECT id, name FROM loss_reasons ORDER BY position')).rows;
    });
    announce(access);
    return { lossReasons: out };
  });
};
