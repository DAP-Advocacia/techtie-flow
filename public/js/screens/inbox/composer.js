// Rodapé da thread: abas Responder / Nota interna / Modelos. O rascunho de cada
// conversa e aba fica guardado (módulo), então trocar de conversa não perde texto —
// mas a chave inclui o USUÁRIO: trocar de usuário no seletor nunca devolve o rascunho de outro.
// Permissões: cada aba reflete o motor (send_message / note); sem nenhuma das duas o composer
// inteiro fica desabilitado com um aviso de contexto.
import { h, replaceChildren } from '../../ui.js';

const TABS = [
  { id: 'reply', label: 'Responder' },
  { id: 'note', label: 'Nota interna' },
  { id: 'templates', label: 'Modelos' },
];

const drafts = new Map(); // `${userId}:${convId}:${tab}` -> texto
const MAX_HEIGHT = 140;
const NONE = { send: { ok: true, msg: '' }, note: { ok: true, msg: '' }, notice: '' };

export function createComposer({ store, onSend }) {
  let convId = null;
  let tab = 'reply';
  let textarea = null;
  let sendBtn = null;
  let access = NONE; // { send, note, notice } vindo do motor
  let accessKey = '';

  const el = h('footer', { class: 'inbox-composer' });

  const userId = () => store.state.currentUserId;
  const key = (t) => `${userId()}:${convId}:${t}`;
  const draftKey = () => key(tab);

  // abas permitidas pelo motor: Modelos preenchem a resposta, então dependem de send_message
  const tabOk = (id) => (id === 'reply' || id === 'templates' ? access.send.ok : access.note.ok);
  const tabWhy = (id) => (id === 'note' ? access.note.msg : access.send.msg);
  const locked = () => !access.send.ok && !access.note.ok;
  const firstAllowedTab = () => (access.send.ok ? 'reply' : access.note.ok ? 'note' : 'reply');

  function autosize() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT)}px`;
  }

  function syncSend() {
    if (sendBtn && textarea) sendBtn.disabled = locked() || !tabOk(tab) || !textarea.value.trim();
  }

  function submit() {
    const text = textarea?.value.trim();
    if (!text || !tabOk(tab)) return;
    const res = onSend(tab === 'note' ? 'note' : 'out', text);
    // o motor negou (perfil mudou entre desenhar e enviar): mantém o rascunho
    if (res === false) return;
    drafts.delete(draftKey());
    textarea.value = '';
    autosize();
    syncSend();
    textarea.focus();
  }

  function input() {
    const isNote = tab === 'note';
    const off = locked() || !tabOk(tab);
    textarea = h('textarea', {
      class: 'inbox-composer__input' + (isNote ? ' is-note' : ''),
      rows: '1',
      'aria-label': isNote ? 'Nota interna' : 'Mensagem',
      placeholder: off ? 'Envio indisponível para o seu perfil' : isNote ? 'Escreva uma nota interna (só a equipe vê)…' : 'Digite uma mensagem…',
      disabled: off,
      title: off ? tabWhy(tab) || access.notice : null,
      oninput: () => {
        drafts.set(draftKey(), textarea.value);
        autosize();
        syncSend();
      },
      onkeydown: (e) => {
        // Enter envia; Shift+Enter quebra linha; Enter durante composição de IME não conta
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          submit();
        }
      },
    });
    textarea.value = off ? '' : drafts.get(draftKey()) || '';
    sendBtn = h('button', { class: 'btn btn--primary inbox-composer__send', type: 'button', onclick: submit, ...(off ? { title: tabWhy(tab) || access.notice } : {}) }, isNote ? 'Salvar nota' : 'Enviar');
    queueMicrotask(() => {
      autosize();
      syncSend();
    });
    return h('div', { class: 'inbox-composer__row' }, textarea, sendBtn);
  }

  function templatesPanel() {
    textarea = sendBtn = null;
    const list = store.state.messageTemplates || [];
    if (!list.length) return h('div', { class: 'inbox-composer__none' }, 'Nenhum modelo cadastrado.');
    return h(
      'div',
      { class: 'inbox-templates', role: 'group', 'aria-label': 'Modelos de mensagem' },
      list.map((t) =>
        h(
          'button',
          {
            class: 'inbox-template',
            type: 'button',
            onclick: () => {
              if (!access.send.ok) return;
              drafts.set(key('reply'), t.text);
              setTab('reply');
              focusEnd();
            },
          },
          h('span', { class: 'inbox-template__name' }, t.name),
          h('span', { class: 'inbox-template__text' }, t.text)
        )
      )
    );
  }

  function render() {
    const hint = locked() ? 'Somente leitura' : tab === 'note' ? 'Visível só para a equipe' : tab === 'reply' ? 'Enter envia · Shift+Enter quebra linha' : 'Clique para preencher a resposta';
    replaceChildren(
      el,
      access.notice ? h('div', { class: 'inbox-composer__notice', role: 'status' }, access.notice) : null,
      h(
        'div',
        { class: 'inbox-composer__tabs' },
        h(
          'div',
          { class: 'inbox-composer__tablist', role: 'tablist', 'aria-label': 'Tipo de mensagem' },
          TABS.map((t) =>
            h(
              'button',
              {
                class: 'tab-underline' + (t.id === tab ? ' is-active' : ''),
                type: 'button',
                role: 'tab',
                'aria-selected': String(t.id === tab),
                onclick: () => setTab(t.id),
                ...(tabOk(t.id) ? {} : { disabled: true, title: tabWhy(t.id), 'aria-label': `${t.label} — indisponível: ${tabWhy(t.id)}` }),
              },
              t.label
            )
          )
        ),
        h('span', { class: 'inbox-composer__hint', title: hint }, hint)
      ),
      tab === 'templates' && tabOk('templates') ? templatesPanel() : input()
    );
  }

  function setTab(next) {
    if (!tabOk(next)) return;
    tab = next;
    render();
    if (next !== 'templates') textarea?.focus();
  }

  function focusEnd() {
    if (!textarea || textarea.disabled) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  return {
    el,
    /** Mostra o composer da conversa (começa em Responder, ou na primeira aba que o perfil permite). */
    show(id, next) {
      if (id === convId) return;
      convId = id;
      access = next || NONE;
      tab = firstAllowedTab();
      accessKey = '';
      render();
    },
    /**
     * Veredito do motor para a conversa atual ({ send, note, notice }). Só redesenha se algo mudou,
     * para não tirar o foco nem apagar o que está sendo digitado.
     */
    setAccess(next) {
      access = next || NONE;
      const k = JSON.stringify([convId, access.send.ok, access.send.msg, access.note.ok, access.note.msg, access.notice]);
      if (k === accessKey) return;
      accessKey = k;
      if (!tabOk(tab)) tab = firstAllowedTab();
      render();
    },
    /** "Usar resposta" da IA: joga o texto no campo de resposta (anexando ao rascunho, se houver). */
    fill(text) {
      if (!access.send.ok) return;
      // não atropela o que o atendente já digitou: anexa em nova linha
      const prev = (drafts.get(key('reply')) || '').trimEnd();
      drafts.set(key('reply'), prev ? `${prev}\n${text}` : text);
      tab = 'reply';
      render();
      focusEnd();
    },
    focus: focusEnd,
  };
}
