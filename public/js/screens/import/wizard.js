// Assistente de importação de CSV (contatos ou negócios): arquivo → ligar colunas → conferir → importar.
// A conferência usa as mesmas regras do servidor (shared/import/rules.js); o resultado final é o do servidor.
import { h, replaceChildren, toast, fmtInt } from '../../ui.js';
import { openDialog } from '../contacts/form.js';
import { decodeBuffer, parseCsv, toCsv, downloadCsv } from '../../lists/csv.js';
import { CONTACT_FIELDS, DEAL_FIELDS, guessMapping, rowToRaw, planContacts, validateDeal } from '/shared/import/rules.js';
import * as A from './actions.js';

const TEMPLATE = {
  contact: { name: 'modelo-contatos.csv', header: ['Nome', 'Empresa', 'Telefone', 'E-mail', 'Origem'], rows: [['Ana Souza', 'Acme Ltda', '(11) 98888-7777', 'ana@acme.com.br', 'Indicação']] },
  deal: { name: 'modelo-negocios.csv', header: ['Título', 'Contato', 'Telefone', 'E-mail', 'Valor', 'Etapa', 'Previsão de fechamento', 'Responsável'], rows: [['Implantação CRM', 'Ana Souza', '(11) 98888-7777', 'ana@acme.com.br', '18.400,00', '', '31/12/2026', '']] },
};
const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/**
 * @param entity 'contact' | 'deal' · @param pipeline funil que recebe os negócios (só para 'deal') · @param onDone() depois de importar
 * @returns { close, loadText(texto, nome) } — `loadText` é o mesmo caminho do campo de arquivo (usado pelos testes)
 */
export function openImport({ entity, pipeline = null, onDone }) {
  const isContact = entity === 'contact';
  const fields = isContact ? CONTACT_FIELDS : DEAL_FIELDS;
  const noun = isContact ? ['contato', 'contatos'] : ['negócio', 'negócios'];
  let step = 'file';
  let parsed = null;
  let fileName = '';
  let mapping = {};
  let error = '';
  let busy = false;
  let result = null;
  const body = h('div', { class: 'import' });
  const dlg = openDialog({ eyebrow: 'IMPORTAR', title: isContact ? 'Importar contatos de um CSV' : `Importar negócios para ${pipeline?.name || 'o funil'}`, content: body });
  body.closest('.contacts-dialog')?.classList.add('import-dialog');

  const raws = () => parsed.rows.map((cells, i) => ({ line: parsed.lines[i], ...rowToRaw(cells, mapping) }));
  const missingRequired = () => fields.filter((f) => f.required && (mapping[f.key] === undefined || mapping[f.key] === null));

  function loadText(text, name = 'arquivo.csv') {
    error = '';
    const p = parseCsv(text);
    if (!p.header.length || !p.rows.length) error = 'O arquivo não tem linhas para importar (precisa do cabeçalho e de pelo menos uma linha).';
    else if (p.rows.length > A.MAX_ROWS) error = `O arquivo tem ${fmtInt(p.rows.length)} linhas; o limite é ${fmtInt(A.MAX_ROWS)} por vez. Divida em partes.`;
    if (error) return paint();
    parsed = p;
    fileName = name;
    mapping = guessMapping(p.header, fields);
    step = 'map';
    paint();
  }

  async function run() {
    busy = true;
    error = '';
    paint();
    const rows = raws();
    const r = isContact ? await A.importContacts(rows) : await A.importDeals(pipeline, rows);
    busy = false;
    if (!r.ok) {
      error = r.error;
      step = 'review';
    } else {
      result = r;
      step = 'done';
      if (r.created) toast(`${plural(r.created, noun[0], noun[1])} ${r.created === 1 ? 'importado' : 'importados'}`);
      onDone?.(r);
    }
    paint();
  }

  const actions = (...btns) => h('div', { class: 'contacts-form__actions' }, ...btns);
  const btn = (label, onclick, cls = 'btn btn--quiet', extra = {}) => h('button', { class: cls, type: 'button', onclick, ...extra }, label);

  function paint() {
    const content = {
      file: stepFile,
      map: stepMap,
      review: stepReview,
      done: stepDone,
    }[step]();
    replaceChildren(body, content);
  }

  function stepFile() {
    const input = h('input', { class: 'import-file', type: 'file', accept: '.csv,.txt,text/csv', 'aria-label': 'Arquivo CSV' });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        loadText(decodeBuffer(await f.arrayBuffer()), f.name);
      } catch {
        error = 'Não foi possível ler este arquivo.';
        paint();
      }
    });
    const t = TEMPLATE[entity];
    return h(
      'div',
      { class: 'contacts-form' },
      h('p', { class: 'muted' }, isContact ? 'Envie uma planilha salva como CSV (no Excel: Arquivo → Salvar como → CSV). A primeira linha precisa ser o cabeçalho; você escolhe na próxima etapa qual coluna é cada campo.' : 'Envie uma planilha salva como CSV (no Excel: Arquivo → Salvar como → CSV). Cada linha vira um negócio no funil escolhido; o contato é ligado pelo telefone, e-mail ou nome — se não existir, é criado.'),
      h('label', { class: 'field' }, 'Arquivo CSV', input),
      error ? h('span', { class: 'field-error', role: 'alert' }, error) : null,
      h('p', { class: 'import-hint' }, `Até ${fmtInt(A.MAX_ROWS)} linhas por vez. Aceita separador ; , ou tabulação e acentos do Excel.`),
      actions(btn('Baixar modelo', () => downloadCsv(t.name, toCsv(t.header, t.rows)), 'btn btn--ghost'), h('span', { class: 'import-spacer' }), btn('Cancelar', () => dlg.close()))
    );
  }

  function stepMap() {
    const sels = fields.map((f) => {
      const sel = h('select', { class: 'select', 'aria-label': `Coluna para ${f.label}`, 'data-field': f.key }, h('option', { value: '' }, '— não importar —'), ...parsed.header.map((hd, i) => h('option', { value: String(i), selected: mapping[f.key] === i }, hd || `(coluna ${i + 1})`)));
      sel.addEventListener('change', () => {
        mapping = { ...mapping };
        if (sel.value === '') delete mapping[f.key];
        else mapping[f.key] = Number(sel.value);
        error = '';
        paint();
      });
      return h('label', { class: 'import-map__row' }, h('span', { class: 'import-map__label' }, f.label, f.required ? h('b', { title: 'Obrigatório' }, ' *') : null), sel);
    });
    const used = Object.values(mapping);
    const sample = parsed.rows.slice(0, 3);
    return h(
      'div',
      { class: 'contacts-form' },
      h('p', { class: 'muted' }, `${fileName} · ${plural(parsed.rows.length, 'linha', 'linhas')}. Diga qual coluna do arquivo vai para cada campo.`),
      h('div', { class: 'import-map' }, ...sels),
      used.length !== new Set(used).size ? h('p', { class: 'import-hint' }, 'Atenção: a mesma coluna está ligada a mais de um campo.') : null,
      h('div', { class: 'import-sample', 'aria-label': 'Primeiras linhas do arquivo' }, h('table', null, h('thead', null, h('tr', null, ...parsed.header.map((x) => h('th', null, x)))), h('tbody', null, ...sample.map((r) => h('tr', null, ...r.map((c) => h('td', null, c))))))),
      error ? h('span', { class: 'field-error', role: 'alert' }, error) : null,
      actions(btn('Voltar', () => ((step = 'file'), paint())), h('span', { class: 'import-spacer' }), btn('Continuar', () => {
        const miss = missingRequired();
        if (miss.length) {
          error = `Ligue uma coluna ao campo ${miss.map((f) => f.label).join(', ')}.`;
          return paint();
        }
        error = '';
        step = 'review';
        paint();
      }, 'btn btn--primary', { 'data-act': 'continue' }))
    );
  }

  /** Conferência: o que entra e o que fica de fora (com o motivo). */
  function review() {
    const rows = raws();
    if (isContact) {
      const p = planContacts(rows, A.existingContacts());
      return { ok: p.create.length, skipped: p.skipped };
    }
    const ctx = A.dealContext(pipeline);
    const skipped = [];
    let ok = 0;
    for (const r of rows) {
      const v = validateDeal(r, ctx);
      if (v.ok) ok++;
      else skipped.push({ line: r.line, reason: v.reason });
    }
    return { ok, skipped };
  }

  function stepReview() {
    const r = review();
    const run0 = r.ok === 0;
    return h(
      'div',
      { class: 'contacts-form' },
      h('p', { class: 'import-summary', role: 'status' }, h('strong', null, plural(r.ok, `${noun[0]} pronto`, `${noun[1]} prontos`)), r.skipped.length ? ` · ${plural(r.skipped.length, 'linha fica de fora', 'linhas ficam de fora')}` : ''),
      isContact ? h('p', { class: 'import-hint' }, 'Quem já existe (mesmo telefone ou e-mail) é pulado, sem alterar o que está cadastrado. A conferência final é feita ao importar.') : h('p', { class: 'import-hint' }, 'Cada negócio ainda passa pelas suas permissões ao importar: o que o seu perfil não puder criar fica de fora com o motivo.'),
      r.skipped.length ? h('ul', { class: 'import-problems', 'aria-label': 'Linhas de fora' }, ...r.skipped.slice(0, 8).map((s) => h('li', null, h('span', { class: 'import-problems__line' }, `Linha ${s.line}`), s.reason)), r.skipped.length > 8 ? h('li', { class: 'import-hint' }, `…e mais ${fmtInt(r.skipped.length - 8)}.`) : null) : null,
      error ? h('span', { class: 'field-error', role: 'alert' }, error) : null,
      actions(btn('Voltar', () => ((step = 'map'), paint())), h('span', { class: 'import-spacer' }), btn(busy ? 'Importando…' : run0 ? 'Nada para importar' : `Importar ${plural(r.ok, noun[0], noun[1])}`, run, 'btn btn--primary', { disabled: busy || run0, 'aria-busy': busy ? 'true' : null, 'data-act': 'run' }))
    );
  }

  function stepDone() {
    const r = result;
    return h(
      'div',
      { class: 'contacts-form' },
      h('p', { class: 'import-summary', role: 'status' }, h('strong', null, `${plural(r.created, `${noun[0]} importado`, `${noun[1]} importados`)}`), r.contactsCreated ? ` · ${plural(r.contactsCreated, 'contato novo criado', 'contatos novos criados')}` : '', r.skippedTotal ? ` · ${plural(r.skippedTotal, 'linha de fora', 'linhas de fora')}` : ''),
      r.skipped?.length ? h('ul', { class: 'import-problems', 'aria-label': 'Linhas de fora' }, ...r.skipped.slice(0, 12).map((s) => h('li', null, h('span', { class: 'import-problems__line' }, `Linha ${s.line}`), s.reason)), r.skippedTotal > 12 ? h('li', { class: 'import-hint' }, `…e mais ${fmtInt(r.skippedTotal - 12)}.`) : null) : null,
      r.skipped?.length ? btn('Baixar linhas de fora', () => downloadCsv('linhas-de-fora.csv', toCsv(['Linha', 'Motivo'], r.skipped.map((s) => [s.line, s.reason]))), 'btn btn--ghost btn--sm') : null,
      actions(h('span', { class: 'import-spacer' }), btn('Concluir', () => dlg.close(), 'btn btn--primary'))
    );
  }

  paint();
  return { close: dlg.close, loadText };
}
