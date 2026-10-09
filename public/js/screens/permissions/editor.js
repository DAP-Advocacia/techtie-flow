// Editor de UM perfil (lado direito da aba Perfis): cabeçalho, matriz, regras
// avançadas, negações, recortes, campos e barra de salvar.
//
// A UI é reflexo, não barreira: o editor mexe num RASCUNHO (ed.role) e só o
// diálogo "Revisar e salvar" → actions.saveRole() grava, depois de o motor
// validar tudo (validateRole, checkNoEscalation, decide).
import { h, icon, replaceChildren } from '../../ui.js';
import { ENTITIES, diffRoles } from '/shared/permissions/index.js';
import { SECTIONS, entityLabel, actionLabel, scopeShort, scopeLabel, scopeLevel, SCOPE_LABELS, plural } from './labels.js';
import { simpleCells, advancedCells, denyCells, setCell, normalizeRole, validateDraftRole, blankRole } from './model.js';
import { matrixSections, meter, legend } from './matrix.js';
import { advancedSection, deniesSection } from './rules.js';
import { partitionsSection, fieldsSection } from './restrict.js';
import { keepUi, selectEl, ICON, sr } from './util.js';

/**
 * createEditor(opts) -> { el, ed, destroy }
 *  opts.draft      { role, base, isNew, cloneOf, showErrors, touchedName, baseSig } (rascunho) — ou null (só leitura)
 *  opts.role       perfil exibido quando não há rascunho (leitura)
 *  opts.readOnly / opts.readReason / opts.system
 *  opts.rootEl     elemento da aba (escopo do keepUi)
 *  opts.onDirty()  avisa a aba (ponto de "não salvo", lista)
 *  opts.onReview(), onDiscard(), onClone(), onDelete(), usersCount, deleteBlock (texto ou null)
 */
export function createEditor(opts) {
  const { draft, state, ns, rootEl, system, readOnly, readReason } = opts;
  const role = draft ? draft.role : JSON.parse(JSON.stringify(opts.role));
  const ed = {
    role,
    readOnly,
    state,
    ns,
    errs: null,
    refresh,
    touch,
  };
  let nameErrEl;
  let nameInputEl;
  let nameCountEl;
  let statusEl;
  let reviewBtn;
  let discardBtn;
  const errBoxEl = h('div', { class: 'perm-errbox' });

  const hosts = {};
  const cards = [];
  const addCard = (id, title, sub, build, { wide = false } = {}) => {
    const host = h('div', { class: 'perm-card__body' });
    hosts[id] = { host, build };
    const el = h(
      'section',
      { class: 'card perm-card' + (wide ? ' perm-card--wide' : ''), id: `perm-card-${id}`, 'aria-labelledby': `perm-card-${id}-t` },
      h('header', { class: 'perm-card__head' }, h('h3', { class: 'perm-card__title', id: `perm-card-${id}-t` }, title), sub ? h('p', { class: 'perm-hint' }, sub) : null),
      host
    );
    cards.push(el);
    return el;
  };

  // ---------------- validação viva ----------------
  function validateNow() {
    if (!draft) return;
    const full = validateDraftRole(role, { tenantId: state.tenant.id, id: draft.isNew ? '__novo__' : draft.base.id });
    ed.fullErrs = full;
    // erros de regra só aparecem depois da primeira tentativa de salvar (não gritar com quem ainda está montando)
    ed.errs = draft.showErrors ? full : { ...full, byAdv: new Map(), denies: new Map(), other: [] };
  }

  // ---------------- seções ----------------
  function buildHead() {
    nameErrEl = h('div', { class: 'field-error', id: 'perm-name-err', role: 'alert' });
    nameCountEl = h('span', { class: 'perm-hint perm-count' });
    const banners = [];
    if (system) banners.push(h('div', { class: 'perm-banner perm-banner--lock', role: 'note' }, icon(ICON.lock, 16), h('div', null, h('strong', null, 'Perfil de fábrica — clone para personalizar. '), 'Perfis de fábrica são imutáveis para que a base de segurança nunca mude sem querer.'), opts.onClone ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: opts.onClone, disabled: !!opts.cloneBlock, title: opts.cloneBlock || '' }, icon(ICON.copy, 14), ' Clonar') : null));
    else if (readOnly) banners.push(h('div', { class: 'perm-banner perm-banner--lock', role: 'note' }, icon(ICON.lock, 16), h('div', null, h('strong', null, 'Modo leitura. '), readReason || 'Você não pode editar perfis.')));

    const meta = h(
      'div',
      { class: 'perm-meta' },
      h('span', { class: 'chip' }, system ? 'sistema' : draft?.isNew ? 'novo · não salvo' : 'personalizado'),
      h('span', { class: 'muted' }, plural(opts.usersCount || 0, 'usuário', 'usuários')),
      draft?.cloneOf ? h('span', { class: 'muted' }, `· clone de ${draft.cloneOf.name}`) : null
    );
    const actions = h(
      'div',
      { class: 'perm-head__actions' },
      !draft?.isNew && opts.onClone && !system ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: opts.onClone, disabled: !!opts.cloneBlock, title: opts.cloneBlock || 'Cria uma cópia editável deste perfil' }, icon(ICON.copy, 14), ' Clonar') : null,
      !system && !draft?.isNew && opts.onDelete ? h('button', { class: 'btn btn--quiet btn--sm perm-btn--danger-quiet', type: 'button', onclick: opts.onDelete, 'data-fk': 'role:delete', 'aria-disabled': opts.deleteBlock ? 'true' : null, title: opts.deleteBlock || 'Excluir este perfil' }, icon(ICON.trash, 14), ' Excluir') : null
    );

    if (readOnly || !draft) {
      return h('div', { class: 'perm-head' }, banners, h('div', { class: 'perm-head__top' }, h('div', null, h('h2', { class: 'perm-role-name' }, role.name), meta), actions), role.description ? h('p', { class: 'perm-role-desc' }, role.description) : null);
    }
    const nameInput = (nameInputEl = h('input', {
      class: 'input',
      id: 'perm-name',
      value: role.name || '',
      placeholder: 'Ex.: Atendente sênior',
      'data-fk': 'name',
      'aria-describedby': 'perm-name-err',
      oninput: (e) => {
        role.name = e.target.value;
        draft.touchedName = true;
        touch();
      },
    }));
    const descInput = h('textarea', {
      class: 'textarea perm-desc',
      id: 'perm-desc',
      rows: '2',
      placeholder: 'Para que serve este perfil?',
      'data-fk': 'desc',
      oninput: (e) => {
        role.description = e.target.value;
        touch();
      },
    });
    descInput.value = role.description || '';
    return h(
      'div',
      { class: 'perm-head' },
      banners,
      h('div', { class: 'perm-head__top' }, h('div', { class: 'perm-head__fields' }, h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'perm-name' }, 'Nome do perfil', nameCountEl), nameInput, nameErrEl), h('div', { class: 'perm-field' }, h('label', { class: 'perm-field__label', for: 'perm-desc' }, 'Descrição'), descInput)), h('div', { class: 'perm-head__side' }, meta, actions))
    );
  }

  function buildMatrix() {
    const cells = simpleCells(role);
    const adv = advancedCells(role);
    const den = denyCells(role);
    const flags = (e, a) => {
      const k = `${e}.${a}`;
      const out = [];
      if (adv.get(k)) out.push(h('button', { type: 'button', class: 'perm-flag', title: `${plural(adv.get(k), 'regra avançada', 'regras avançadas')} nesta célula — editar em "Regras avançadas"`, 'aria-label': `${plural(adv.get(k), 'regra avançada', 'regras avançadas')}: ${entityLabel(e)} ${actionLabel(a)}`, onclick: () => document.getElementById('perm-card-adv')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, '⚙'));
      const d = den.get(k);
      if (d) out.push(h('span', { class: 'perm-flag perm-flag--deny' + (d.full ? ' is-full' : ''), role: 'img', 'aria-label': d.full ? 'Bloqueado por negação' : 'Bloqueado por negação condicional', title: d.full ? 'Uma negação bloqueia esta ação (vence a permissão)' : 'Uma negação condicional bloqueia esta ação em alguns casos' }, '⊘'));
      return out;
    };
    const cell = (e, a) => {
      const cur = cells.get(`${e}.${a}`) || 'none';
      const lvl = scopeLevel(cur);
      if (readOnly) {
        return h('div', { class: `perm-cell perm-cell--ro perm-lvl-${lvl}` }, meter(lvl), h('span', { class: 'perm-cell__txt' }, scopeShort(cur)), flags(e, a));
      }
      const sel = selectEl({
        options: ENTITIES[e].scopes.map((s) => ({ value: s, label: scopeShort(s) })),
        value: cur,
        label: `${entityLabel(e)} › ${actionLabel(a)}`,
        fk: `cell:${e}.${a}`,
        cls: 'perm-cellsel',
        onChange: (v) => {
          setCell(role, e, a, v);
          refresh(['matrix']);
        },
      });
      sel.title = SCOPE_LABELS[cur].hint;
      return h('div', { class: `perm-cell perm-lvl-${lvl}` }, meter(lvl), sel, flags(e, a));
    };
    return h('div', { class: 'perm-sec-body' }, legend(), matrixSections({ cell, scrollKey: 'edit' }));
  }

  addCard('matrix', 'Matriz de permissões', 'Escolha, para cada recurso e ação, até onde o perfil alcança.', buildMatrix, { wide: true });
  addCard('adv', 'Regras avançadas', 'Permissões com condição ou aprovação.', () => advancedSection(ed), { wide: true });
  addCard('deny', 'Negações', 'Travas que vencem qualquer permissão.', () => deniesSection(ed), { wide: true });
  addCard('part', 'Recortes', null, () => partitionsSection(ed));
  addCard('fields', 'Campos sensíveis', null, () => fieldsSection(ed));

  // ---------------- barra de salvar ----------------
  const bar = !readOnly && draft
    ? h(
        'div',
        { class: 'perm-savebar', role: 'region', 'aria-label': 'Salvar alterações' },
        (statusEl = h('span', { class: 'perm-savebar__status', role: 'status' })),
        h('div', { class: 'perm-savebar__actions' }, (discardBtn = h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => opts.onDiscard?.(), 'data-fk': 'bar:discard' }, 'Descartar alterações')), (reviewBtn = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => opts.onReview?.(), 'data-fk': 'bar:review' }, 'Revisar e salvar')))
      )
    : null;

  const grid = h('div', { class: 'perm-grid2' }, cards[3], cards[4]);
  hosts.head = { host: h('div', { class: 'perm-card__body' }), build: buildHead };
  const head = h('div', { class: 'card perm-card perm-card--head' }, hosts.head.host);
  const el = h('div', { class: 'perm-editor' }, head, errBoxEl, cards[0], cards[1], cards[2], grid, bar);

  function renderHost(id) {
    const { host, build } = hosts[id];
    replaceChildren(host, build());
  }

  /** Recalcula validação e atualiza o que é "cromo" (erro do nome, contador, barra). */
  function touch() {
    validateNow();
    if (draft) {
      const nameLen = (role.name || '').length;
      if (nameCountEl) {
        nameCountEl.textContent = `${nameLen}/60`;
        nameCountEl.classList.toggle('is-over', nameLen > 60);
      }
      const nameErrs = ed.fullErrs?.name || [];
      const show = draft.touchedName || draft.showErrors;
      if (nameErrEl) nameErrEl.textContent = show && nameErrs.length ? capital(nameErrs[0]) : '';
      nameInputEl?.setAttribute('aria-invalid', show && nameErrs.length ? 'true' : 'false');
      fillErrSlots();
      const sig = JSON.stringify(normalizeRole(role));
      draft.dirty = draft.isNew || sig !== draft.baseSig;
      const before = draft.isNew ? draft.cloneOf || blankRole() : draft.base;
      const n = diffRoles(normalizeRole(before), normalizeRole(role)).filter((c) => !(draft.isNew && c.kind === 'name')).length;
      draft.changeCount = n;
      if (statusEl) {
        statusEl.textContent = draft.isNew ? 'Perfil novo, ainda não salvo.' : draft.dirty ? `${plural(n || 1, 'alteração não salva', 'alterações não salvas')}.` : 'Sem alterações.';
        statusEl.classList.toggle('is-dirty', !!draft.dirty);
      }
      if (reviewBtn) reviewBtn.disabled = !draft.dirty;
      if (discardBtn) discardBtn.disabled = !draft.dirty && !draft.isNew;
      if (discardBtn) discardBtn.textContent = draft.isNew ? 'Descartar rascunho' : 'Descartar alterações';
      if (errBoxEl) renderErrBox();
    }
    opts.onDirty?.();
  }

  /** Atualiza no lugar as listas de erro das regras (sem refazer a seção e perder o foco). */
  function fillErrSlots() {
    for (const slot of el.querySelectorAll('[data-errslot]')) {
      const [kind, i] = slot.dataset.errslot.split(':');
      const msgs = (kind === 'adv' ? ed.errs?.byAdv : ed.errs?.denies)?.get(Number(i)) || [];
      replaceChildren(slot, msgs.map((m) => h('li', null, capital(m))));
    }
  }

  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /** Erros que não pertencem a uma regra específica (recortes, campos…). */
  function renderErrBox() {
    const other = draft.showErrors ? ed.errs?.other || [] : [];
    replaceChildren(errBoxEl, other.length ? h('div', { class: 'perm-banner perm-banner--err', role: 'alert' }, h('div', null, h('strong', null, 'Corrija antes de salvar: '), h('ul', { class: 'perm-errors' }, other.map((e) => h('li', null, `${e.path}: ${e.message}`))))) : null);
  }

  /** Re-renderiza seções (com foco/rolagem preservados) e atualiza o cromo. */
  function refresh(names, { focus } = {}) {
    validateNow();
    keepUi(rootEl, () => names.forEach(renderHost));
    if (focus) el.querySelector(`[data-fk="${CSS.escape(focus)}"]`)?.focus();
    touch();
  }

  // montagem inicial
  for (const id of ['head', 'matrix', 'adv', 'deny', 'part', 'fields']) renderHost(id);
  touch();

  return { el, ed, destroy() {} };
}

export { SECTIONS, scopeLabel };
