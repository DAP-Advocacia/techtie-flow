// Conexão de número no MODO OPERAÇÃO: QR Code REAL vindo do servidor (Baileys), com os estados
// reais do gateway (fila de pareamento → iniciando → QR → conectado). O diálogo do protótipo
// (connect-flow.js) simula tudo isso com temporizadores; aqui nada é simulado.
import { h, replaceChildren, toast } from '../../ui.js';
import { openModal } from './modal.js';
import * as live from '../../live.js';

const NAME_MAX = 60;

export function openLiveConnect({ instance = null, returnFocus, onFinish } = {}) {
  const st = { step: instance ? 'connect' : 'name', inst: instance, status: instance?.status || 'disconnected', qr: null, error: '', busy: false };
  let off = null;
  let poll = null;
  const stop = () => {
    off?.();
    clearInterval(poll);
    poll = null;
  };
  const m = openModal({ size: 'lg', returnFocus: () => returnFocus?.(st.inst?.id), onClose: stop });
  const cancel = (label = 'Cancelar') => h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => m.close() }, label);
  const spinner = () => h('span', { class: 'instances-spinner', 'aria-hidden': 'true' });
  const center = (title, sub) => h('div', { class: 'instances-center', role: 'status' }, spinner(), h('div', { class: 'instances-center__title' }, title), sub ? h('p', { class: 'muted instances-center__sub' }, sub) : null);

  async function start() {
    st.busy = true;
    st.error = '';
    render();
    try {
      if (!st.inst) st.inst = await live.createInstance(st.name);
      st.step = 'connect';
      off = live.onInstanceEvent((ev) => {
        if (ev.instance.id !== st.inst.id) return;
        st.status = ev.instance.status;
        if (ev.qr) st.qr = ev.qr;
        if (st.status === 'connected') finish();
        else render();
      });
      await live.connectInstance(st.inst.id);
      // rede de segurança: se um evento do WebSocket se perder, consulta o estado a cada 3 s
      poll = setInterval(async () => {
        try {
          const r = await live.instanceState(st.inst.id);
          st.status = r.status;
          if (r.qr) st.qr = r.qr;
          if (st.status === 'connected') finish();
          else render();
        } catch {
          /* próxima volta tenta de novo */
        }
      }, 3000);
    } catch (e) {
      st.step = 'name';
      st.error = e.message;
    }
    st.busy = false;
    render();
  }

  function finish() {
    stop();
    st.status = 'connected';
    toast('WhatsApp conectado.');
    onFinish?.(st.inst?.id);
    render();
  }

  function build() {
    if (st.step === 'name') {
      m.setTitle('Conectar ao WhatsApp', 'Novo número');
      const input = h('input', { class: 'input', maxlength: String(NAME_MAX), placeholder: 'Ex.: Comercial', value: st.name, 'aria-label': 'Nome do número', oninput: (e) => (st.name = e.target.value) });
      const submit = () => {
        st.name = st.name.trim();
        if (!st.name) return (st.error = 'Dê um nome ao número.'), render();
        start();
      };
      return {
        body: [
          h('form', { class: 'instances-form', onsubmit: (e) => (e.preventDefault(), submit()) },
            h('label', { class: 'field' }, 'Nome do número', input),
            st.error ? h('div', { class: 'field-error', role: 'alert' }, st.error) : null,
            h('div', { class: 'instances-note' }, h('span', null, 'Na próxima etapa você lê um QR Code com o celular do número. Use um chip de teste: o WhatsApp pode restringir números que usam conexão não oficial.'))),
        ],
        foot: [cancel(), h('button', { class: 'btn btn--primary', type: 'button', disabled: st.busy, onclick: submit }, st.busy ? 'Criando…' : 'Gerar QR Code')],
        focus: input,
      };
    }
    m.setTitle(st.inst?.name ? `Conectar ${st.inst.name}` : 'Conectar ao WhatsApp', 'Pareamento');
    if (st.status === 'connected') {
      return { body: [h('div', { class: 'instances-center', role: 'status' }, h('div', { class: 'instances-center__title' }, 'Conectado!'), h('p', { class: 'muted instances-center__sub' }, 'O WhatsApp está pareado. As mensagens já chegam no Inbox.'))], foot: [h('button', { class: 'btn btn--primary', type: 'button', onclick: () => m.close() }, 'Concluir')], focus: 'foot' };
    }
    if ((st.status === 'qr' || st.status === 'connecting') && st.qr && /^data:image\/(png|jpeg);base64,/.test(st.qr)) {
      return {
        body: [
          h('div', { class: 'instances-qrwrap' },
            h('div', { class: 'instances-qrcol' }, h('img', { src: st.qr, alt: 'QR Code para parear o WhatsApp', width: '264', height: '264', style: 'background:#fff;padding:12px;border-radius:12px;display:block' })),
            h('div', { class: 'instances-qrinfo' },
              h('ol', { class: 'instances-steps' },
                h('li', null, 'Abra o WhatsApp no celular do número.'),
                h('li', null, 'Toque em ', h('strong', null, 'Mais opções › Aparelhos conectados'), '.'),
                h('li', null, 'Toque em ', h('strong', null, 'Conectar um aparelho'), ' e aponte a câmera para o código.')),
              h('p', { class: 'muted instances-hint' }, 'O código renova sozinho. Não compartilhe esta tela: quem ler o QR controla a conta.'))),
        ],
        foot: [cancel()],
        focus: null,
      };
    }
    if (st.status === 'queued') return { body: [center('Aguarde, sua vez está chegando', 'Isto não é um erro: organizamos uma fila para o WhatsApp não recusar conexões simultâneas. Mantenha esta janela aberta.')], foot: [cancel()], focus: null };
    if (st.status === 'attention') return { body: [h('div', { class: 'instances-note instances-note--warn', role: 'alert' }, h('strong', null, 'Este número precisa de atenção'), h('span', null, st.inst?.attentionReason || 'O WhatsApp encerrou a sessão. Tente gerar um novo QR.'))], foot: [cancel('Fechar')], focus: null };
    return { body: [center('Iniciando a sessão…', 'Preparando o QR Code. Só um instante.')], foot: [cancel()], focus: null };
  }

  function render() {
    const view = build();
    replaceChildren(m.body, view.body);
    replaceChildren(m.foot, view.foot);
    if (view.focus === 'foot') m.focus(m.foot.querySelector('button'));
    else if (view.focus) m.focus(view.focus);
  }

  render();
  if (instance) start(); // reconectar: já tem número, vai direto ao QR
  return m;
}
