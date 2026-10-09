// #/onboarding — assistente de 3 passos (Empresa, WhatsApp, Pipeline).
// O estado do assistente vive no fechamento do mount (UI); só vira dado do
// produto (store) quando o usuário avança: tenant no passo 1, instância ao
// sair do passo 2, pipeline ao concluir.
import { h, icon, replaceChildren } from '../ui.js';
import { AUTH_ICONS, authBrand, ensureAuthCss, spinner, themeToggle } from './auth/common.js';
import { createPairing, QR_TTL_S } from './auth/pairing.js';
import { buildQrSvg } from './auth/qr.js';

const STEPS = [
  { n: '01', label: 'EMPRESA' },
  { n: '02', label: 'WHATSAPP' },
  { n: '03', label: 'PIPELINE' },
];
const SEGMENTS = ['Serviços e consultoria', 'Varejo e e-commerce', 'Saúde e clínicas', 'Educação', 'Imobiliário', 'Jurídico e contábil', 'Tecnologia e SaaS', 'Outro'];
const TEAM_SIZES = ['1–5', '6–20', '21–50', '51+'];
const TEMPLATE_DESC = {
  p_sdr: 'Prospecção e qualificação até marcar a reunião.',
  p_comercial: 'Proposta, negociação e fechamento.',
  p_posvenda: 'Onboarding, acompanhamento e renovação.',
};
const FINISH_LATENCY_MS = 700;

const slug = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default {
  mount(el, { store, navigate }) {
    ensureAuthCss();
    const { tenant, pipelines } = store.state;

    // Modelos de pipeline: os 3 do mock + "em branco". Etapas copiadas de
    // store.state.pipelines para a pré-visualização bater com a tela de Negócios.
    const templates = [
      ...pipelines.map((p) => ({ id: p.id, name: p.name, desc: TEMPLATE_DESC[p.id] || `${p.stages.length} etapas`, stages: p.stages, existing: true })),
      {
        id: 'blank',
        name: 'Em branco',
        desc: 'Comece do zero e monte as etapas depois.',
        stages: [
          { id: 'b_novo', name: 'Novo', accent: 'var(--ins)' },
          { id: 'b_ganho', name: 'Ganho', accent: 'var(--green)', kind: 'won' },
          { id: 'b_perdido', name: 'Perdido', accent: 'var(--red)', kind: 'lost' },
        ],
        existing: false,
      },
    ];

    const wizard = {
      step: 0,
      company: tenant.name || '',
      segment: '',
      teamSize: '6–20',
      instanceName: '',
      instanceTouched: false,
      channel: 'baileys', // 'baileys' | 'cloud_api'
      instanceId: null,
      templateId: templates[0].id,
      pipelineName: '',
    };

    let pairing = null; // criado ao entrar no passo 2 pela primeira vez
    let disposeStep = null;
    let finishTimer = null;
    let finishing = false;

    const progressHost = h('ol', { class: 'onboarding-steps', 'aria-label': 'Progresso' });
    const cardHost = h('div', { class: 'onboarding-host' });

    // ---------- navegação ----------
    function go(step) {
      disposeStep?.();
      disposeStep = null;
      wizard.step = step;
      drawProgress();
      const view = [stepCompany, stepWhatsapp, stepPipeline][step]();
      replaceChildren(cardHost, view.el);
      disposeStep = view.dispose || null;
      // Quem usa leitor de tela/teclado cai no título do novo passo.
      cardHost.querySelector('.onboarding-title')?.focus({ preventScroll: true });
    }

    function drawProgress() {
      replaceChildren(
        progressHost,
        ...STEPS.map((s, i) => {
          // A barra só volta: avançar passa pelo "Continuar", que valida o passo atual.
          const btn = h(
            'button',
            {
              class: 'onboarding-steps__btn' + (i <= wizard.step ? ' is-done' : '') + (i === wizard.step ? ' is-current' : ''),
              type: 'button',
              disabled: i >= wizard.step,
              'aria-current': i === wizard.step ? 'step' : null,
              onclick: () => i !== wizard.step && go(i),
            },
            h('span', { class: 'onboarding-steps__bar' }),
            h('span', { class: 'onboarding-steps__label' }, `${s.n} · ${s.label}`)
          );
          return h('li', null, btn);
        })
      );
    }

    // ---------- blocos reutilizáveis ----------
    const heading = (text, lead) => [h('h2', { class: 'onboarding-title', tabindex: '-1' }, text), h('p', { class: 'onboarding-lead' }, lead)];

    function fieldText({ id, label, value, placeholder, onInput, extra }) {
      const err = h('p', { class: 'field-error', id: `${id}-err`, 'aria-live': 'polite' });
      const input = h('input', { class: 'input input--inset', id, type: 'text', value, placeholder, autocomplete: 'off', 'aria-describedby': `${id}-err`, ...extra });
      input.addEventListener('input', () => {
        onInput?.(input.value);
        if (input.hasAttribute('aria-invalid') && input.value.trim().length >= 2) setErr(input, err, '');
      });
      return { input, err, node: h('div', { class: 'field' }, h('label', { for: id }, label), input, err) };
    }
    function setErr(input, errEl, msg) {
      errEl.textContent = msg || '';
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      return !msg;
    }

    /** Linha de botões do rodapé do passo. */
    function navRow({ back, next, skip, hint }) {
      return h(
        'div',
        { class: 'onboarding-nav' },
        hint || null,
        h(
          'div',
          { class: 'onboarding-nav__row' },
          back ? h('button', { class: 'btn btn--quiet onboarding-back', type: 'button', onclick: back }, icon(AUTH_ICONS.back, 14), 'Voltar') : null,
          next,
          skip ? h('button', { class: 'btn onboarding-skip', type: 'button', onclick: skip.onclick }, skip.label) : null
        )
      );
    }

    // ================= PASSO 1 · EMPRESA =================
    function stepCompany() {
      const preview = {
        mark: h('div', { class: 'onboarding-preview__mark' }),
        name: h('div', { class: 'onboarding-preview__name' }),
        domain: h('div', { class: 'onboarding-preview__domain' }),
        chips: h('div', { class: 'onboarding-preview__chips' }),
      };
      const paintPreview = () => {
        const name = wizard.company.trim() || 'Sua empresa';
        preview.mark.textContent = name[0].toUpperCase();
        preview.name.textContent = name;
        preview.domain.textContent = `crm.${slug(name) || 'suaempresa'}.com.br`;
        replaceChildren(preview.chips, wizard.segment ? h('span', { class: 'chip' }, wizard.segment) : null, h('span', { class: 'chip' }, `Equipe ${wizard.teamSize}`));
      };

      const company = fieldText({ id: 'onb-company', label: 'Nome da empresa', value: wizard.company, placeholder: 'Ex.: Acme Ltda', extra: { name: 'company', autocomplete: 'organization' }, onInput: (v) => { wizard.company = v; paintPreview(); } });

      const segErr = h('p', { class: 'field-error', id: 'onb-segment-err', 'aria-live': 'polite' });
      const segSelect = h(
        'select',
        { class: 'select input--inset', id: 'onb-segment', name: 'segment', 'aria-describedby': 'onb-segment-err' },
        h('option', { value: '' }, 'Selecione o segmento'),
        SEGMENTS.map((s) => h('option', { value: s, selected: s === wizard.segment }, s))
      );
      segSelect.addEventListener('change', () => {
        wizard.segment = segSelect.value;
        if (wizard.segment) setErr(segSelect, segErr, '');
        paintPreview();
      });

      const sizeGroup = h(
        'div',
        { class: 'onboarding-seg', role: 'radiogroup', 'aria-labelledby': 'onb-size-label' },
        TEAM_SIZES.map((size) => {
          const input = h('input', { class: 'auth-sr', type: 'radio', name: 'teamSize', value: size, checked: size === wizard.teamSize });
          input.addEventListener('change', () => {
            wizard.teamSize = size;
            paintPreview();
          });
          return h('label', { class: 'onboarding-seg__opt' }, input, h('span', null, size));
        })
      );

      const form = h(
        'form',
        { class: 'onboarding-form auth-form', novalidate: true },
        ...heading('SOBRE A SUA EMPRESA', 'Usamos estes dados para montar o seu workspace. Você pode mudar tudo depois em Configurações.'),
        company.node,
        h('div', { class: 'field' }, h('label', { for: 'onb-segment' }, 'Segmento'), segSelect, segErr),
        h('div', { class: 'field' }, h('span', { id: 'onb-size-label' }, 'Tamanho da equipe (pessoas)'), sizeGroup),
        navRow({ next: h('button', { class: 'btn btn--primary', type: 'submit' }, 'Continuar') })
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = wizard.company.trim();
        const okName = setErr(company.input, company.err, name.length >= 2 ? '' : 'Informe o nome da empresa (mínimo de 2 caracteres).');
        const okSeg = setErr(segSelect, segErr, wizard.segment ? '' : 'Escolha o segmento mais próximo.');
        if (!okName || !okSeg) return (okName ? segSelect : company.input).focus();
        store.update((s) => {
          s.tenant.name = name;
          s.tenant.segment = wizard.segment;
          s.tenant.teamSize = wizard.teamSize;
        });
        go(1);
      });

      paintPreview();
      const aside = h('aside', { class: 'onboarding-preview', 'aria-label': 'Prévia do workspace' }, h('span', { class: 'label' }, 'Prévia do workspace'), preview.mark, preview.name, preview.domain, preview.chips, h('div', { class: 'onboarding-preview__role' }, `Admin · ${store.user()?.name || 'você'}`));
      return { el: h('div', { class: 'onboarding-card' }, form, aside) };
    }

    // ================= PASSO 2 · WHATSAPP =================
    // Garante que o pareamento esteja rodando ao ENTRAR no passo: sair no meio
    // (leave) cancela a tentativa, então quem volta do passo 3 recomeça pela fila
    // em vez de cair num painel parado sem ação.
    function ensurePairing() {
      pairing ??= createPairing();
      if (wizard.channel === 'baileys' && pairing.snapshot().phase === 'idle') pairing.start();
    }

    function stepWhatsapp() {
      ensurePairing();
      if (!wizard.instanceTouched) wizard.instanceName = `Comercial · ${(wizard.company.trim() || tenant.name).split(/\s+/)[0]}`;

      const name = fieldText({
        id: 'onb-instance',
        label: 'Nome da instância',
        value: wizard.instanceName,
        placeholder: 'Ex.: Comercial · Acme',
        extra: { name: 'instance' },
        onInput: (v) => {
          wizard.instanceName = v;
          wizard.instanceTouched = true;
          paint(pairing.snapshot());
        },
      });
      const riskHost = h('div');
      const panel = pairPanel();
      const nextBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Continuar');
      const hintEl = h('p', { class: 'onboarding-nav__hint', role: 'status' });
      const leadEl = h('p', { class: 'onboarding-lead' });
      // O rodapé é montado UMA vez: o pareamento emite a cada segundo e recriar os
      // botões derrubaria o foco de quem navega por teclado.
      const navEl = navRow({ back: () => go(0), next: nextBtn, skip: { label: 'Pular por enquanto', onclick: () => leave(true) }, hint: hintEl });
      let riskKey = null;

      function drawRisk(snap) {
        const key = `${wizard.channel}:${snap.phase === 'connected'}`;
        if (key === riskKey) return;
        riskKey = key;
        if (wizard.channel === 'cloud_api') {
          replaceChildren(
            riskHost,
            h(
              'div',
              { class: 'onboarding-note onboarding-note--info' },
              h('p', null, h('strong', null, 'API oficial (WhatsApp Cloud API). '), 'Sem QR Code e sem risco de banimento. Em troca, há custo por conversa e o cadastro é feito pela Meta (Embedded Signup). Finalizamos isso depois, em Instâncias.'),
              h('button', { class: 'auth-link', type: 'button', onclick: () => chooseChannel('baileys') }, 'Conectar por QR Code mesmo assim')
            )
          );
          return;
        }
        replaceChildren(
          riskHost,
          h(
            'div',
            { class: 'onboarding-note' },
            icon(AUTH_ICONS.alert, 18),
            h(
              'div',
              null,
              h('p', null, h('strong', null, 'Conexão não oficial. '), 'O WhatsApp pode restringir ou banir um número conectado por QR Code, a qualquer momento — e o número e a conta são seus. Para reduzir o risco, importamos só as conversas recentes, nunca o histórico completo.'),
              snap.phase === 'connected' ? null : h('button', { class: 'auth-link', type: 'button', onclick: () => chooseChannel('cloud_api') }, 'Prefiro a API oficial')
            )
          )
        );
      }

      function chooseChannel(channel) {
        wizard.channel = channel;
        if (channel === 'cloud_api') pairing.cancel();
        else pairing.start();
        paint(pairing.snapshot());
      }

      function paint(snap) {
        const ready = wizard.channel === 'cloud_api' || snap.phase === 'connected';
        nextBtn.disabled = !ready;
        leadEl.textContent =
          wizard.channel === 'cloud_api'
            ? 'Vamos criar a instância agora e você finaliza o cadastro na Meta depois, em Instâncias.'
            : snap.phase === 'connected'
              ? 'Número pareado. Confira o nome da instância e continue.'
              : 'No celular: WhatsApp → Aparelhos conectados → Conectar aparelho. Aponte a câmera para o código ao lado.';
        drawRisk(snap);
        panel.update(snap);
        hintEl.textContent = ready ? '' : 'Conecte o número para continuar, ou pule e conecte depois em Instâncias.';
      }

      /** Cria (ou atualiza, se o usuário voltou) a instância no store e segue. */
      function leave(skipped) {
        const finalName = wizard.instanceName.trim();
        if (!skipped && finalName.length < 2) {
          setErr(name.input, name.err, 'Dê um nome à instância (mínimo de 2 caracteres).');
          return name.input.focus();
        }
        const snap = pairing.snapshot();
        const connected = wizard.channel === 'baileys' && snap.phase === 'connected';
        // Pular no meio do pareamento descarta a tentativa: o QR só vale dentro do assistente.
        if (!connected) pairing.cancel();
        const data = {
          name: finalName || 'Comercial',
          phone: connected ? snap.phone : '—',
          channel: wizard.channel,
          status: connected ? 'connected' : 'disconnected',
        };
        store.update((s) => {
          const existing = wizard.instanceId && s.instances.find((i) => i.id === wizard.instanceId);
          if (existing) Object.assign(existing, data);
          else {
            wizard.instanceId = `i_onb_${Date.now().toString(36)}`;
            s.instances.push({ id: wizard.instanceId, ownerName: store.user()?.name || '', conversations: 0, messagesToday: 0, aiActive: false, ...data });
          }
        });
        go(2);
      }

      const form = h(
        'form',
        { class: 'onboarding-form auth-form', novalidate: true },
        h('h2', { class: 'onboarding-title', tabindex: '-1' }, 'CONECTE SEU WHATSAPP'),
        leadEl,
        name.node,
        riskHost,
        navEl
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!nextBtn.disabled) leave(false);
      });

      const unsub = pairing.subscribe(paint);
      paint(pairing.snapshot());
      return { el: h('div', { class: 'onboarding-card onboarding-card--center' }, form, panel.el), dispose: unsub };
    }

    /** Coluna direita do passo 2: QR e todos os estados do pareamento. */
    function pairPanel() {
      const status = h('p', { class: 'onboarding-pair__status', role: 'status' });
      const stage = h('div', { class: 'onboarding-pair__stage' });
      const el = h('div', { class: 'onboarding-pair' }, stage, status);
      let key = null;
      let refs = {};
      const qrCache = new Map(); // um <svg> por seed: o contador não redesenha o QR a cada segundo

      const statusBox = (...children) => h('div', { class: 'onboarding-qr onboarding-qr--status' }, ...children);

      function qrBox(snap, expired) {
        if (!qrCache.has(snap.seed)) qrCache.set(snap.seed, buildQrSvg(snap.seed));
        const svg = qrCache.get(snap.seed);
        svg.classList.toggle('is-dim', expired);
        return h(
          'div',
          { class: 'onboarding-qr onboarding-qr--code' },
          svg,
          expired
            ? h('div', { class: 'onboarding-qr__expired' }, h('strong', null, 'QR expirado'), h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => pairing.regenerate() }, icon(AUTH_ICONS.refresh, 14), 'Gerar novo QR'))
            : null
        );
      }

      function build(snap) {
        refs = {};
        const phase = wizard.channel === 'cloud_api' ? 'cloud' : snap.phase;
        let text = '';
        let nodes;
        switch (phase) {
          case 'cloud':
            text = 'API oficial selecionada.';
            nodes = [statusBox(icon(AUTH_ICONS.shield, 30), h('strong', null, 'API oficial'), h('p', null, 'A instância será criada como pendente de cadastro na Meta.'))];
            break;
          case 'queued':
            text = 'Na fila de pareamento. Aguarde, sua vez está chegando.';
            refs.pos = h('strong', { class: 'onboarding-queue__pos num' });
            refs.bar = h('i');
            nodes = [
              statusBox(
                h('span', { class: 'label' }, 'Fila de pareamento'),
                refs.pos,
                h('p', null, 'Sua vez está chegando. Limitamos pareamentos simultâneos para que nenhum fique pela metade.'),
                h('div', { class: 'onboarding-bar', 'aria-hidden': 'true' }, refs.bar)
              ),
            ];
            break;
          case 'connecting':
            text = 'Preparando o QR Code…';
            nodes = [statusBox(h('span', { class: 'auth-spinner auth-spinner--lg' }), h('strong', null, 'Conectando'), h('p', null, 'Abrindo a sessão com o WhatsApp…'))];
            break;
          case 'qr':
          case 'expired': {
            const expired = phase === 'expired';
            text = expired ? 'O QR Code expirou. Gere um novo para continuar.' : 'Escaneie o QR Code com o WhatsApp do celular.';
            refs.count = h('span', { class: 'onboarding-pair__count num' });
            refs.bar = h('i');
            nodes = [
              qrBox(snap, expired),
              h('div', { class: 'onboarding-pair__meta' }, h('span', { class: 'chip', title: 'Código ilustrativo: não pareia de verdade' }, 'DEMO'), expired ? h('span', { class: 'onboarding-pair__count' }, 'Expirado') : refs.count),
              expired ? null : h('div', { class: 'onboarding-bar', 'aria-hidden': 'true' }, refs.bar),
              expired
                ? null
                : h(
                    'div',
                    { class: 'onboarding-pair__actions' },
                    h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => pairing.regenerate() }, 'Gerar novo QR'),
                    h('button', { class: 'btn btn--quiet btn--sm', type: 'button', title: 'Só no protótipo: finge a leitura do QR no celular', onclick: () => pairing.simulateScan() }, 'Simular leitura')
                  ),
            ];
            break;
          }
          case 'syncing':
            text = 'Número pareado. Importando conversas recentes…';
            nodes = [statusBox(h('span', { class: 'auth-spinner auth-spinner--lg' }), h('strong', null, 'Sincronizando'), h('p', null, 'Trazendo só as conversas recentes, não o histórico completo.'))];
            break;
          case 'connected':
            text = 'WhatsApp conectado.';
            nodes = [statusBox(h('span', { class: 'onboarding-ok' }, icon(AUTH_ICONS.check, 26)), h('strong', null, 'Conectado'), h('p', { class: 'num' }, snap.phone), h('small', null, wizard.instanceName.trim() || 'Instância sem nome'))];
            break;
          default:
            text = '';
            nodes = [statusBox(icon(AUTH_ICONS.phone, 30), h('p', null, 'Pareamento não iniciado.'))];
        }
        replaceChildren(stage, ...nodes);
        status.textContent = text;
      }

      function update(snap) {
        const k = wizard.channel === 'cloud_api' ? 'cloud' : `${snap.phase}:${snap.seed}`;
        if (k !== key) {
          key = k;
          build(snap);
        }
        if (refs.pos) {
          refs.pos.textContent = `${snap.position}º na fila`;
          refs.bar.style.width = `${Math.round(((snap.queueTotal - snap.position + 1) / (snap.queueTotal + 1)) * 100)}%`;
        }
        if (refs.count && snap.phase === 'qr') {
          refs.count.textContent = `Expira em ${fmtClock(snap.remaining)}`;
          refs.bar.style.width = `${Math.round((snap.remaining / QR_TTL_S) * 100)}%`;
        }
        // O nome da instância aparece no cartão "Conectado": acompanha a digitação.
        if (snap.phase === 'connected' && wizard.channel === 'baileys') {
          const small = stage.querySelector('small');
          if (small) small.textContent = wizard.instanceName.trim() || 'Instância sem nome';
        }
      }
      return { el, update };
    }

    // ================= PASSO 3 · PIPELINE =================
    function stepPipeline() {
      const stagesHost = h('div', { class: 'onboarding-stages' });
      const nameHost = h('div');
      const nameField = fieldText({ id: 'onb-pipeline', label: 'Nome do pipeline', value: wizard.pipelineName, placeholder: 'Ex.: Meu funil', extra: { name: 'pipelineName' }, onInput: (v) => (wizard.pipelineName = v) });
      const current = () => templates.find((t) => t.id === wizard.templateId) || templates[0];

      function paintStages() {
        const t = current();
        const team = t.existing ? store.state.teams.find((x) => x.pipelineId === t.id) : null;
        replaceChildren(
          stagesHost,
          h('span', { class: 'label' }, `Etapas · ${t.stages.length}`),
          h(
            'ol',
            { class: 'onboarding-stages__list' },
            t.stages.map((st) =>
              h('li', { class: 'onboarding-stage', style: { borderLeftColor: st.accent } }, h('span', null, st.name), st.kind ? h('span', { class: 'chip' }, st.kind === 'won' ? 'ganho' : 'perdido') : null)
            )
          ),
          h('p', { class: 'onboarding-stages__foot' }, team ? `Usado por ${team.name}.` : t.existing ? '' : 'Você ajusta as etapas depois, na tela de Negócios.')
        );
        replaceChildren(nameHost, t.existing ? null : nameField.node);
      }

      const options = h(
        'div',
        { class: 'onboarding-opts', role: 'radiogroup', 'aria-label': 'Modelo de pipeline' },
        templates.map((t) => {
          const input = h('input', { class: 'auth-sr', type: 'radio', name: 'template', value: t.id, checked: t.id === wizard.templateId });
          input.addEventListener('change', () => {
            wizard.templateId = t.id;
            paintStages();
          });
          return h('label', { class: 'onboarding-opt' }, input, h('span', { class: 'onboarding-opt__dot', 'aria-hidden': 'true' }), h('span', { class: 'onboarding-opt__text' }, h('strong', null, t.name), h('small', null, t.desc)), h('span', { class: 'onboarding-opt__count' }, `${t.stages.length} etapas`));
        })
      );

      const finishBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Concluir');
      const skipBtn = h('button', { class: 'btn onboarding-skip', type: 'button', onclick: () => finish(false) }, 'Pular por enquanto');
      const backBtn = h('button', { class: 'btn btn--quiet onboarding-back', type: 'button', onclick: () => go(1) }, icon(AUTH_ICONS.back, 14), 'Voltar');

      /** Marca a sessão como logada e entra no Inbox; cria o pipeline se foi escolhido. */
      function finish(createPipeline) {
        if (finishing) return;
        const t = current();
        if (createPipeline && !t.existing && wizard.pipelineName.trim().length < 2) {
          setErr(nameField.input, nameField.err, 'Dê um nome ao pipeline (mínimo de 2 caracteres).');
          return nameField.input.focus();
        }
        finishing = true;
        [finishBtn, skipBtn, backBtn].forEach((b) => (b.disabled = true));
        finishBtn.replaceChildren(spinner(), h('span', null, 'Criando workspace…'));
        finishBtn.setAttribute('aria-busy', 'true');
        finishTimer = setTimeout(() => {
          store.update((s) => {
            if (createPipeline) {
              // Os 3 modelos já existem no mock: só marcamos o padrão em vez de duplicar.
              let id = t.id;
              if (!t.existing) {
                id = `p_${slug(wizard.pipelineName) || 'novo'}_${Date.now().toString(36)}`;
                s.pipelines.push({ id, name: wizard.pipelineName.trim(), teamId: store.user()?.teamIds?.[0] ?? null, stages: t.stages.map((st) => ({ ...st, id: `${id}_${st.id}` })) });
              }
              s.tenant.defaultPipelineId = id;
              // A tela de Negócios abre no pipeline da equipe do usuário (não lê
              // defaultPipelineId): apontamos a equipe para o escolhido para a escolha ter efeito.
              const team = s.teams.find((x) => x.id === store.user()?.teamIds?.[0]);
              if (team) team.pipelineId = id;
            }
            s.tenant.onboarded = true;
            s.session.loggedIn = true;
          });
          navigate('inbox');
        }, FINISH_LATENCY_MS);
      }

      const form = h(
        'form',
        { class: 'onboarding-form auth-form', novalidate: true },
        ...heading('ESCOLHA SEU PIPELINE', 'Comece por um modelo pronto — as etapas podem ser editadas depois.'),
        options,
        nameHost,
        h('div', { class: 'onboarding-nav' }, h('div', { class: 'onboarding-nav__row' }, backBtn, finishBtn, skipBtn))
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        finish(true);
      });

      paintStages();
      return { el: h('div', { class: 'onboarding-card' }, form, h('aside', { class: 'onboarding-preview onboarding-preview--stages', 'aria-label': 'Pré-visualização das etapas' }, stagesHost)) };
    }

    // ---------- montagem ----------
    el.append(
      h(
        'div',
        { class: 'onboarding' },
        h(
          'div',
          { class: 'onboarding__inner' },
          h('header', { class: 'onboarding-top' }, authBrand(), h('div', { class: 'onboarding-top__right' }, h('a', { class: 'auth-link', href: '#/login' }, 'Já tenho conta'), themeToggle())),
          progressHost,
          cardHost
        )
      )
    );
    go(0);

    return () => {
      disposeStep?.();
      pairing?.destroy();
      clearTimeout(finishTimer);
    };
  },
};
