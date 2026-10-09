// Ajudantes de permissão das telas Agente de IA, Automações, Dashboard,
// Instâncias e Configurações. NÃO tomam decisão própria: tudo vem do motor via
// access.js (decide). Aqui só se traduz a decisão em UI consistente:
//   - controle bloqueado fica DESABILITADO (não some), com `title` e
//     `aria-describedby` apontando para o motivo ("Seu perfil não permite…");
//   - tela inteira sem nenhuma permissão de edição vira "modo leitura" (aviso no topo);
//   - handlers também checam (defesa em profundidade): a UI não é a barreira,
//     mas um clique programático num botão desabilitado não pode alterar nada.
import { h, icon, toast } from '../../ui.js';
import { decide, denyMessage } from '../../access.js';

const VERBS = {
  'ai_agent.update': 'alterar o Agente de IA',
  'automation.create': 'criar automações',
  'automation.update': 'editar automações',
  'automation.publish': 'publicar, ativar ou pausar automações',
  'automation.delete': 'remover automações',
  'instance.create': 'conectar novos números',
  'instance.connect': 'conectar, reconectar ou desconectar números',
  'instance.update': 'renomear ou alterar números',
  'instance.delete': 'remover números',
  'tenant_settings.update': 'alterar as configurações da empresa',
  'report.export': 'exportar relatórios',
};

/** Decisão do motor → { ok, msg, d }. `msg` vazio quando permitido. */
export function check(entity, action, row, context) {
  const d = decide(entity, action, row, context);
  const ok = d.effect === 'allow';
  if (ok) return { ok, msg: '', d };
  const verb = VERBS[`${entity}.${action}`];
  const msg = d.reason === 'no_grant' && verb ? `Seu perfil não permite ${verb}.` : denyMessage(d);
  return { ok, msg, d };
}

/** Avisa (toast) que a ação foi barrada e devolve true. Uso: `if (blocked(c)) return;` */
export function blocked(c) {
  if (c.ok) return false;
  toast(c.msg);
  return true;
}

/** Algum dos checks permite? (decide se a tela inteira é "somente leitura") */
export const anyOk = (...checks) => checks.some((c) => c.ok);

const STYLE_ID = 'perm-ops-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
.perm-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.perm-banner{display:flex;align-items:center;gap:8px;margin:0;padding:8px 12px;border:1px solid var(--line);border-radius:var(--radius-input);background:var(--note-bg);color:var(--mute);font-size:13px;line-height:1.4}
.perm-banner[hidden]{display:none}
.perm-banner svg{flex:none;color:var(--acc)}
[data-perm-locked]{cursor:not-allowed}
.toggle:disabled{opacity:.5;cursor:not-allowed}
.select:disabled,.input:disabled,.textarea:disabled{opacity:.6;cursor:not-allowed}
.textarea[readonly][data-perm-locked],.input[readonly][data-perm-locked]{opacity:.8}
`;
  document.head.append(st);
}

const LOCK = 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3';

/** Aviso discreto de "Modo leitura". `on=false` devolve um contêiner vazio (fácil de recolocar). */
export function banner(on) {
  ensureStyle();
  return h(
    'div',
    { class: 'perm-banner', role: 'note', hidden: !on, 'data-perm-banner': '' },
    icon(LOCK, 15),
    h('span', null, 'Modo leitura — seu perfil não permite editar')
  );
}

/** Contêiner de textos de apoio (aria-describedby) de UMA montagem de tela/modal. */
let seq = 0;
export function createHints() {
  ensureStyle();
  const host = h('div', { class: 'perm-sr', 'data-perm-hints': '' });
  const ids = new Map();
  const idFor = (msg) => {
    let id = ids.get(msg);
    if (!id) {
      id = `perm-hint-${++seq}`;
      ids.set(msg, id);
      host.append(h('span', { id }, msg));
    }
    return id;
  };

  /**
   * Aplica (ou remove) o bloqueio de `c` em `el`.
   *  - `other`: outro motivo, independente de permissão, para manter desabilitado.
   *  - `readOnly`: campos de texto ficam somente leitura (dá pra selecionar/copiar) em vez de disabled.
   */
  function lock(el, c, { other = false, readOnly = false } = {}) {
    if (!el) return el;
    if (readOnly) el.readOnly = !c.ok;
    else el.disabled = !c.ok || other;
    if (readOnly) el.setAttribute('aria-readonly', String(!c.ok));
    const prevDesc = el.dataset.permDesc ?? el.getAttribute('aria-describedby') ?? '';
    if (!c.ok) {
      if (el.dataset.permLocked == null) {
        el.dataset.permTitle = el.getAttribute('title') ?? '';
        el.dataset.permDesc = prevDesc;
      }
      el.dataset.permLocked = '';
      el.title = c.msg;
      el.setAttribute('aria-describedby', [el.dataset.permDesc, idFor(c.msg)].filter(Boolean).join(' '));
    } else if (el.dataset.permLocked != null) {
      delete el.dataset.permLocked;
      if (el.dataset.permTitle) el.title = el.dataset.permTitle;
      else el.removeAttribute('title');
      if (el.dataset.permDesc) el.setAttribute('aria-describedby', el.dataset.permDesc);
      else el.removeAttribute('aria-describedby');
      delete el.dataset.permTitle;
      delete el.dataset.permDesc;
    }
    return el;
  }

  /** Vale para itens que não são controles nativos (ex.: itens de menu): aria-disabled + dica, sem `disabled`. */
  function lockSoft(el, c) {
    if (!c.ok) {
      el.setAttribute('aria-disabled', 'true');
      el.dataset.permLocked = '';
      el.title = c.msg;
      el.setAttribute('aria-describedby', idFor(c.msg));
    }
    return el;
  }

  return { host, idFor, lock, lockSoft };
}
