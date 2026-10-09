// Card MARCA: nome, domínio, cor de destaque e logotipo.
//
// Modelo: nome e cor são PRÉVIA ao vivo (nome vai pro store a cada tecla válida,
// cor vai pro <html>), mas só viram definitivos em "Salvar alterações". Se a
// pessoa sair da tela sem salvar, a prévia é revertida (destroy). Domínio e
// logotipo ficam no rascunho local até salvar.
import { h, icon, toast, replaceChildren } from '../../ui.js';
import { ACCENTS, applyAccent, saveAccent } from './accent.js';
import { validateDomain, cnameHost, PLATFORM_CNAME, DEFAULT_HOST } from './domain.js';
import { audit } from '../../access.js';
import { check, blocked, createHints } from '../_ops/perm.js';

const NAME_MAX = 30;
const MAX_LOGO = 1024 * 1024; // 1 MB
const ICON = {
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12l5 5 9-10',
};

// MB arredonda PARA CIMA: um arquivo acima do limite nunca aparece como "1,00 MB; limite 1 MB".
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < MAX_LOGO ? `${(n / 1024).toFixed(0)} KB` : `${(Math.ceil((n / MAX_LOGO) * 100) / 100).toFixed(2).replace('.', ',')} MB`);

function nameError(raw) {
  const v = raw.trim();
  if (!v) return 'Informe o nome do produto.';
  if (v.length > NAME_MAX) return `Use até ${NAME_MAX} caracteres.`;
  return null;
}

function logoTypeOk(file) {
  if (file.type === 'image/png' || file.type === 'image/svg+xml') return true;
  // alguns sistemas não informam o MIME de .svg
  return !file.type && /\.(png|svg)$/i.test(file.name);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

/** Confere o CONTEÚDO (assinatura PNG ou tag <svg>): extensão/MIME são só declaração do sistema. */
async function logoContentOk(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (PNG_SIG.every((b, i) => head[i] === b)) return true;
    return /<svg[\s>]/i.test(await file.text());
  } catch {
    return false;
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('Falha ao ler o arquivo'));
    r.readAsDataURL(file);
  });
}

export function createBrandCard(store) {
  // Alterar marca/domínio/cor/logo exige tenant_settings.update (motor). Sem ela os controles ficam
  // desabilitados com o motivo; os handlers também conferem (clique programático não altera o store).
  const hints = createHints();
  const rw = () => check('tenant_settings', 'update');
  const snapshot = () => {
    const b = store.state.tenant.brand;
    return {
      name: b.productName,
      domain: b.domain || '',
      domainStatus: b.domain ? b.domainStatus || 'verified' : 'idle',
      accent: ACCENTS.some((a) => a.id === b.accent) ? b.accent : 'gold',
      logo: b.logo || null,
    };
  };

  let saved = snapshot();
  const draft = { name: saved.name, domain: saved.domain, accent: saved.accent, logoFile: null, logoUrl: null, removeLogo: false };
  // 'idle' (sem domínio/inválido) | 'waiting' (digitando) | 'checking' | 'pending' | 'verified'
  let domStatus = saved.domainStatus;
  let logoErr = '';
  let saving = false;
  let destroyed = false;
  let flushSave = null;
  const touched = new Set();
  const timers = new Map();

  // Erro "no blur" aparece e empurra o layout entre o mousedown e o mouseup do clique que
  // causou o blur (o clique em swatch/Descartar se perderia). Com o ponteiro pressionado,
  // adia o aviso até o clique terminar; por teclado (Tab) mostra na hora.
  let pointerDown = false;
  let afterPointer = [];
  const onPointerDown = () => {
    pointerDown = true;
  };
  const onPointerEnd = () => {
    pointerDown = false;
    // setTimeout 0: o "click" é despachado logo após o pointerup, antes deste timer.
    setTimeout(() => {
      const fns = afterPointer;
      afterPointer = [];
      if (!destroyed) fns.forEach((fn) => fn());
    }, 0);
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerEnd, true);
  document.addEventListener('pointercancel', onPointerEnd, true);
  const whenPointerFree = (fn) => (pointerDown ? afterPointer.push(fn) : fn());

  /** Timer nomeado: reiniciar o mesmo nome cancela o anterior. */
  const later = (key, fn, ms) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      if (!destroyed) fn();
    }, ms));
  };
  const clearTimers = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };

  const domainNorm = () => draft.domain.trim().toLowerCase();
  const isDirty = () =>
    draft.name.trim() !== saved.name ||
    domainNorm() !== saved.domain ||
    draft.accent !== saved.accent ||
    !!draft.logoFile ||
    draft.removeLogo;
  const isValid = () => !nameError(draft.name) && !validateDomain(draft.domain).error;
  const canSave = () => isDirty() && isValid() && !saving && domStatus !== 'checking' && domStatus !== 'waiting';

  // ---------- nome ----------
  const nameErrEl = h('div', { class: 'field-error', id: 'settings-name-err', role: 'alert' });
  const nameInput = h('input', {
    class: 'input input--inset',
    id: 'settings-name',
    type: 'text',
    value: draft.name,
    autocomplete: 'off',
    'aria-describedby': 'settings-name-err',
    oninput: () => {
      if (!rw().ok) {
        nameInput.value = draft.name; // digitação programática não vira prévia nem rascunho
        return;
      }
      draft.name = nameInput.value;
      touched.add('name');
      const v = draft.name.trim();
      // Só empurra pro store (sidebar/título) nomes válidos; vazio mantém o último bom.
      if (!nameError(draft.name) && store.state.tenant.brand.productName !== v) {
        store.update((s) => {
          s.tenant.brand.productName = v;
        });
        document.title = `Configurações · ${v}`;
      }
      renderNameErr();
      renderFooter();
    },
    onblur: () =>
      whenPointerFree(() => {
        touched.add('name');
        renderNameErr();
      }),
  });
  function renderNameErr() {
    const err = touched.has('name') ? nameError(draft.name) : null;
    nameErrEl.textContent = err || '';
    nameInput.setAttribute('aria-invalid', err ? 'true' : 'false');
  }

  // ---------- domínio ----------
  const domErrEl = h('div', { class: 'field-error', id: 'settings-domain-err', role: 'alert' });
  const domStatusEl = h('div', { class: 'settings-dns', role: 'status', 'aria-live': 'polite' });
  const domainInput = h('input', {
    class: 'input input--inset',
    id: 'settings-domain',
    type: 'text',
    value: draft.domain,
    placeholder: 'crm.suaempresa.com.br',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-describedby': 'settings-domain-err',
    oninput: () => {
      if (!rw().ok) {
        domainInput.value = draft.domain;
        return;
      }
      draft.domain = domainInput.value;
      onDomainChanged();
    },
    onblur: () =>
      whenPointerFree(() => {
        touched.add('domain');
        renderDomain();
      }),
  });

  function onDomainChanged() {
    clearTimeout(timers.get('dom'));
    timers.delete('dom');
    const { value, error } = validateDomain(draft.domain);
    if (!value || error) domStatus = 'idle';
    else if (value === saved.domain) domStatus = saved.domainStatus;
    else {
      // Debounce + "consulta de DNS" simulada: só depois vira "Aguardando CNAME".
      domStatus = 'waiting';
      later('dom', () => {
        domStatus = 'checking';
        renderDomain();
        renderFooter();
        later('dom', () => {
          domStatus = 'pending';
          renderDomain();
          renderFooter();
        }, 1500);
      }, 700);
    }
    renderDomain();
    renderFooter();
  }

  function verifyNow() {
    if (blocked(rw())) return;
    domStatus = 'checking';
    renderDomain();
    renderFooter();
    later('dom', () => {
      domStatus = 'verified';
      const { value } = validateDomain(draft.domain);
      // Domínio já salvo: a verificação é do servidor, vale sem precisar salvar de novo.
      if (value === saved.domain && rw().ok) {
        saved.domainStatus = 'verified';
        store.update((s) => {
          s.tenant.brand.domainStatus = 'verified';
        });
        audit('settings.update', 'brand', `Domínio ${value} verificado`);
      }
      renderDomain();
      renderFooter();
      toast('Domínio verificado.');
    }, 1300);
  }

  function copy(text) {
    // clipboard exige contexto seguro/permissão; se falhar, o valor continua visível pra copiar à mão.
    navigator.clipboard?.writeText(text).then(
      () => toast('Valor copiado.'),
      () => toast('Não foi possível copiar. Selecione o valor manualmente.')
    );
    if (!navigator.clipboard) toast('Não foi possível copiar. Selecione o valor manualmente.');
  }

  function renderDomain() {
    const { value, error } = validateDomain(draft.domain);
    domErrEl.textContent = error && touched.has('domain') ? error : '';
    domainInput.setAttribute('aria-invalid', error && touched.has('domain') ? 'true' : 'false');

    let content = null;
    if (!value) {
      content = h('p', { class: 'settings-hint' }, `Sem domínio próprio, o acesso fica em ${DEFAULT_HOST}.`);
    } else if (error || domStatus === 'idle' || domStatus === 'waiting') {
      content = null;
    } else if (domStatus === 'checking') {
      content = h('div', { class: 'settings-dns__row status status--warn' }, h('span', { class: 'settings-spinner', 'aria-hidden': 'true' }), 'Verificando DNS…');
    } else if (domStatus === 'verified') {
      content = h('div', { class: 'settings-dns__row status status--ok' }, icon(ICON.check, 15), 'Domínio verificado');
    } else if (domStatus === 'pending') {
      content = h(
        'div',
        { class: 'settings-dns__pending' },
        h('div', { class: 'settings-dns__row status status--warn' }, h('span', { class: 'settings-dot', 'aria-hidden': 'true' }), 'Aguardando CNAME'),
        h('p', { class: 'settings-hint' }, 'No painel de DNS do seu domínio, crie este registro. A propagação pode levar algumas horas.'),
        h(
          'dl',
          { class: 'settings-cname' },
          h('dt', null, 'Tipo'),
          h('dd', null, 'CNAME'),
          h('dt', null, 'Nome'),
          h('dd', null, cnameHost(value)),
          h('dt', null, 'Valor'),
          h(
            'dd',
            null,
            h('code', null, PLATFORM_CNAME),
            h('button', { class: 'settings-copy', type: 'button', 'aria-label': 'Copiar valor do CNAME', onclick: () => copy(PLATFORM_CNAME) }, icon(ICON.copy, 15))
          )
        ),
        h('div', null, hints.lock(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: verifyNow }, 'Verificar agora'), rw()))
      );
    }
    replaceChildren(domStatusEl, content);
  }

  // ---------- cor de destaque ----------
  const swatchesEl = h('div', { class: 'settings-swatches', role: 'radiogroup', 'aria-label': 'Cor de destaque' });
  const accentNameEl = h('span', { class: 'settings-hint' });
  const resetAccentBtn = h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => pickAccent('gold') }, 'Restaurar padrão');

  function pickAccent(id, focus = false) {
    if (blocked(rw())) return;
    draft.accent = id;
    applyAccent(id); // prévia imediata no app inteiro
    renderAccent();
    renderFooter();
    if (focus) swatchesEl.querySelector('[aria-checked="true"]')?.focus();
  }

  function renderAccent() {
    const theme = store.state.theme === 'light' ? 'light' : 'dark';
    const idx = ACCENTS.findIndex((a) => a.id === draft.accent);
    const canEdit = rw();
    replaceChildren(
      swatchesEl,
      ACCENTS.map((a, i) =>
        hints.lock(h('button', {
          class: 'settings-swatch',
          type: 'button',
          role: 'radio',
          'aria-checked': String(a.id === draft.accent),
          'aria-label': a.name,
          title: a.name,
          tabindex: i === idx ? '0' : '-1',
          // Amostra com a cor real da variante do tema (não depende de --acc, que muda).
          style: { background: a[theme].acc },
          onclick: () => pickAccent(a.id),
          onkeydown: (e) => {
            const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (!dir) return;
            e.preventDefault();
            pickAccent(ACCENTS[(i + dir + ACCENTS.length) % ACCENTS.length].id, true);
          },
        }), canEdit)
      )
    );
    const cur = ACCENTS[idx] || ACCENTS[0];
    accentNameEl.textContent = draft.accent === 'gold' ? `${cur.name} (padrão)` : cur.name;
    hints.lock(resetAccentBtn, canEdit, { other: draft.accent === 'gold' });
  }

  // ---------- logotipo ----------
  const fileInput = h('input', {
    type: 'file',
    accept: '.png,.svg,image/png,image/svg+xml',
    hidden: true,
    'aria-label': 'Escolher arquivo do logotipo',
    onchange: () => {
      const f = fileInput.files?.[0];
      fileInput.value = ''; // permite escolher o mesmo arquivo de novo
      if (f) setLogoFile(f);
    },
  });
  const dropBody = h('div', { class: 'settings-drop__body' });
  const logoErrEl = h('div', { class: 'field-error', role: 'alert' });
  const drop = h('div', { class: 'settings-drop' }, dropBody);

  function revokeLogoUrl() {
    if (draft.logoUrl) URL.revokeObjectURL(draft.logoUrl);
    draft.logoUrl = null;
  }

  async function setLogoFile(file) {
    if (blocked(rw())) return;
    let ok = false;
    if (!logoTypeOk(file)) {
      logoErr = 'Formato não aceito. Envie um arquivo PNG ou SVG.';
    } else if (file.size === 0) {
      logoErr = 'O arquivo está vazio.';
    } else if (file.size > MAX_LOGO) {
      logoErr = `O arquivo tem ${fmtSize(file.size)}; o limite é 1 MB.`;
    } else if (!(await logoContentOk(file))) {
      logoErr = 'O conteúdo não é uma imagem PNG ou SVG válida.';
    } else ok = true;
    if (destroyed) return;
    if (ok) {
      logoErr = '';
      revokeLogoUrl();
      draft.logoFile = file;
      draft.logoUrl = URL.createObjectURL(file);
      draft.removeLogo = false;
    }
    renderLogo();
    renderFooter();
  }

  function removeLogo() {
    if (blocked(rw())) return;
    revokeLogoUrl();
    draft.logoFile = null;
    draft.removeLogo = !!saved.logo; // se havia logo salvo, remover é uma mudança a salvar
    logoErr = '';
    renderLogo();
    renderFooter();
  }

  function renderLogo() {
    const src = draft.logoUrl || (!draft.removeLogo && saved.logo?.dataUrl) || null;
    const meta = draft.logoFile || (!draft.removeLogo ? saved.logo : null);
    const canEdit = rw();
    drop.classList.toggle('has-logo', !!src);
    if (src) {
      replaceChildren(
        dropBody,
        h('div', { class: 'settings-logo' }, h('img', { src, alt: 'Prévia do logotipo' })),
        h('div', { class: 'settings-drop__info' }, h('span', { class: 'truncate' }, meta?.name || 'Logotipo'), h('span', { class: 'settings-hint' }, meta?.size ? fmtSize(meta.size) : '')),
        h(
          'div',
          { class: 'settings-drop__actions' },
          hints.lock(h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => fileInput.click() }, 'Trocar'), canEdit),
          hints.lock(h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: removeLogo }, 'Remover'), canEdit)
        )
      );
    } else {
      replaceChildren(
        dropBody,
        h('span', { class: 'settings-drop__icon' }, icon(ICON.upload, 22)),
        h('span', null, 'Arraste o logotipo (PNG/SVG)'),
        h('span', { class: 'settings-hint' }, 'até 1 MB'),
        hints.lock(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => fileInput.click() }, 'Escolher arquivo'), canEdit)
      );
    }
    logoErrEl.textContent = logoErr;
  }

  let dragDepth = 0;
  drop.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragover', (e) => e.preventDefault()); // sem isso o drop não dispara
  drop.addEventListener('dragleave', () => {
    // dragleave dispara ao cruzar filhos; o contador evita piscar a borda
    if (--dragDepth <= 0) {
      dragDepth = 0;
      drop.classList.remove('is-over');
    }
  });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) setLogoFile(f); // confere a permissão dentro
  });

  // ---------- rodapé: salvar / descartar ----------
  const dirtyNote = h('span', { class: 'settings-dirty', 'aria-live': 'polite' });
  const discardBtn = h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => discard() }, 'Descartar');
  const saveBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Salvar alterações');

  function renderFooter() {
    const dirty = isDirty();
    dirtyNote.textContent = saving ? '' : dirty ? 'Alterações não salvas' : '';
    dirtyNote.classList.toggle('is-on', dirty && !saving);
    discardBtn.disabled = !dirty || saving;
    hints.lock(saveBtn, rw(), { other: !canSave() });
    hints.lock(nameInput, rw(), { readOnly: true });
    hints.lock(domainInput, rw(), { readOnly: true });
    saveBtn.textContent = saving ? 'Salvando…' : 'Salvar alterações';
    if (rw().ok) saveBtn.title = dirty && !isValid() ? 'Corrija os campos destacados para salvar' : domStatus === 'checking' ? 'Aguarde a verificação do DNS' : '';
  }

  function discard() {
    clearTimers();
    revokeLogoUrl();
    Object.assign(draft, { name: saved.name, domain: saved.domain, accent: saved.accent, logoFile: null, removeLogo: false });
    domStatus = saved.domainStatus;
    logoErr = '';
    touched.clear();
    nameInput.value = draft.name;
    domainInput.value = draft.domain;
    revertPreview();
    renderAll();
    toast('Alterações descartadas.');
  }

  /** Volta a prévia ao valor salvo (nome no store/título e cor no <html>). */
  function revertPreview() {
    if (store.state.tenant.brand.productName !== saved.name) {
      store.update((s) => {
        s.tenant.brand.productName = saved.name;
      });
    }
    document.title = `Configurações · ${saved.name}`;
    applyAccent(saved.accent);
  }

  async function save() {
    if (blocked(rw()) || !canSave()) return;
    touched.add('name');
    touched.add('domain');
    // desabilitar o fieldset derruba o foco; guarda quem tinha para devolver depois
    const prevFocus = document.activeElement;
    saving = true;
    fieldset.disabled = true;
    renderFooter();
    let logo = saved.logo;
    try {
      if (draft.removeLogo) logo = null;
      else if (draft.logoFile) {
        const dataUrl = await readAsDataUrl(draft.logoFile);
        logo = { name: draft.logoFile.name, size: draft.logoFile.size, type: draft.logoFile.type, dataUrl };
      }
      // latência simulada do backend; se a pessoa sair da tela, destroy() libera a espera
      // e o commit abaixo roda na hora (salvar não pode virar descarte silencioso)
      await new Promise((r) => {
        if (destroyed) return r();
        flushSave = r;
        later('save', r, 450);
      });
    } catch {
      flushSave = null;
      logoErr = 'Não foi possível ler o arquivo do logotipo.';
      saving = false;
      fieldset.disabled = false;
      if (destroyed) {
        revertPreview();
        return;
      }
      renderLogo();
      renderFooter();
      return;
    }
    flushSave = null;
    const { value: domain } = validateDomain(draft.domain);
    // Perdeu a permissão durante a latência simulada: não grava; a prévia volta ao valor salvo.
    if (!rw().ok) {
      saving = false;
      fieldset.disabled = false;
      revertPreview();
      if (!destroyed) {
        discard();
        blocked(rw());
      }
      return;
    }
    const changes = describeChanges(domain, logo);
    store.update((s) => {
      Object.assign(s.tenant.brand, {
        productName: draft.name.trim(),
        domain,
        domainStatus: domain ? domStatus : null,
        accent: draft.accent,
        logo,
      });
    });
    saveAccent(draft.accent);
    audit('settings.update', 'brand', changes.length ? `Marca atualizada: ${changes.join('; ')}` : 'Marca atualizada');
    revokeLogoUrl();
    saved = snapshot();
    Object.assign(draft, { name: saved.name, domain: saved.domain, logoFile: null, removeLogo: false });
    nameInput.value = draft.name;
    domainInput.value = draft.domain;
    saving = false;
    fieldset.disabled = false;
    renderAll();
    toast('Alterações da marca salvas.');
    if (destroyed) return;
    // o botão Salvar fica desabilitado (sem alterações): o foco volta ao campo de nome
    const back = prevFocus && prevFocus.isConnected && el.contains(prevFocus) && !prevFocus.disabled ? prevFocus : nameInput;
    back.focus();
  }

  /** Texto curto do que mudou (para a auditoria): compara o rascunho com o valor salvo. */
  function describeChanges(domain, logo) {
    const out = [];
    if (draft.name.trim() !== saved.name) out.push(`nome "${saved.name}" → "${draft.name.trim()}"`);
    if (domain !== saved.domain) out.push(`domínio ${saved.domain ? `"${saved.domain}"` : '(nenhum)'} → ${domain ? `"${domain}"` : '(nenhum)'}`);
    if (draft.accent !== saved.accent) out.push(`cor de destaque ${saved.accent} → ${draft.accent}`);
    if (draft.removeLogo) out.push('logotipo removido');
    else if (draft.logoFile) out.push(`logotipo ${saved.logo ? 'trocado' : 'enviado'} (${draft.logoFile.name})`);
    return out;
  }

  function renderAll() {
    renderNameErr();
    renderDomain();
    renderAccent();
    renderLogo();
    renderFooter();
  }

  const fieldset = h(
    'fieldset',
    { class: 'settings-fieldset' },
    h('div', { class: 'settings-group' }, h('label', { class: 'field', for: 'settings-name' }, 'Nome do produto', nameInput), nameErrEl),
    h('div', { class: 'settings-group' }, h('label', { class: 'field', for: 'settings-domain' }, 'Domínio personalizado', domainInput), domErrEl, domStatusEl),
    h(
      'div',
      { class: 'settings-group' },
      h('div', { class: 'field' }, h('span', { id: 'settings-accent-label' }, 'Cor de destaque')),
      h('div', { class: 'settings-accent' }, swatchesEl, accentNameEl, h('span', { class: 'settings-spacer' }), resetAccentBtn)
    ),
    h('div', { class: 'settings-group' }, h('div', { class: 'field' }, h('span', null, 'Logotipo'), drop), logoErrEl, fileInput),
    h('div', { class: 'settings-actions' }, dirtyNote, h('span', { class: 'settings-spacer' }), discardBtn, saveBtn)
  );
  const el = h(
    'form',
    {
      class: 'card settings-card',
      novalidate: true,
      'aria-labelledby': 'settings-brand-title',
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
    },
    h('span', { class: 'label', id: 'settings-brand-title' }, 'Marca'),
    fieldset,
    hints.host
  );
  renderAll();

  // O tema muda as variantes de cor das amostras.
  let lastTheme = store.state.theme;
  let lastCan = rw().ok;
  const unsub = store.subscribe((s) => {
    if (s.theme !== lastTheme) {
      lastTheme = s.theme;
      renderAccent();
    }
    // o perfil do usuário mudou enquanto a tela está aberta: refaz o travamento dos controles
    if (rw().ok !== lastCan) {
      lastCan = rw().ok;
      renderAll();
    }
  });

  return {
    el,
    destroy() {
      destroyed = true;
      clearTimers();
      unsub();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      if (saving) {
        // Salvamento em andamento: conclui em vez de reverter (ver save()).
        flushSave?.();
        return;
      }
      revokeLogoUrl();
      // Prévia não salva não deve vazar para as outras telas.
      revertPreview();
    },
  };
}
