// Ações da tela Funis: criar, renomear, editar etapas, apagar e a lista de motivos de perda. Cada uma confere o motor
// (entidade `pipeline`), valida com as mesmas regras do servidor e devolve { ok, error }. Em operação espera o servidor
// (os IDs e a palavra final são dele); no protótipo grava só no navegador.
import { store } from '../../store.js';
import { audit } from '../../access.js';
import * as live from '../../live.js';
import { check } from '../_ops/perm.js';
import { normalizeStages, validateStages, validatePipelineName, cleanReasons, validateReasons, defaultStages } from './model.js';

const ACCENT = { won: 'var(--green)', lost: 'var(--red)', open: 'var(--acc)' };
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fail = (error) => ({ ok: false, error });
const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

export const kindOf = (st) => st?.kind || 'open';

/** Etapas do funil no formato do editor (tipo sempre explícito; probabilidade sempre número). */
export const draftOf = (pipeline) => (pipeline?.stages || []).map((st) => ({ id: st.id, name: st.name, kind: kindOf(st), probability: Number.isFinite(Number(st.probability)) ? Number(st.probability) : kindOf(st) === 'won' ? 100 : 0 }));

/** Negócios (que o usuário enxerga) numa etapa. O servidor confere de novo com TODOS os negócios da empresa. */
export const dealsInStage = (stageId) => store.state.deals.filter((d) => d.stageId === stageId).length;

const denied = (c) => fail(c.msg);
const wrap = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return fail(e.message || 'Não foi possível salvar.');
  }
};

export function createPipeline(name) {
  const c = check('pipeline', 'create', null);
  if (!c.ok) return denied(c);
  const msg = validatePipelineName(name, store.state.pipelines.map((p) => p.name));
  if (msg) return fail(msg);
  const n = clean(name);
  return wrap(async () => {
    if (live.enabled) return { ok: true, pipeline: await live.createPipeline({ name: n }) };
    const pipeline = { id: uid('p'), name: n, teamId: null, stages: normalizeStages(defaultStages()).map((st) => ({ id: uid('s'), name: st.name, kind: st.kind, probability: st.probability, accent: ACCENT[st.kind] })) };
    store.update((s) => s.pipelines.push(pipeline));
    audit('pipeline.create', pipeline.id, `Funil "${n}" criado`);
    return { ok: true, pipeline };
  });
}

export function renamePipeline(id, name) {
  const p = store.pipeline(id);
  const c = check('pipeline', 'update', { id });
  if (!c.ok) return denied(c);
  const msg = validatePipelineName(name, store.state.pipelines.filter((x) => x.id !== id).map((x) => x.name));
  if (msg || !p) return fail(msg || 'Funil não encontrado.');
  const n = clean(name);
  return wrap(async () => {
    if (live.enabled) return { ok: true, pipeline: await live.renamePipeline(id, n) };
    store.update((s) => Object.assign(s.pipelines.find((x) => x.id === id), { name: n }));
    audit('pipeline.update', id, `Funil "${p.name}" renomeado para "${n}"`);
    return { ok: true };
  });
}

export function saveStages(id, draft) {
  const p = store.pipeline(id);
  const c = check('pipeline', 'update', { id });
  if (!c.ok) return denied(c);
  if (!p) return fail('Funil não encontrado.');
  const stages = normalizeStages(draft);
  const msg = validateStages(stages);
  if (msg) return fail(msg);
  return wrap(async () => {
    if (live.enabled) return { ok: true, pipeline: await live.savePipelineStages(id, stages.map(({ id: sid, name, kind, probability }) => ({ ...(sid ? { id: sid } : {}), name, kind, probability }))) };
    // mesmas travas do servidor: etapa com negócio não sai nem muda de tipo
    const keep = new Set(stages.filter((st) => st.id).map((st) => st.id));
    for (const old of p.stages) {
      const n = dealsInStage(old.id);
      const after = stages.find((st) => st.id === old.id);
      if (!keep.has(old.id) && n) return fail(`A etapa “${old.name}” tem ${n} ${n === 1 ? 'negócio' : 'negócios'}. Mova-${n === 1 ? 'o' : 'os'} para outra etapa antes de removê-la.`);
      if (after && after.kind !== kindOf(old) && n) return fail(`A etapa “${old.name}” tem ${n} ${n === 1 ? 'negócio' : 'negócios'}: o tipo dela (em andamento, ganha ou perdida) não muda enquanto houver negócio nela.`);
    }
    store.update((s) => {
      const target = s.pipelines.find((x) => x.id === id);
      const before = new Map(target.stages.map((st) => [st.id, st]));
      target.stages = stages.map((st) => ({ id: st.id || uid('s'), name: st.name, kind: st.kind, probability: st.probability, accent: before.get(st.id)?.accent && kindOf(before.get(st.id)) === st.kind ? before.get(st.id).accent : ACCENT[st.kind] }));
    });
    audit('pipeline.stages', id, `Etapas do funil "${p.name}" alteradas (${stages.length})`);
    return { ok: true };
  });
}

export function deletePipeline(id) {
  const p = store.pipeline(id);
  const c = check('pipeline', 'delete', { id });
  if (!c.ok) return denied(c);
  if (!p) return fail('Funil não encontrado.');
  return wrap(async () => {
    if (live.enabled) {
      await live.deletePipeline(id);
      return { ok: true };
    }
    const n = store.state.deals.filter((d) => d.pipelineId === id).length;
    if (n) return fail(`Este funil tem ${n} ${n === 1 ? 'negócio' : 'negócios'}. Mova ou exclua ${n === 1 ? 'o negócio' : 'os negócios'} antes de apagar o funil.`);
    if (store.state.pipelines.length <= 1) return fail('A empresa precisa de pelo menos um funil.');
    store.update((s) => {
      s.pipelines = s.pipelines.filter((x) => x.id !== id);
      for (const t of s.teams) if (t.pipelineId === id) t.pipelineId = null;
    });
    audit('pipeline.delete', id, `Funil "${p.name}" excluído`);
    return { ok: true };
  });
}

export function saveLossReasons(list) {
  const c = check('pipeline', 'update', null);
  if (!c.ok) return denied(c);
  const msg = validateReasons(list);
  if (msg) return fail(msg);
  const names = cleanReasons(list);
  return wrap(async () => {
    if (live.enabled) {
      await live.saveLossReasons(names);
      return { ok: true };
    }
    store.update((s) => {
      s.lossReasons = names.map((name, i) => ({ id: `lr${i}`, name }));
    });
    audit('pipeline.loss_reasons', 'loss_reasons', `Motivos de perda atualizados (${names.length})`);
    return { ok: true };
  });
}
