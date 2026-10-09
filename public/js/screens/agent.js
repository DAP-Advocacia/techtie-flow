// Tela "Agente de IA" (#/agent): liga/desliga o agente por instância, edita
// personalidade, base de conhecimento e regras de transbordo, e oferece um
// chat de teste com respostas simuladas.
//
// Re-render: cada região (base, regras, chat) é redesenhada separadamente
// para o textarea e os inputs não perderem foco quando o store muda.
import { h, icon, replaceChildren, toggle, toast } from '../ui.js';
import { store } from '../store.js';
import { simulateReply } from './agent/reply.js';
import { audit } from '../access.js';
import { check, blocked, createHints, banner } from './_ops/perm.js';

const MAX_PROMPT = 2000;
const MAX_RULE = 140;
const ACCEPT = '.pdf,.docx,.xlsx,.txt';
const ALLOWED_EXT = /\.(pdf|docx|xlsx|txt)$/i;
const PROCESS_MS = 2500;
const TYPING_MS = 900;

const ICON_SEND = 'M22 2L11 13M22 2l-7 20-4-9-9-4z';
const ICON_TRASH = 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6';
const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_UPLOAD = 'M12 16V4M7 9l5-5 5 5M4 20h16';

// Rascunho do prompt sobrevive a trocar de tela e voltar (o salvo vive no store).
// Pertence a UM usuário: ao trocar de usuário ("ver como") é descartado, senão o
// texto digitado por um vazaria para outro.
let promptDraft = null; // { userId, text } | null

export default {
  mount(el, ctx) {
    const { store: st } = ctx;
    const timers = new Set();
    const later = (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return id;
    };

    // Completa o que o modelo de dados possa não trazer, sem quebrar com vazio.
    st.update((s) => {
      s.agent ||= {};
      const a = s.agent;
      a.prompt ??= '';
      a.enabled ??= true;
      a.knowledgeDocs ||= [];
      a.handoffRules ||= [];
      a.testChat ||= [];
      // Instância apagada (ou nunca existiu) não pode ficar como vínculo fantasma.
      if (!s.instances.some((i) => i.id === a.instanceId)) a.instanceId = s.instances[0]?.id ?? null;
    });
    const A = () => st.state.agent;
    // Permissão (motor): editar o agente exige ai_agent.update; ver, ai_agent.read (a rota já cobra).
    // O chat de teste é leitura segura: segue liberado para quem lê.
    const hints = createHints();
    const rw = () => check('ai_agent', 'update');
    const bannerEl = banner(false);
    const meId = st.state.currentUserId;
    if (promptDraft && promptDraft.userId !== meId) promptDraft = null; // estado de módulo reiniciado no mount
    // "Ativo" segue a instância vinculada (fonte que a tela de Instâncias também
    // altera); sem instância vinculada não há onde o agente atuar.
    const isActive = () => {
      const inst = st.instance(A().instanceId);
      return inst ? !!inst.aiActive : false;
    };

    // Redesenhar região a região apagaria o foco do teclado; guarda pelo
    // aria-label do controle que estava focado e devolve o foco depois.
    function keepFocus(container, fn) {
      const active = document.activeElement;
      const label = container.contains(active) ? active.getAttribute('aria-label') : null;
      fn();
      if (!label) return;
      const next = [...container.querySelectorAll('[aria-label]')].find((n) => n.getAttribute('aria-label') === label);
      next?.focus();
    }

    let typing = false;
    let saving = false;
    let confirmDocId = null;
    let confirmTimer = null;

    // ---------------- cabeçalho ----------------
    const statusEl = h('span', { class: 'agent-pill__status' });
    const warnEl = h('span', { class: 'agent-pill__warn' });
    const mainToggle = toggle(isActive(), (v) => {
      if (blocked(rw())) {
        syncHeader(); // desfaz a troca visual do switch
        return;
      }
      st.update((s) => {
        s.agent.enabled = v;
        // Mantém a lista de Instâncias coerente com o agente vinculado.
        const inst = s.instances.find((i) => i.id === s.agent.instanceId);
        if (inst) inst.aiActive = v;
      });
      audit('ai_agent.update', A().instanceId, v ? 'Agente de IA ativado' : 'Agente de IA desativado');
      toast(v ? 'Agente ativado' : 'Agente desativado');
    }, 'Ativar agente de IA');
    const instanceSelect = h(
      'select',
      {
        class: 'select agent-instance',
        'aria-label': 'Instância vinculada ao agente',
        onchange: (e) => {
          if (blocked(rw())) {
            syncHeader();
            return;
          }
          const was = isActive();
          st.update((s) => {
            const prev = s.instances.find((i) => i.id === s.agent.instanceId);
            if (prev) prev.aiActive = false;
            s.agent.instanceId = e.target.value;
            s.agent.enabled = was;
            const next = s.instances.find((i) => i.id === e.target.value);
            if (next) next.aiActive = was;
          });
          audit('ai_agent.update', e.target.value, `Agente de IA vinculado à instância ${st.instance(e.target.value)?.name ?? e.target.value}`);
        },
      },
      st.state.instances.map((i) => h('option', { value: i.id }, i.name))
    );
    instanceSelect.disabled = st.state.instances.length === 0;

    function syncHeader() {
      const a = A();
      const inst = st.instance(a.instanceId);
      const on = isActive();
      mainToggle.setAttribute('aria-checked', String(on));
      instanceSelect.value = a.instanceId ?? '';
      const c = rw();
      hints.lock(mainToggle, c, { other: !inst });
      hints.lock(instanceSelect, c, { other: st.state.instances.length === 0 });
      hints.lock(textarea, c, { readOnly: true });
      hints.lock(uploadBtn, c);
      hints.lock(ruleInput, c, { readOnly: true });
      hints.lock(addRuleBtn, c);
      bannerEl.hidden = c.ok;
      statusEl.textContent = !inst ? '● Nenhuma instância conectada' : on ? `● Ativo na instância ${inst.name}` : '● Desativado';
      statusEl.classList.toggle('is-off', !on);
      warnEl.textContent = on && inst && inst.status !== 'connected' ? 'Instância desconectada' : '';
    }

    const header = h(
      'header',
      { class: 'page-header' },
      h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'Automação'), h('h1', { class: 'page-title' }, 'Agente de IA')),
      h(
        'label',
        { class: 'agent-instance-field' },
        h('span', { class: 'label' }, 'Instância'),
        instanceSelect
      ),
      h('div', { class: 'agent-pill' }, h('span', { class: 'agent-pill__text' }, statusEl, warnEl), mainToggle)
    );

    // ---------------- personalidade e regras ----------------
    const textarea = h('textarea', {
      class: 'textarea textarea--inset agent-prompt',
      rows: 6,
      maxlength: MAX_PROMPT,
      'aria-label': 'Personalidade e regras do agente',
      'aria-describedby': 'agent-prompt-meta',
      oninput: () => {
        if (!rw().ok) {
          textarea.value = A().prompt; // digitação programática não vira rascunho
          return;
        }
        promptDraft = { userId: meId, text: textarea.value };
        syncPrompt();
      },
    });
    textarea.value = rw().ok && promptDraft?.userId === meId ? promptDraft.text : A().prompt;
    const counter = h('span', { class: 'agent-count num' });
    const dirtyEl = h('span', { class: 'agent-dirty', role: 'status' });
    const promptError = h('div', { class: 'field-error', role: 'alert' });
    const saveBtn = h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: savePrompt }, 'Salvar');
    const discardBtn = h(
      'button',
      {
        class: 'btn btn--quiet btn--sm',
        type: 'button',
        onclick: () => {
          promptDraft = null;
          textarea.value = A().prompt;
          syncPrompt();
        },
      },
      'Descartar'
    );

    const isDirty = () => textarea.value !== A().prompt;
    function syncPrompt() {
      const len = textarea.value.length;
      const empty = textarea.value.trim() === '';
      const dirty = isDirty();
      counter.textContent = `${len} / ${MAX_PROMPT}`;
      dirtyEl.textContent = dirty ? '● alterações não salvas' : '';
      promptError.textContent = empty ? 'Escreva ao menos uma instrução para o agente.' : '';
      textarea.setAttribute('aria-invalid', String(empty));
      hints.lock(saveBtn, rw(), { other: !dirty || empty || saving });
      saveBtn.textContent = saving ? 'Salvando…' : 'Salvar';
      discardBtn.hidden = !dirty;
    }
    function savePrompt() {
      if (blocked(rw()) || saveBtn.disabled) return;
      saving = true;
      syncPrompt();
      // Latência simulada de gravação.
      later(() => {
        commitPrompt();
        toast('Salvo');
      }, 450);
    }
    function commitPrompt() {
      saving = false;
      const value = textarea.value.trim();
      // Perdeu a permissão durante a latência simulada: não grava, volta ao salvo.
      if (!rw().ok) {
        textarea.value = A().prompt;
        promptDraft = null;
        syncPrompt();
        return;
      }
      st.update((s) => {
        s.agent.prompt = value;
      });
      audit('ai_agent.update', A().instanceId, 'Personalidade e regras do agente atualizadas');
      textarea.value = value;
      promptDraft = null;
      syncPrompt();
    }

    const promptCard = h(
      'section',
      { class: 'card', 'aria-labelledby': 'agent-h-prompt' },
      h('span', { class: 'label', id: 'agent-h-prompt' }, 'Personalidade e regras'),
      textarea,
      promptError,
      h(
        'div',
        { class: 'agent-prompt-bar', id: 'agent-prompt-meta' },
        counter,
        dirtyEl,
        h('span', { class: 'agent-grow' }),
        discardBtn,
        saveBtn
      )
    );

    // ---------------- base de conhecimento ----------------
    const fileInput = h('input', {
      type: 'file',
      accept: ACCEPT,
      multiple: true,
      hidden: true,
      'aria-label': 'Selecionar documentos',
      onchange: () => {
        addFiles([...fileInput.files]);
        fileInput.value = '';
      },
    });
    const kbList = h('div', { class: 'agent-docs' });

    function addFiles(files) {
      if (blocked(rw())) return;
      for (const f of files) {
        if (!ALLOWED_EXT.test(f.name)) {
          toast(`Formato não suportado: ${f.name}. Use PDF, DOCX, XLSX ou TXT.`);
          continue;
        }
        if (A().knowledgeDocs.some((d) => d.name.toLowerCase() === f.name.toLowerCase())) {
          toast(`"${f.name}" já está na base.`);
          continue;
        }
        const id = `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        // Nº de trechos simulado a partir do tamanho do arquivo.
        const chunks = Math.min(120, Math.max(4, Math.round(f.size / 1800)));
        st.update((s) => {
          s.agent.knowledgeDocs.push({ id, name: f.name, chunks: null, status: 'processing', pendingChunks: chunks, readyAt: Date.now() + PROCESS_MS });
        });
        audit('ai_agent.update', id, `Documento "${f.name}" enviado à base de conhecimento`);
        scheduleReady(id);
      }
    }
    function finishDoc(id) {
      st.update((s) => {
        const d = s.agent.knowledgeDocs.find((x) => x.id === id);
        if (!d || d.status !== 'processing') return;
        d.status = 'ready';
        d.chunks = d.pendingChunks;
        delete d.pendingChunks;
        delete d.readyAt;
      });
    }
    function scheduleReady(id) {
      const d = A().knowledgeDocs.find((x) => x.id === id);
      if (!d?.readyAt) return;
      later(() => finishDoc(id), Math.max(0, d.readyAt - Date.now()));
    }
    // Uploads feitos antes de sair da tela e ainda em processamento retomam aqui.
    A().knowledgeDocs.filter((d) => d.status === 'processing' && d.readyAt).forEach((d) => scheduleReady(d.id));

    function removeDoc(id) {
      if (blocked(rw())) return;
      const d = A().knowledgeDocs.find((x) => x.id === id);
      st.update((s) => {
        s.agent.knowledgeDocs = s.agent.knowledgeDocs.filter((x) => x.id !== id);
      });
      if (d) audit('ai_agent.update', id, `Documento "${d.name}" removido da base de conhecimento`);
      confirmDocId = null;
      renderKb();
      if (d) toast(`"${d.name}" removido da base`);
    }
    function askRemove(id) {
      if (blocked(rw())) return;
      clearTimeout(confirmTimer);
      confirmDocId = id;
      renderKb();
      // O botão clicado foi trocado por "Confirmar": leva o foco junto.
      kbList.querySelector('.agent-doc__confirm')?.focus();
      // Confirmação some sozinha se o usuário desistir.
      confirmTimer = setTimeout(() => {
        confirmDocId = null;
        renderKb();
      }, 3500);
    }

    // Assinaturas evitam redesenhar (e perder foco/rolagem) por mudanças alheias.
    let kbSig = null;
    function renderKb() {
      const docs = A().knowledgeDocs;
      const canEdit = rw();
      const sig = JSON.stringify([docs, confirmDocId, canEdit.ok]);
      if (sig === kbSig) return;
      kbSig = sig;
      keepFocus(kbList, () => replaceChildren(
        kbList,
        docs.length === 0
          ? h('div', { class: 'empty agent-empty' }, 'Nenhum documento ainda. Envie PDF, DOCX, XLSX ou TXT para o agente consultar.')
          : docs.map((d) => {
              const ready = d.status === 'ready';
              const confirming = confirmDocId === d.id;
              return h(
                'div',
                { class: 'agent-doc' },
                h('span', { class: 'agent-doc__name truncate', title: d.name }, d.name),
                h('span', { class: 'agent-doc__meta' }, ready && d.chunks != null ? `${d.chunks} trechos` : '—'),
                h('span', { class: 'status ' + (ready ? 'status--ok' : 'status--warn') }, ready ? '● Pronto' : '● Processando'),
                confirming
                  ? h('button', { class: 'agent-doc__confirm', type: 'button', 'aria-label': `Confirmar remoção de ${d.name}`, onclick: () => removeDoc(d.id) }, 'Confirmar')
                  : hints.lock(h('button', { class: 'agent-icon-btn', type: 'button', 'aria-label': `Remover ${d.name}`, title: 'Remover', onclick: () => askRemove(d.id) }, icon(ICON_TRASH, 15)), canEdit)
              );
            })
      ));
    }

    const uploadBtn = h('button', { class: 'btn btn--ghost btn--sm agent-upload', type: 'button', onclick: () => !blocked(rw()) && fileInput.click() }, icon(ICON_UPLOAD, 14), 'Enviar documento');
    const kbCard = h(
      'section',
      { class: 'card', 'aria-labelledby': 'agent-h-kb' },
      h(
        'div',
        { class: 'agent-card-head' },
        h('span', { class: 'label', id: 'agent-h-kb' }, 'Base de conhecimento'),
        uploadBtn
      ),
      kbList,
      fileInput
    );

    // ---------------- transbordo ----------------
    const rulesList = h('div', { class: 'agent-rules' });
    const ruleInput = h('input', {
      class: 'input input--inset',
      type: 'text',
      maxlength: MAX_RULE,
      placeholder: 'Nova regra, ex.: Lead reclama do atendimento',
      'aria-label': 'Nova regra de transbordo',
      oninput: () => (ruleError.textContent = ''),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addRule();
        }
      },
    });
    const ruleError = h('div', { class: 'field-error', role: 'alert' });

    function addRule() {
      if (blocked(rw())) return;
      const text = ruleInput.value.trim();
      if (!text) {
        ruleError.textContent = 'Escreva a regra antes de adicionar.';
        ruleInput.focus();
        return;
      }
      if (A().handoffRules.some((r) => r.toLowerCase() === text.toLowerCase())) {
        ruleError.textContent = 'Essa regra já existe.';
        return;
      }
      st.update((s) => s.agent.handoffRules.push(text));
      audit('ai_agent.update', A().instanceId, `Regra de transbordo adicionada: ${text}`);
      ruleInput.value = '';
      renderRules();
      ruleInput.focus();
    }
    function removeRule(i) {
      if (blocked(rw())) return;
      const old = A().handoffRules[i];
      st.update((s) => s.agent.handoffRules.splice(i, 1));
      audit('ai_agent.update', A().instanceId, `Regra de transbordo removida: ${old}`);
      renderRules();
    }
    // Enquanto true, o subscribe não redesenha as regras: o input editado já
    // mostra o texto novo, e trocar os botões entre o mousedown e o mouseup de
    // um clique em "remover" (o blur dispara o change) perderia esse clique.
    let committingRule = false;
    function editRule(i, input, delBtn) {
      const rules = A().handoffRules;
      if (!rw().ok) {
        input.value = rules[i] ?? '';
        return;
      }
      const text = input.value.trim();
      if (text === rules[i]) {
        input.value = text;
        return;
      }
      if (!text) {
        // Regra apagada vira remoção em vez de guardar texto vazio.
        removeRule(i);
        return;
      }
      committingRule = true;
      try {
        st.update((s) => {
          s.agent.handoffRules[i] = text;
        });
      } finally {
        committingRule = false;
      }
      input.value = text;
      audit('ai_agent.update', A().instanceId, `Regra de transbordo editada: ${text}`);
      delBtn.setAttribute('aria-label', `Remover regra: ${text}`);
    }
    function renderRules() {
      const rules = A().handoffRules;
      const canEdit = rw();
      replaceChildren(
        rulesList,
        rules.length === 0
          ? h('div', { class: 'empty agent-empty' }, 'Sem regras: o agente nunca transfere para um humano.')
          : rules.map((r, i) => {
              const delBtn = hints.lock(h('button', { class: 'agent-icon-btn', type: 'button', 'aria-label': `Remover regra: ${r}`, title: 'Remover', onclick: () => removeRule(i) }, icon(ICON_TRASH, 15)), canEdit);
              const input = h('input', {
                class: 'agent-rule__input',
                type: 'text',
                value: r,
                maxlength: MAX_RULE,
                'aria-label': `Regra ${i + 1}`,
                onchange: () => editRule(i, input, delBtn),
                readonly: !canEdit.ok,
                onkeydown: (e) => {
                  if (e.key === 'Enter') input.blur();
                  if (e.key === 'Escape') {
                    input.value = A().handoffRules[i] ?? r;
                    input.blur();
                  }
                },
              });
              hints.lock(input, canEdit, { readOnly: true });
              return h(
                'div',
                { class: 'agent-rule' },
                h('span', { class: 'agent-rule__check', 'aria-hidden': 'true' }, '✓'),
                input,
                delBtn
              );
            })
      );
    }

    const addRuleBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: addRule }, icon(ICON_PLUS, 14), 'Adicionar');
    const handoffCard = h(
      'section',
      { class: 'card', 'aria-labelledby': 'agent-h-handoff' },
      h('span', { class: 'label', id: 'agent-h-handoff' }, 'Transbordo para humano'),
      h('p', { class: 'agent-hint' }, 'Quando uma regra dispara, a conversa vai para a fila da equipe. Edite o texto direto na linha; o limiar de confiança também é uma regra.'),
      rulesList,
      h(
        'div',
        { class: 'agent-rule-add' },
        ruleInput,
        addRuleBtn
      ),
      ruleError
    );

    // ---------------- chat de teste ----------------
    const msgsEl = h('div', { class: 'agent-chat__msgs', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversa de teste' });
    const chatInput = h('input', {
      class: 'agent-chat__input',
      type: 'text',
      maxlength: 400,
      placeholder: 'Escreva como um lead…',
      'aria-label': 'Mensagem do lead (teste)',
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          send();
        }
      },
      oninput: syncSend,
    });
    const sendBtn = h('button', { class: 'agent-send', type: 'button', 'aria-label': 'Enviar mensagem', onclick: send }, icon(ICON_SEND, 17));
    const clearBtn = h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: clearChat }, 'Limpar conversa');

    function syncSend() {
      sendBtn.disabled = typing || chatInput.value.trim() === '';
      clearBtn.disabled = typing || A().testChat.length === 0;
    }

    function bubble(m) {
      if (m.from === 'lead') return h('div', { class: 'agent-msg agent-msg--lead' }, m.text);
      if (m.from === 'handoff') {
        return h(
          'div',
          { class: 'agent-handoff', role: 'status' },
          h('div', { class: 'agent-handoff__title' }, h('span', { 'aria-hidden': 'true' }, '⇄'), m.text),
          h('div', { class: 'agent-handoff__rule' }, 'Regra que disparou: ', h('strong', null, m.rule))
        );
      }
      return h('div', { class: 'agent-msg agent-msg--ai' }, m.text, m.source ? h('div', { class: 'agent-msg__src' }, `Fonte: ${m.source}`) : null);
    }
    // Assinatura: só redesenha (e rola para o fim) quando o chat de fato mudou,
    // para não descartar a rolagem/seleção do usuário por mudanças alheias.
    let chatSig = null;
    function renderChat() {
      const chat = A().testChat;
      const sig = JSON.stringify([chat, typing]);
      if (sig === chatSig) {
        syncSend();
        return;
      }
      chatSig = sig;
      replaceChildren(
        msgsEl,
        chat.length === 0 && !typing ? h('div', { class: 'empty agent-chat__empty' }, 'Simule um lead: pergunte sobre ERP, preço ou peça para falar com uma pessoa.') : null,
        chat.map(bubble),
        typing ? h('div', { class: 'agent-typing', 'aria-label': 'Agente digitando' }, h('span', null, 'digitando'), h('i'), h('i'), h('i')) : null
      );
      msgsEl.scrollTop = msgsEl.scrollHeight;
      syncSend();
    }

    function send() {
      const text = chatInput.value.trim();
      if (!text || typing) return;
      chatInput.value = '';
      st.update((s) => s.agent.testChat.push({ from: 'lead', text }));
      typing = true;
      renderChat();
      pendingText = text;
      later(() => {
        finishReply();
        chatInput.focus();
      }, TYPING_MS);
    }
    let pendingText = null;
    function finishReply() {
      if (pendingText == null) return;
      const text = pendingText;
      pendingText = null;
      typing = false;
      const r = simulateReply(text, A());
      st.update((s) => {
        if (r.kind === 'handoff') s.agent.testChat.push({ from: 'handoff', text: r.text, rule: r.rule });
        else s.agent.testChat.push({ from: 'ai', text: r.text, source: r.source });
      });
      renderChat();
    }
    function clearChat() {
      st.update((s) => {
        s.agent.testChat = [];
      });
      renderChat();
      chatInput.focus();
    }

    const chatCard = h(
      'section',
      { class: 'card agent-chat', 'aria-labelledby': 'agent-h-chat' },
      h('div', { class: 'agent-chat__head' }, h('span', { class: 'label agent-chat__title', id: 'agent-h-chat' }, 'Testar agente'), h('span', { class: 'agent-grow' }), clearBtn),
      msgsEl,
      h('div', { class: 'agent-chat__foot' }, chatInput, sendBtn)
    );

    // ---------------- montagem ----------------
    replaceChildren(
      el,
      h('div', { class: 'page agent-page' }, bannerEl, header, h('div', { class: 'agent-grid' }, h('div', { class: 'agent-col' }, promptCard, kbCard, handoffCard), chatCard), hints.host)
    );
    syncHeader();
    syncPrompt();
    renderKb();
    renderRules();
    renderChat();

    // Mudanças vindas de fora (ex.: tela de Instâncias) ou das nossas próprias
    // ações. Regras só redesenham fora de edição para não roubar o foco.
    const unsub = st.subscribe(() => {
      syncHeader();
      renderKb();
      if (!committingRule && (!rulesList.contains(document.activeElement) || document.activeElement?.tagName !== 'INPUT')) renderRules();
      if (!typing) renderChat();
    });

    return () => {
      unsub();
      timers.forEach(clearTimeout);
      timers.clear();
      clearTimeout(confirmTimer);
      // Ações em voo terminam aqui: senão a mensagem do lead ficaria sem resposta
      // e o "Salvando…" seria descartado ao trocar de tela.
      finishReply();
      if (saving) commitPrompt();
    };
  },
};
