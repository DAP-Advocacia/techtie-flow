// Aba SIMULADOR ("ver como / por que não posso?"): escolhe uma pessoa, um
// recurso, uma ação e (opcionalmente) um registro real do protótipo, e mostra o
// veredito do MOTOR com o passo a passo. Usa as funções de access.js passando o
// userId ESCOLHIDO (não o logado) — nada aqui reimplementa regra de permissão.
import { h, replaceChildren, avatar } from '../../ui.js';
import { ENTITIES, ACTIONS, effectiveRoles } from '/shared/permissions/index.js';
import { decide, explain, matrixFor, ctxFor, fieldLevel } from '../../access.js';
import { SECTIONS, entityLabel, actionLabel, scopeShort, scopeLevel, scopeLabel, describeGrant, describeDeny, makeNamer, STATUS_LABELS, ENUMS, fieldLabel, FIELD_ACCESS_LABELS, plural, slug } from './labels.js';
import { denyCells } from './model.js';
import { matrixSections, meter, legend } from './matrix.js';
import { keepUi, selectEl, ICON, sr } from './util.js';

const REASONS = {
  ok: 'Pelo menos uma regra dos perfis permite e nenhuma negação se aplica.',
  needs_approval: 'Há uma regra que permite, mas ela exige a aprovação de um gestor neste caso.',
  denied: 'Uma negação se aplica — negações vencem qualquer permissão.',
  no_grant: 'Nenhuma regra dos perfis da pessoa cobre esta ação neste registro.',
  tenant_mismatch: 'O registro pertence a outra empresa (isolamento de tenant, incondicional).',
  mfa_required: 'Ação sensível e a política exige verificação em duas etapas (MFA), que a pessoa não tem.',
  subject_inactive: 'A pessoa não está ativa (suspensa, convidada ou inexistente) — falha fechado.',
  unknown_action: 'Esta entidade não tem essa ação no catálogo.',
};
const VERDICT = {
  allow: { cls: 'ok', title: 'Permitido', icon: '✓' },
  deny: { cls: 'no', title: 'Negado', icon: '✕' },
  approval: { cls: 'appr', title: 'Requer aprovação', icon: '!' },
};
const FAIL_TEXT = {
  escopo: 'o registro está fora do escopo da regra (não é dele/da equipe dele)',
  particao: 'o registro está fora do recorte de pipeline/instância do perfil',
  condicao: 'a condição da regra não é satisfeita',
};

export function createSimulatorTab(S) {
  const { store } = S;
  const el = h('div', { class: 'perm-sim' });
  const humans = () => store.state.users.filter((u) => !u.isBot);

  const sim = { userId: null, entity: 'deal', action: 'move', recordId: null, toStageId: null, discount: '', rows: '' };

  function init() {
    const st = store.state;
    const pick = humans().find((u) => u.id === 'u_rafael') || humans().find((u) => u.id !== st.currentUserId) || humans()[0];
    sim.userId = pick?.id ?? null;
    sim.recordId = '__auto__';
  }

  // --------------------------------------------------------- registros
  /** Registros de exemplo da entidade (do store). */
  function recordsFor(entity) {
    const st = store.state;
    const owner = (id) => st.users.find((u) => u.id === id)?.name || '—';
    const teamOf = (id) => st.users.find((u) => u.id === id)?.teamIds?.[0] ?? null;
    switch (entity) {
      case 'contact':
        return st.contacts.map((c) => ({ id: c.id, label: `${c.name} · ${c.company} (resp.: ${owner(c.ownerId)})`, row: c }));
      case 'company': {
        const seen = new Map();
        for (const c of st.contacts) if (!seen.has(c.company)) seen.set(c.company, { id: `co_${slug(c.company)}`, name: c.company, ownerId: c.ownerId });
        return [...seen.values()].map((c) => ({ id: c.id, label: `${c.name} (resp.: ${owner(c.ownerId)})`, row: c }));
      }
      case 'deal':
        return st.deals.map((d) => ({ id: d.id, label: `${d.title} · ${st.pipelines.find((p) => p.id === d.pipelineId)?.name || ''} (resp.: ${owner(d.ownerId)})`, row: d }));
      case 'proposal':
        return st.deals.map((d) => ({ id: `prop_${d.id}`, label: `Proposta de “${d.title}” (resp.: ${owner(d.ownerId)})`, row: { id: `prop_${d.id}`, ownerId: d.ownerId, teamId: teamOf(d.ownerId), status: 'sent', dealId: d.id } }));
      case 'conversation':
        return st.conversations.map((c) => ({ id: c.id, label: `${st.contacts.find((x) => x.id === c.contactId)?.name || c.id} · ${st.instances.find((i) => i.id === c.instanceId)?.name || ''} (${c.assigneeId ? `resp.: ${owner(c.assigneeId)}` : 'na fila'})`, row: c }));
      default:
        return [];
    }
  }

  /** Normaliza as escolhas para valores válidos (entidade → ação → registro → etapa). */
  function normalize() {
    const st = store.state;
    if (!humans().some((u) => u.id === sim.userId)) sim.userId = humans()[0]?.id ?? null;
    if (!ENTITIES[sim.entity]) sim.entity = 'deal';
    if (!ENTITIES[sim.entity].actions.includes(sim.action)) sim.action = ENTITIES[sim.entity].actions[0];
    const recs = recordsFor(sim.entity);
    if (sim.recordId === '__auto__') {
      const mine = recs.find((r) => r.row.ownerId === sim.userId || r.row.assigneeId === sim.userId);
      sim.recordId = (mine || recs[0])?.id ?? '';
    }
    if (sim.recordId && !recs.some((r) => r.id === sim.recordId)) sim.recordId = recs[0]?.id ?? '';
    const stages = st.pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipelineId: p.id, pipeline: p.name })));
    if (!stages.some((s) => s.id === sim.toStageId)) {
      const rec = recs.find((r) => r.id === sim.recordId)?.row;
      const same = stages.filter((s) => !rec?.pipelineId || s.pipelineId === rec.pipelineId);
      sim.toStageId = (same.find((s) => s.kind === 'won') || same[0] || stages[0])?.id ?? null;
    }
    return { recs, stages };
  }

  const stageLabel = (s) => `${s.pipeline} › ${s.name}${s.kind ? ` (${ENUMS.stageKind[s.kind]})` : ''}`;

  /** Contexto da operação a partir das entradas — chave em branco fica AUSENTE (desconhecida = lado seguro). */
  function buildContext(rec, stages) {
    const keys = ACTIONS[sim.action]?.ctx || [];
    const ctx = {};
    if (keys.includes('toStageId') && sim.toStageId) {
      const to = stages.find((s) => s.id === sim.toStageId);
      const from = stages.find((s) => s.id === rec?.row?.stageId);
      ctx.toStageId = to.id;
      ctx.toStageKind = to.kind || 'open';
      if (from) {
        ctx.fromStageId = from.id;
        ctx.fromStageKind = from.kind || 'open';
      }
    }
    if (keys.includes('discountPct') && sim.discount !== '' && !Number.isNaN(Number(sim.discount))) ctx.discountPct = Number(sim.discount);
    if (keys.includes('rowCount') && sim.rows !== '' && !Number.isNaN(Number(sim.rows))) ctx.rowCount = Number(sim.rows);
    return Object.keys(ctx).length ? ctx : undefined;
  }

  // ------------------------------------------------------------- render
  const roleName = (id) => store.state.roles.find((r) => r.id === id)?.name || id;

  /** "perfil:role_agent#3" -> { kind, role, index } */
  function parseSource(src) {
    let m = /^perfil:(.+?)(:nega)?#(\d+)$/.exec(src);
    if (m) return { who: 'perfil', roleId: m[1], deny: !!m[2], index: Number(m[3]) };
    m = /^usuario(:nega)?#(\d+)$/.exec(src);
    if (m) return { who: 'usuario', deny: !!m[1], index: Number(m[2]) };
    if (src === 'compartilhamento') return { who: 'share' };
    return { who: 'x', src };
  }

  function stepsFor(exp, user, ns) {
    const ctx = ctxFor(sim.userId);
    const steps = [];
    const policyOn = !!store.state.tenant.policy?.requireMfaForSensitive;
    steps.push({ ok: user.status === 'active', title: 'A pessoa está ativa?', text: user.status === 'active' ? 'Sim.' : `Não — status “${STATUS_LABELS[user.status] || user.status}”. Falha fechado.` });
    if (policyOn && ACTIONS[sim.action]?.sensitive) steps.push({ ok: !!user.mfa, title: 'MFA para ação sensível', text: user.mfa ? 'A pessoa tem MFA.' : 'A política da empresa exige MFA e a pessoa não tem.' });
    if (exp.reason === 'subject_inactive' || exp.reason === 'mfa_required' || exp.reason === 'unknown_action') return steps;
    steps.push({ ok: exp.reason !== 'tenant_mismatch', title: 'Isolamento da empresa', text: exp.reason === 'tenant_mismatch' ? 'O registro é de outra empresa.' : 'O registro é da mesma empresa (verificação incondicional).' });
    if (exp.reason === 'tenant_mismatch') return steps;

    // negações primeiro: vencem tudo
    const denies = exp.denies || [];
    if (!denies.length) steps.push({ ok: true, title: 'Negações', text: 'Nenhuma negação existe para esta ação.' });
    for (const d of denies) {
      const p = parseSource(d.source);
      const role = p.roleId ? ctx.roles.get(p.roleId) : null;
      const rule = role?.denies?.[p.index] || (p.who === 'usuario' ? ctx.subject.overrides?.denies?.[p.index] : null);
      steps.push({
        ok: !d.applies,
        tone: d.applies ? 'bad' : 'ok',
        title: `Negação${role ? ` · ${role.name}` : p.who === 'usuario' ? ' · exceção do usuário' : ''}`,
        text: `${rule ? describeDeny(role?.name || 'A pessoa', rule, ns) : d.rule} — ${d.applies ? 'SE APLICA (vence qualquer permissão).' : 'não se aplica a este caso.'}`,
        tech: d.rule,
      });
    }
    const branches = exp.branches || [];
    if (!branches.length) steps.push({ ok: false, title: 'Permissões', text: 'Nenhum perfil da pessoa tem regra para esta ação.' });
    for (const b of branches) {
      const p = parseSource(b.source);
      const role = p.roleId ? ctx.roles.get(p.roleId) : null;
      const grant = role?.grants?.[p.index] || (p.who === 'usuario' ? ctx.subject.overrides?.grants?.[p.index] : null);
      const label = p.who === 'share' ? 'Compartilhamento do registro' : `Regra${role ? ` · ${role.name}` : p.who === 'usuario' ? ' · exceção do usuário' : ''}`;
      const text = grant ? describeGrant(role?.name || 'A pessoa', grant, ns) : b.rule;
      steps.push({ ok: b.matched, title: label, text: `${text} — ${b.matched ? 'casou com este caso.' : `não casou: ${FAIL_TEXT[b.failedAt] || 'falhou'}.`}`, tech: b.rule });
    }
    return steps;
  }

  function verdictCard(dec, exp, user, ns) {
    const v = VERDICT[dec.effect];
    const steps = stepsFor(exp, user, ns);
    return h(
      'div',
      { class: 'perm-verdict-wrap' },
      h(
        'div',
        { class: `perm-verdict perm-verdict--${v.cls}`, role: 'status', 'aria-live': 'polite' },
        h('div', { class: 'perm-verdict__icon', 'aria-hidden': 'true' }, v.icon),
        h('div', null, h('div', { class: 'perm-verdict__title' }, v.title), h('div', { class: 'perm-verdict__why' }, REASONS[dec.reason] || dec.reason), dec.matched.length && dec.effect !== 'deny' ? h('div', { class: 'perm-hint' }, 'Por: ', dec.matched.map((m) => { const p = parseSource(m); return p.roleId ? roleName(p.roleId) : p.who === 'share' ? 'compartilhamento' : 'exceção do usuário'; }).filter((x, i, a) => a.indexOf(x) === i).join(', ')) : null)
      ),
      h(
        'div',
        { class: 'perm-steps-wrap' },
        h('div', { class: 'label' }, 'Passo a passo'),
        h(
          'ol',
          { class: 'perm-steps' },
          steps.map((s) =>
            h(
              'li',
              { class: 'perm-step perm-step--' + (s.tone || (s.ok ? 'ok' : 'no')) },
              h('span', { class: 'perm-step__mark', 'aria-hidden': 'true' }, s.tone === 'bad' || !s.ok ? '✕' : '✓'),
              h('div', null, h('div', { class: 'perm-step__t' }, s.title, sr(s.tone === 'bad' || !s.ok ? ' (não)' : ' (sim)')), h('div', { class: 'perm-step__x' }, s.text), s.tech ? h('details', { class: 'perm-tech' }, h('summary', null, 'detalhe técnico'), h('code', null, s.tech)) : null)
            )
          )
        )
      )
    );
  }

  function heatmap(user) {
    const m = matrixFor(sim.userId);
    const ctx = ctxFor(sim.userId);
    const roles = effectiveRoles(ctx);
    const den = denyCells({ denies: [...roles.flatMap((r) => r.denies || []), ...(ctx.subject.overrides?.denies || [])] });
    const policyOn = !!store.state.tenant.policy?.requireMfaForSensitive;
    const cell = (e, a) => {
      const c = m[e]?.[a] || { scope: 'none' };
      const d = den.get(`${e}.${a}`);
      const mfaBlock = policyOn && !user.mfa && ACTIONS[a]?.sensitive && c.scope !== 'none';
      const lvl = scopeLevel(c.scope);
      const cls = ['perm-cell', 'perm-cell--ro', 'perm-cell--map', `perm-lvl-${mfaBlock || (d && d.full) ? 0 : lvl}`, d?.full ? 'is-blocked' : '', mfaBlock ? 'is-mfa' : ''].filter(Boolean).join(' ');
      const flags = [];
      if (c.approval) flags.push(h('span', { class: 'perm-flag perm-flag--appr', title: 'Exige aprovação de um gestor em alguns casos' }, 'aprov.'));
      else if (c.conditional) flags.push(h('span', { class: 'perm-flag', title: 'Vale só sob condição ou dentro de um recorte do perfil' }, '⚙'));
      if (d) flags.push(h('span', { class: 'perm-flag perm-flag--deny' + (d.full ? ' is-full' : ''), title: d.full ? 'Negação bloqueia esta ação' : 'Negação condicional bloqueia em alguns casos' }, '⊘'));
      const txt = mfaBlock ? 'MFA' : scopeShort(c.scope);
      const aria = `${entityLabel(e)} ${actionLabel(a)}: ${mfaBlock ? 'bloqueado até ativar MFA' : d?.full ? 'bloqueado por negação' : scopeLabel(c.scope)}${c.approval ? ', com aprovação' : c.conditional ? ', condicional' : ''}${d && !d.full ? ', negação condicional' : ''}`;
      return h('div', { class: cls, role: 'img', 'aria-label': aria, title: aria }, meter(mfaBlock || d?.full ? 0 : lvl), h('span', { class: 'perm-cell__txt' }, txt), flags);
    };
    return matrixSections({ cell, scrollKey: 'map' });
  }

  function partitionsInfo(user, ns) {
    const ctx = ctxFor(sim.userId);
    const out = [];
    for (const r of effectiveRoles(ctx)) {
      for (const [k, v] of Object.entries(r.partitions || {})) {
        if (v === 'all') continue;
        const src = k === 'pipelineId' ? 'pipeline' : 'instance';
        out.push(`${r.name}: ${k === 'pipelineId' ? 'pipelines' : 'instâncias'} → ${v.length ? v.map((id) => ns[src](id)).join(', ') : 'nenhum'}`);
      }
    }
    return out;
  }

  function fieldsInfo() {
    const rows = [];
    for (const [entity, def] of Object.entries(ENTITIES)) {
      for (const f of def.fields) {
        const lv = fieldLevel(entity, f, sim.userId);
        if (lv !== 'write') rows.push({ entity, field: f, lv });
      }
    }
    return rows;
  }

  function build() {
    const st = store.state;
    const { recs, stages } = normalize();
    const ns = makeNamer(st);
    const user = st.users.find((u) => u.id === sim.userId);
    if (!user) {
      replaceChildren(el, h('div', { class: 'empty card' }, 'Nenhum usuário para simular.'));
      return;
    }
    const rec = recs.find((r) => r.id === sim.recordId);
    const context = buildContext(rec, stages);
    const dec = decide(sim.entity, sim.action, rec?.row ?? null, context, sim.userId);
    const exp = explain(sim.entity, sim.action, rec?.row ?? null, context, sim.userId);
    const keys = ACTIONS[sim.action]?.ctx || [];
    const rerender = () => keepUi(el, build);

    const controls = h(
      'div',
      { class: 'card perm-simform' },
      h('div', { class: 'perm-sechead' }, h('div', null, h('h3', { class: 'perm-card__title' }, 'Simulador'), h('p', { class: 'perm-hint' }, 'Escolha quem, o quê e em qual registro. O veredito vem do mesmo motor que protege a aplicação.'))),
      h(
        'div',
        { class: 'perm-simgrid' },
        h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'sim-user' }, 'Usuário'), selectEl({ id: 'sim-user', label: 'Usuário', fk: 'sim:user', value: sim.userId, options: humans().map((u) => ({ value: u.id, label: `${u.name}${u.status !== 'active' ? ` (${STATUS_LABELS[u.status]})` : ''}` })), onChange: (v) => { sim.userId = v; sim.recordId = '__auto__'; rerender(); } })),
        h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'sim-ent' }, 'Recurso'), selectEl({ id: 'sim-ent', label: 'Recurso', fk: 'sim:entity', value: sim.entity, options: SECTIONS.flatMap((s) => s.entities.map((e) => ({ value: e, label: entityLabel(e), group: s.label }))), onChange: (v) => { sim.entity = v; sim.recordId = '__auto__'; rerender(); } })),
        h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'sim-act' }, 'Ação'), selectEl({ id: 'sim-act', label: 'Ação', fk: 'sim:action', value: sim.action, options: ENTITIES[sim.entity].actions.map((a) => ({ value: a, label: actionLabel(a) })), onChange: (v) => { sim.action = v; rerender(); } })),
        h('div', { class: 'perm-field perm-field--wide' }, h('label', { class: 'perm-field__label', for: 'sim-rec' }, 'Registro de exemplo'), selectEl({ id: 'sim-rec', label: 'Registro de exemplo', fk: 'sim:rec', value: sim.recordId, options: [{ value: '', label: 'Sem registro (só verifica a empresa)' }, ...recs.map((r) => ({ value: r.id, label: r.label }))], onChange: (v) => { sim.recordId = v; rerender(); } })),
        keys.includes('toStageId') ? h('div', { class: 'perm-field perm-field--wide' }, h('label', { class: 'perm-field__label', for: 'sim-stage' }, 'Etapa de destino'), selectEl({ id: 'sim-stage', label: 'Etapa de destino', fk: 'sim:stage', value: sim.toStageId, options: stages.map((s) => ({ value: s.id, label: stageLabel(s) })), onChange: (v) => { sim.toStageId = v; rerender(); } })) : null,
        keys.includes('discountPct') ? h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'sim-disc' }, 'Desconto (%)'), h('input', { class: 'input', id: 'sim-disc', type: 'number', min: '0', max: '100', step: 'any', value: sim.discount, placeholder: 'em branco = desconhecido', 'data-fk': 'sim:disc', oninput: (e) => { sim.discount = e.target.value; debounced(); } })) : null,
        keys.includes('rowCount') ? h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'sim-rows' }, 'Linhas a exportar'), h('input', { class: 'input', id: 'sim-rows', type: 'number', min: '0', step: '1', value: sim.rows, placeholder: 'em branco = desconhecido', 'data-fk': 'sim:rows', oninput: (e) => { sim.rows = e.target.value; debounced(); } })) : null
      ),
      keys.length && !context ? h('p', { class: 'perm-hint' }, 'Contexto da operação não informado: o motor trata o que falta como desconhecido e assume o lado seguro (nega/exige aprovação).') : null
    );

    const who = h(
      'div',
      { class: 'perm-who' },
      avatar(user.name),
      h('div', null, h('div', { class: 'perm-person__name' }, user.name, ' ', statusDot(user)), h('div', { class: 'muted' }, (user.roleIds || []).map(roleName).join(', ') || 'Sem perfil', ' · ', (user.teamIds || []).map((id) => ns.team(id)).join(', ') || 'sem equipe', ' · ', user.mfa ? 'MFA ativo' : 'sem MFA'))
    );

    const parts = partitionsInfo(user, ns);
    const fields = fieldsInfo();

    replaceChildren(
      el,
      controls,
      h('div', { class: 'card perm-result' }, who, verdictCard(dec, exp, user, ns)),
      h('section', { class: 'card perm-mapcard', 'aria-labelledby': 'perm-map-t' }, h('div', { class: 'perm-card__head' }, h('h3', { class: 'perm-card__title', id: 'perm-map-t' }, 'Mapa efetivo de ', user.name), h('p', { class: 'perm-hint' }, 'O maior escopo que a pessoa tem em cada recurso, somando todos os perfis. É um resumo: a decisão de verdade é sempre a do motor, registro a registro.')), legend({ withFlags: true }), h('div', { class: 'perm-sec-body' }, heatmap(user)), parts.length ? h('div', { class: 'perm-partinfo' }, h('div', { class: 'label' }, 'Recortes ativos'), h('ul', null, parts.map((p) => h('li', null, p)))) : null),
      h('section', { class: 'card', 'aria-labelledby': 'perm-fld-t' }, h('h3', { class: 'perm-card__title', id: 'perm-fld-t' }, 'Campos ocultos ou travados'), fields.length ? h('ul', { class: 'perm-fieldlist' }, fields.map((f) => h('li', null, h('span', { class: `perm-fchip perm-fchip--${f.lv}` }, FIELD_ACCESS_LABELS[f.lv]), ' ', h('strong', null, fieldLabel(f.entity, f.field)), h('span', { class: 'muted' }, ` · ${entityLabel(f.entity)}`)))) : h('div', { class: 'perm-none' }, 'Nenhum campo oculto ou travado: todos os dados são exibidos normalmente.'))
    );
  }

  const statusDot = (u) => h('span', { class: `perm-status perm-status--${u.status}` }, h('span', { class: 'perm-status__dot', 'aria-hidden': 'true' }), STATUS_LABELS[u.status]);

  // digitar desconto/linhas: re-renderiza depois de uma pausa curta (foco/cursor preservados por keepUi)
  let timer = null;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(() => keepUi(el, build), 250);
  };

  init();
  build();
  return {
    el,
    sig: () => JSON.stringify([store.state.roles, store.state.users, store.state.teams, store.state.tenant.policy, store.state.pipelines.map((p) => [p.id, p.name, p.stages]), store.state.instances.map((i) => [i.id, i.name])]),
    refresh: () => keepUi(el, build),
    hasUnsaved: () => false,
    destroy: () => clearTimeout(timer),
  };
}
