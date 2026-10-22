// #/profile — Meu perfil: cada pessoa vê os próprios dados e edita nome, cargo, telefone e "sobre você".
// E-mail, perfil de acesso, equipes e verificação em duas etapas são só leitura (quem muda é um administrador).
// Vale só para a PRÓPRIA pessoa: não há como abrir/editar o perfil de outra por aqui.
import { h, replaceChildren, avatar, toast } from '../ui.js';
import { audit } from '../access.js';
import * as live from '../live.js';
import { LIMITS, normalizeProfile, validateProfile, changedFields } from './profile/model.js';

const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

/** Salva os campos que mudaram. Em operação o servidor valida e guarda; no protótipo grava no navegador. */
export async function saveProfile(store, fields) {
  const me = store.user();
  if (!me) return { ok: false, error: 'Faça login de novo.' };
  const errors = validateProfile(fields);
  if (Object.keys(errors).length) return { ok: false, errors, error: Object.values(errors)[0] };
  const patch = changedFields(me, fields);
  if (!Object.keys(patch).length) return { ok: true, unchanged: true };
  try {
    if (live.enabled) await live.saveProfile(patch);
    else {
      store.update((s) => Object.assign(s.users.find((u) => u.id === me.id), patch));
      audit('profile.update', me.id, `Perfil de ${me.name} atualizado (${Object.keys(patch).join(', ')})`);
    }
    return { ok: true, patch };
  } catch (e) {
    return { ok: false, error: e.message || 'Não foi possível salvar.' };
  }
}

export default {
  mount(el, { store }) {
    const root = h('div', { class: 'page profile' });
    el.append(root);
    let draft = null; // o que a pessoa está digitando (nasce com o salvo)
    let busy = false;
    let errors = {};
    let saved = '';

    const me = () => store.user();
    const snapshot = (u) => ({ name: u?.name || '', jobTitle: u?.jobTitle || '', phone: u?.phone || '', bio: u?.bio || '' });
    const dirty = () => Object.keys(changedFields(me(), draft)).length > 0;

    function field(key, label, control, hint) {
      return h('label', { class: 'field profile-field' }, label, control, errors[key] ? h('span', { class: 'field-error', role: 'alert' }, errors[key]) : hint ? h('span', { class: 'profile-hint' }, hint) : null);
    }
    const input = (key, attrs = {}) => {
      const i = h(attrs.textarea ? 'textarea' : 'input', { class: attrs.textarea ? 'textarea' : 'input', name: key, value: draft[key], maxlength: String(LIMITS[key]), autocomplete: 'off', 'aria-invalid': errors[key] ? 'true' : null, 'data-field': key, ...attrs.attrs });
      if (attrs.textarea) i.rows = 4;
      i.addEventListener('input', () => {
        draft[key] = i.value;
        const ok = $save();
        if (ok) ok.disabled = busy || !dirty();
        const d = root.querySelector('[data-act="discard"]');
        if (d) d.hidden = !dirty();
        const c = root.querySelector('.profile-count');
        if (c && key === 'bio') c.textContent = `${i.value.length}/${LIMITS.bio}`;
      });
      return i;
    };
    const $save = () => root.querySelector('[data-act="save"]');

    function draw() {
      const u = me();
      if (!u) return;
      if (!draft) draft = snapshot(u);
      const s = store.state;
      const roles = s.roles.filter((r) => (u.roleIds || []).includes(r.id));
      const teams = s.teams.filter((t) => (u.teamIds || []).includes(t.id));
      const shownName = normalizeProfile(draft).name || u.name;
      const fk = root.contains(document.activeElement) ? document.activeElement.dataset?.field : null;
      replaceChildren(
        root,
        h('header', { class: 'page-header' }, h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'CONTA'), h('h1', { class: 'page-title' }, 'MEU PERFIL'))),
        h(
          'div',
          { class: 'profile-grid' },
          h(
            'section',
            { class: 'card profile-card', 'aria-label': 'Resumo' },
            h('div', { class: 'profile-hero' }, avatar(shownName), h('div', { class: 'profile-hero__text' }, h('h2', { class: 'profile-hero__name' }, shownName), draft.jobTitle ? h('span', { class: 'muted' }, normalizeProfile(draft).jobTitle) : null)),
            h(
              'dl',
              { class: 'profile-facts' },
              fact('E-mail', u.email || '—'),
              fact('Perfil de acesso', roles.length ? h('span', { class: 'profile-tags' }, ...roles.map((r) => h('span', { class: 'chip' }, r.name))) : 'Sem perfil'),
              fact('Equipes', teams.length ? h('span', { class: 'profile-tags' }, ...teams.map((t) => h('span', { class: 'chip' }, t.name))) : 'Sem equipe'),
              fact('Empresa', s.tenant.name),
              fact('Verificação em duas etapas', u.mfa ? 'Ativada' : 'Desativada'),
              fact('Na equipe desde', fmtDate(u.joinedAt))
            ),
            h('p', { class: 'profile-hint' }, 'E-mail, perfil de acesso e equipes são definidos por um administrador da empresa.')
          ),
          h(
            'form',
            {
              class: 'card profile-card profile-form',
              novalidate: true,
              'aria-label': 'Editar meus dados',
              onsubmit: async (e) => {
                e.preventDefault();
                if (busy || !dirty()) return;
                busy = true;
                errors = {};
                const r = await saveProfile(store, draft);
                busy = false;
                if (r.ok) {
                  saved = 'Dados atualizados.';
                  draft = snapshot(me());
                  toast('Perfil atualizado');
                } else {
                  errors = r.errors || { name: r.error };
                  saved = '';
                }
                draw();
              },
            },
            h('span', { class: 'label' }, 'Meus dados'),
            field('name', 'Nome', input('name', { attrs: { 'data-autofocus': true } })),
            field('jobTitle', 'Cargo', input('jobTitle', { attrs: { placeholder: 'Ex.: Executiva de contas' } })),
            field('phone', 'Telefone', input('phone', { attrs: { type: 'tel', inputmode: 'tel', placeholder: '+55 11 99999-0000' } }), 'Só aparece para você e para quem administra usuários.'),
            field('bio', 'Sobre você', input('bio', { textarea: true, attrs: { placeholder: 'Uma frase sobre o seu trabalho (aparece para os colegas).' } }), null),
            h('span', { class: 'profile-count profile-hint' }, `${draft.bio.length}/${LIMITS.bio}`),
            saved ? h('p', { class: 'profile-saved', role: 'status' }, saved) : null,
            h(
              'div',
              { class: 'profile-actions' },
              h('span', { class: 'profile-spacer' }),
              h('button', { class: 'btn btn--quiet', type: 'button', 'data-act': 'discard', hidden: !dirty(), onclick: () => ((draft = snapshot(me())), (errors = {}), (saved = ''), draw()) }, 'Descartar'),
              h('button', { class: 'btn btn--primary', type: 'submit', 'data-act': 'save', disabled: busy || !dirty() }, busy ? 'Salvando…' : 'Salvar alterações')
            )
          )
        )
      );
      if (fk) root.querySelector(`[data-field="${fk}"]`)?.focus();
    }
    const fact = (label, value) => h('div', { class: 'profile-fact' }, h('dt', { class: 'label' }, label), h('dd', null, value));

    draw();
    // mudanças de fora (o servidor mandou o nome novo) só entram se a pessoa ainda não mexeu em nada
    return store.subscribe(() => {
      if (busy) return;
      if (!dirty()) draft = null;
      draw();
    });
  },
};
