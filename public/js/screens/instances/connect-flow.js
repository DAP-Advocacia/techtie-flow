// Fluxo de conexão de número (modal). Passos:
//   1. Canal  ->  2. Dados  ->  3. Conexão
//   Baileys:   fila (queued) -> iniciando (connecting) -> QR com expiração -> lido -> conectado
//   Cloud API: login Meta (Embedded Signup simulado) -> escolher número -> registrando -> conectado
// "Reconectar" pula o passo 1 (o canal é o da instância) e o nome.
//
// Cada fase tem seus próprios timers; render() limpa todos antes de montar a
// próxima, e fechar o modal limpa tudo (nada vaza ao sair da tela).
// Dentro de uma fase os ticks atualizam só os nós afetados (sem re-render) para
// não roubar o foco do teclado.
import { h, icon, replaceChildren, toast } from '../../ui.js';
import { store } from '../../store.js';
import { openModal } from './modal.js';
import { qrSvg } from './qr.js';
import { CHANNELS, ATTENTION, ICON, META_NUMBERS, NAME_MAX, nameError, ownerOptions } from './channels.js';
import { addInstance, markConnected } from './actions.js';
import { check } from '../_ops/perm.js';

// Tempos da simulação. A fila imita o semáforo do gateway (docs, seção 2).
const QUEUE_START = 3;
const QUEUE_TICK_MS = 1100;
const CONNECTING_MS = 1400;
const QR_TTL_MS = 45000;
const SCAN_MS = 1900;
const META_LOGIN_MS = 1400;
const META_REGISTER_MS = 1800;

const pad = (n) => String(n).padStart(2, '0');
const fmtCountdown = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

/**
 * openConnectFlow({ instance?, returnFocus?(novoId), onFinish?(id, reconectou) })
 * Com `instance`, reconecta aquela instância; sem, cria uma nova.
 */
export function openConnectFlow({ instance = null, returnFocus, onFinish } = {}) {
  const reconnect = !!instance;
  // Defesa em profundidade: criar exige instance.create; reconectar, instance.connect.
  const need = check('instance', reconnect ? 'connect' : 'create');
  if (!need.ok) {
    toast(need.msg);
    return null;
  }
  const st = {
    step: reconnect ? 'setup' : 'channel',
    channel: instance?.channel ?? null,
    name: instance?.name ?? '',
    owner: instance?.ownerName || store.user()?.name || '',
    phase: null,
    queuePos: QUEUE_START,
    expiresAt: 0,
    qrNonce: 0,
    metaPhone: instance?.phone ?? null,
    resultId: instance?.id ?? null,
    resultPhone: instance?.phone ?? '',
  };

  // ---- timers ----
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  const every = (fn, ms) => timers.add(setInterval(fn, ms));
  const stopTimers = () => {
    // clearTimeout limpa também ids de setInterval (mesmo espaço de ids nos navegadores).
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };

  // Nas fases em que o pareamento já foi confirmado, não há "Cancelar": fechar a
  // janela perderia a conexão sem aviso, então o fechamento é ignorado até concluir.
  const m = openModal({ size: 'lg', returnFocus: () => returnFocus?.(st.resultId), canClose: () => st.phase !== 'scanned' && st.phase !== 'registering', onClose: stopTimers });
  const ch = () => CHANNELS[st.channel] || CHANNELS.baileys;
  const go = (patch) => {
    Object.assign(st, patch);
    render();
  };
  const cancelBtn = (label = 'Cancelar') => h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => m.close() }, label);
  const spinner = () => h('span', { class: 'instances-spinner', 'aria-hidden': 'true' });

  // ------------------------------------------------------------------ passo 1
  function viewChannel() {
    const cards = [];
    const next = h('button', { class: 'btn btn--primary', type: 'button', disabled: !st.channel, onclick: () => go({ step: 'setup' }) }, 'Continuar');
    const sync = () => {
      for (const c of cards) c.el.classList.toggle('is-selected', c.key === st.channel);
      next.disabled = !st.channel;
    };
    const options = Object.entries(CHANNELS).map(([key, c]) => {
      const input = h('input', { type: 'radio', name: 'instances-channel', value: key, class: 'instances-channel__input', checked: st.channel === key, onchange: () => ((st.channel = key), sync()) });
      const el = h(
        'label',
        { class: 'instances-channel' },
        input,
        h('div', { class: 'instances-channel__head' }, h('span', { class: 'instances-channel__icon' }, icon(c.icon, 20)), h('div', null, h('div', { class: 'instances-channel__name' }, c.label), h('div', { class: 'instances-channel__tag' }, c.tag))),
        h('ul', { class: 'instances-list instances-list--pro' }, c.pros.map((t) => h('li', null, icon(ICON.check, 14), h('span', null, t)))),
        h('ul', { class: 'instances-list instances-list--con' }, c.cons.map((t) => h('li', null, h('span', { class: 'instances-list__dash', 'aria-hidden': 'true' }, '–'), h('span', null, t)))),
        c.risk ? h('div', { class: 'instances-risk', role: 'note' }, icon(ICON.warn, 16), h('span', null, c.risk)) : null
      );
      cards.push({ key, el, input });
      return el;
    });
    sync();
    m.setTitle('Conectar novo número', 'Passo 1 de 3 · Canal');
    return {
      body: [h('p', { class: 'muted instances-intro' }, 'Escolha como este número vai falar com o WhatsApp. Dá para ter os dois tipos na mesma conta.'), h('div', { class: 'instances-channels', role: 'radiogroup', 'aria-label': 'Canal de conexão' }, options)],
      foot: [cancelBtn(), next],
      focus: (cards.find((c) => c.key === st.channel) || cards[0]).input,
    };
  }

  // ------------------------------------------------------------------ passo 2
  function viewSetup() {
    const isQr = st.channel === 'baileys';
    m.setTitle(reconnect ? `Reconectar ${instance.name}` : 'Dados da instância', reconnect ? `Reconexão · ${ch().short}` : `Passo 2 de 3 · ${ch().short}`);

    const err = h('div', { class: 'field-error', id: 'instances-name-err', role: 'alert' });
    const input = h('input', { class: 'input', type: 'text', value: st.name, maxlength: String(NAME_MAX), placeholder: 'Ex.: Comercial, Suporte…', autocomplete: 'off', 'aria-describedby': 'instances-name-err' });
    input.addEventListener('input', () => {
      st.name = input.value;
      err.textContent = '';
      input.removeAttribute('aria-invalid');
    });
    const owner = h('select', { class: 'select', onchange: (e) => (st.owner = e.target.value) }, ownerOptions(store.state, st.owner).map((n) => h('option', { value: n, selected: n === st.owner }, n)));

    const submit = () => {
      if (!reconnect) {
        const msg = nameError(st.name, store.state.instances);
        err.textContent = msg;
        input.setAttribute('aria-invalid', String(!!msg));
        if (msg) return input.focus();
        st.name = st.name.trim();
      }
      if (isQr) go({ step: 'connect', phase: 'queued', queuePos: QUEUE_START });
      else go({ step: 'connect', phase: 'meta_loading' });
    };

    let fields;
    if (reconnect) {
      const att = instance.status === 'attention' ? ATTENTION[instance.attentionReason] || ATTENTION.badSession : null;
      fields = [
        h('div', { class: 'instances-note' }, h('strong', null, `${instance.name} · ${instance.phone || ''}`), h('span', null, isQr ? 'Vamos parear de novo lendo um QR Code. O histórico e as conversas continuam salvos.' : 'Vamos refazer o login na Meta Business para reativar o número.')),
        att ? h('div', { class: 'instances-note instances-note--warn', role: 'note' }, h('strong', null, att.title), h('span', null, att.text + (instance.attentionReason === 'forbidden' ? ' Se preferir não arriscar, considere migrar este número para a API oficial.' : ''))) : null,
      ];
    } else {
      fields = [
        h('label', { class: 'field' }, 'Nome da instância', input, err),
        h('label', { class: 'field' }, 'Responsável', owner),
        isQr
          ? h('div', { class: 'instances-note' }, h('span', null, 'Na próxima etapa você lê um QR Code com o celular do número. Em horários de pico, o pareamento entra numa fila — isso é normal.'))
          : h('div', { class: 'instances-note' }, h('span', null, 'Você será levado ao login da Meta Business (Embedded Signup) para autorizar o TechTie Flow e escolher o número. Não guardamos sua senha da Meta.')),
      ];
    }

    const label = isQr ? 'Gerar QR Code' : 'Entrar com Meta Business';
    return {
      body: [h('form', { id: 'instances-setup-form', class: 'instances-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), submit()) }, fields)],
      foot: [
        reconnect ? cancelBtn() : h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => go({ step: 'channel' }) }, 'Voltar'),
        h('button', { class: 'btn btn--primary instances-btn-icon', type: 'submit', form: 'instances-setup-form' }, isQr ? null : icon(ICON.link, 16), label),
      ],
      focus: reconnect ? null : input,
    };
  }

  // ------------------------------------------------------------------ passo 3
  function stepLabel() {
    m.setTitle(reconnect ? `Reconectar ${instance.name}` : isQrChannel() ? 'Conectar ao WhatsApp' : 'Conectar pela Meta', reconnect ? `Reconexão · ${ch().short}` : `Passo 3 de 3 · ${ch().short}`);
  }
  const isQrChannel = () => st.channel === 'baileys';

  function busyView(headline, sub, { footer = [cancelBtn()], note } = {}) {
    return {
      body: [h('div', { class: 'instances-center', role: 'status' }, spinner(), h('div', { class: 'instances-center__title' }, headline), h('p', { class: 'muted instances-center__sub' }, sub), note ? h('div', { class: 'instances-note' }, note) : null)],
      foot: footer,
      focus: null,
    };
  }

  function viewQueued() {
    const pos = h('div', { class: 'instances-queue__pos num' });
    const ahead = h('p', { class: 'muted' });
    const bar = h('i');
    const track = h('div', { class: 'instances-bar', role: 'progressbar', 'aria-label': 'Progresso na fila', 'aria-valuemin': '0', 'aria-valuemax': String(QUEUE_START) }, bar);
    const paint = () => {
      pos.textContent = `Posição ${st.queuePos} na fila`;
      ahead.textContent = st.queuePos <= 1 ? 'Você é o próximo.' : `${st.queuePos - 1} ${st.queuePos - 1 === 1 ? 'pessoa' : 'pessoas'} à sua frente.`;
      track.setAttribute('aria-valuenow', String(QUEUE_START - st.queuePos));
      bar.style.width = `${Math.max(6, ((QUEUE_START - st.queuePos + 0.4) / (QUEUE_START + 0.4)) * 100)}%`;
    };
    paint();
    // Cada tick = alguém à frente conectou. Chegou a vez -> sai da fila.
    every(() => {
      st.queuePos -= 1;
      if (st.queuePos <= 0) go({ phase: 'connecting' });
      else paint();
    }, QUEUE_TICK_MS);
    return {
      body: [
        h('div', { class: 'instances-center', role: 'status' }, spinner(), h('div', { class: 'instances-center__title' }, 'Aguarde, sua vez está chegando'), pos, ahead, track,
          h('div', { class: 'instances-note' }, h('span', null, 'Isto não é um erro. O WhatsApp aguenta poucos pareamentos ao mesmo tempo, então organizamos uma fila para nenhuma conexão ficar presa. Mantenha esta janela aberta.'))),
      ],
      foot: [cancelBtn()],
      focus: null,
    };
  }

  function viewConnecting() {
    later(() => go({ phase: 'qr', expiresAt: Date.now() + QR_TTL_MS, qrNonce: st.qrNonce + 1 }), CONNECTING_MS);
    return busyView('Iniciando a sessão…', 'Preparando o QR Code. Só um instante.');
  }

  function viewQr(expired) {
    const name = reconnect ? instance.name : st.name;
    const left = h('span', { class: 'num' });
    const bar = h('i');
    const paint = () => {
      const rest = Math.max(0, st.expiresAt - Date.now());
      left.textContent = fmtCountdown(rest);
      bar.style.width = `${(rest / QR_TTL_MS) * 100}%`;
      left.classList.toggle('is-low', rest < 10000);
      return rest;
    };
    if (!expired) {
      paint();
      every(() => {
        if (paint() <= 0) go({ phase: 'expired' });
      }, 250);
    }
    const qr = h(
      'div',
      { class: 'instances-qr' + (expired ? ' is-expired' : '') },
      qrSvg(`${name}:${st.qrNonce}`),
      h('span', { class: 'instances-qr__demo' }, 'DEMO'),
      expired ? h('div', { class: 'instances-qr__veil' }, h('strong', null, 'QR expirado'), h('span', null, 'Gere um novo código')) : null
    );
    const steps = h(
      'ol',
      { class: 'instances-steps' },
      h('li', null, 'Abra o WhatsApp no celular do número.'),
      h('li', null, 'Toque em ', h('strong', null, 'Mais opções › Aparelhos conectados'), '.'),
      h('li', null, 'Toque em ', h('strong', null, 'Conectar um aparelho'), ' e aponte a câmera para o código.')
    );
    const renew = () => go({ phase: 'connecting' });
    return {
      body: [
        h('div', { class: 'instances-qrwrap' },
          h('div', { class: 'instances-qrcol' }, qr, h('div', { class: 'instances-qrcap' }, 'QR de demonstração · não é um código real')),
          h('div', { class: 'instances-qrinfo' },
            h('div', { class: 'label' }, name),
            steps,
            expired
              ? h('div', { class: 'instances-note instances-note--warn', role: 'status' }, h('span', null, 'Por segurança o código vale poucos segundos. Gere outro para continuar.'))
              : h('div', { class: 'instances-expiry' }, h('div', { class: 'instances-expiry__row' }, h('span', { class: 'muted' }, 'Expira em'), left), h('div', { class: 'instances-bar' }, bar)),
            h('p', { class: 'muted instances-hint' }, 'Protótipo: como não há celular, use o botão abaixo para simular a leitura.'))),
      ],
      foot: expired
        ? [cancelBtn(), h('button', { class: 'btn btn--primary', type: 'button', onclick: renew }, 'Gerar novo QR')]
        : [cancelBtn(), h('button', { class: 'btn btn--primary', type: 'button', onclick: () => go({ phase: 'scanned' }) }, 'Simular leitura (demo)')],
      focus: null,
    };
  }

  function viewScanned() {
    later(finish, SCAN_MS);
    return busyView('Leitura confirmada', 'Sincronizando as conversas recentes…', {
      footer: [],
      note: 'O histórico completo fica de fora de propósito: pedir tudo de uma vez no primeiro pareamento é um dos gatilhos conhecidos de banimento.',
    });
  }

  function viewMetaLoading() {
    later(() => go(reconnect ? { phase: 'registering' } : { phase: 'meta_pick' }), META_LOGIN_MS);
    return busyView('Abrindo o login da Meta Business…', 'Simulação do Embedded Signup: nenhuma conta real é usada.');
  }

  function viewMetaPick() {
    const used = new Set(store.state.instances.map((i) => i.phone));
    const rows = META_NUMBERS.map((n) => {
      const disabled = used.has(n.phone) || !n.verified;
      return { n, disabled, why: used.has(n.phone) ? 'já conectado' : !n.verified ? 'verificação pendente' : '' };
    });
    if (!st.metaPhone || !rows.some((r) => r.n.phone === st.metaPhone && !r.disabled)) st.metaPhone = rows.find((r) => !r.disabled)?.n.phone ?? null;
    const go2 = h('button', { class: 'btn btn--primary', type: 'button', disabled: !st.metaPhone, onclick: () => go({ phase: 'registering' }) }, 'Conectar número');
    const labels = [];
    const sync = () => {
      for (const l of labels) l.el.classList.toggle('is-selected', l.phone === st.metaPhone);
      go2.disabled = !st.metaPhone;
    };
    const items = rows.map(({ n, disabled, why }) => {
      const input = h('input', { type: 'radio', name: 'instances-meta-number', class: 'instances-channel__input', disabled, checked: st.metaPhone === n.phone, onchange: () => ((st.metaPhone = n.phone), sync()) });
      const el = h('label', { class: 'instances-number' + (disabled ? ' is-disabled' : '') }, input, h('div', null, h('div', { class: 'instances-number__phone num' }, n.phone), h('div', { class: 'muted instances-hint' }, n.label)), why ? h('span', { class: 'chip' }, why) : h('span', { class: 'status status--ok' }, '● Verificado'));
      labels.push({ el, phone: n.phone, input });
      return el;
    });
    sync();
    return {
      body: [
        h('div', { class: 'instances-note' }, h('strong', null, 'Conta Meta Business · Acme Ltda'), h('span', null, 'Login concluído (simulado). Escolha o número que vai atender pelo TechTie Flow.')),
        h('div', { class: 'instances-numbers', role: 'radiogroup', 'aria-label': 'Números da conta Meta' }, items),
      ],
      foot: [cancelBtn(), go2],
      focus: (labels.find((l) => l.phone === st.metaPhone) || labels.find((l) => !l.input.disabled))?.input ?? null,
    };
  }

  function viewRegistering() {
    later(finish, META_REGISTER_MS);
    return busyView('Registrando o número…', 'Configurando webhooks e permissões com a Meta.', { footer: [], note: 'A Meta cobra por mensagem entregue, direto na sua conta. Sem risco de banimento por usar o CRM.' });
  }

  // O motor negou na hora de gravar (perfil mudou durante o pareamento): nada é gravado.
  function denied() {
    toast(check('instance', reconnect ? 'connect' : 'create').msg || 'Ação não permitida.');
    m.close({ force: true });
  }

  // Cria/atualiza a instância assim que conecta (fechar a janela depois não desfaz).
  function finish() {
    if (reconnect) {
      if (!markConnected(instance.id)) return denied();
    } else {
      const inst = addInstance({ name: st.name, channel: st.channel, ownerName: st.owner, phone: st.channel === 'cloud_api' ? st.metaPhone : undefined });
      if (!inst) return denied();
      st.resultId = inst.id;
      st.resultPhone = inst.phone;
    }
    if (reconnect) st.resultPhone = instance.phone;
    if (st.channel === 'cloud_api' && !reconnect) st.resultPhone = st.metaPhone;
    onFinish?.(st.resultId, reconnect);
    go({ phase: 'done' });
  }

  function viewDone() {
    const name = reconnect ? instance.name : st.name;
    return {
      body: [
        h('div', { class: 'instances-center', role: 'status' },
          h('span', { class: 'instances-done' }, icon(ICON.check, 26)),
          h('div', { class: 'instances-center__title' }, reconnect ? 'Reconectada!' : 'Número conectado!'),
          h('p', { class: 'muted instances-center__sub' }, `${name}${st.resultPhone ? ` · ${st.resultPhone}` : ''}`),
          st.channel === 'baileys'
            ? h('div', { class: 'instances-note' }, h('span', null, 'Dica para reduzir o risco de banimento: nos primeiros dias, evite disparos em massa e mensagens idênticas para muitos contatos.'))
            : h('div', { class: 'instances-note' }, h('span', null, 'Pronto para receber mensagens pela API oficial. Acompanhe os custos por mensagem no painel da Meta.'))),
      ],
      foot: [h('button', { class: 'btn btn--primary', type: 'button', onclick: () => (toast(`${name} conectada`), m.close()) }, 'Concluir')],
      focus: 'foot',
    };
  }

  // ---------------------------------------------------------------- roteador
  function build() {
    if (st.step === 'channel') return viewChannel();
    if (st.step === 'setup') return viewSetup();
    stepLabel();
    switch (st.phase) {
      case 'queued': return viewQueued();
      case 'connecting': return viewConnecting();
      case 'qr': return viewQr(false);
      case 'expired': return viewQr(true);
      case 'scanned': return viewScanned();
      case 'meta_loading': return viewMetaLoading();
      case 'meta_pick': return viewMetaPick();
      case 'registering': return viewRegistering();
      case 'done': return viewDone();
      default: return viewChannel();
    }
  }

  function render() {
    stopTimers();
    const view = build();
    replaceChildren(m.body, view.body);
    replaceChildren(m.foot, view.foot);
    m.body.scrollTop = 0;
    if (view.focus === 'foot') m.focus(m.foot.querySelector('button'));
    else m.focus(view.focus);
  }

  render();
  return m;
}
