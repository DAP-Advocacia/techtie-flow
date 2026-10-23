// Regras da importação de CSV — PURAS e isomórficas: a tela as usa para a prévia e o servidor para valer
// (src/api/routes-import.js importa este mesmo arquivo), então o que a prévia promete é o que o servidor faz.
// Testado em test/api/import-rules.test.mjs.

export const MAX_ROWS = 2000;

export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
const clean = (s, max) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Telefone só com dígitos (como o sistema guarda). Brasil: 10 ou 11 dígitos (DDD + número) ganham o 55
 * (se não houver "+" na frente); "00" na frente sai. Devolve { value } (ou { value: null } se vazio) ou { error }.
 */
export function normalizePhone(raw) {
  const explicit = /^\s*\+/.test(String(raw ?? '')); // "+" na frente = o código do país já veio
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return { value: null };
  if (d.startsWith('00')) d = d.slice(2);
  else if (!explicit && (d.length === 10 || d.length === 11)) d = `55${d}`;
  return /^[0-9]{8,15}$/.test(d) ? { value: d } : { error: 'Telefone inválido' };
}

export function normalizeEmail(raw) {
  const e = String(raw ?? '').trim().toLowerCase();
  if (!e) return { value: null };
  return EMAIL_RE.test(e) && e.length <= 254 ? { value: e } : { error: 'E-mail inválido' };
}

/** '1.500,50' | 'R$ 1.200' | '1500.5' → número; null se vazio; NaN se não for número. */
export function parseMoney(raw) {
  const s = String(raw ?? '').replace(/R\$|\s| /g, '');
  if (!s) return null;
  if (s.includes(',')) return /^(\d{1,3}(\.\d{3})+|\d+),\d{1,2}$/.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : NaN;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN;
}

/** 'dd/mm/aaaa' | 'dd-mm-aaaa' | 'aaaa-mm-dd' → 'aaaa-mm-dd'; null se vazio; NaN se não for data real. */
export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let y;
  let m;
  let d;
  let r;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [, d, m, y] = r;
  else return NaN;
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(m) - 1 || dt.getDate() !== Number(d)) return NaN;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Contatos
// ---------------------------------------------------------------------------------------------

/** Uma linha crua {name, company, phone, email, source} → { ok, value } ou { ok:false, reason }. */
export function validateContact(raw) {
  const name = clean(raw.name, 400);
  if (!name) return { ok: false, reason: 'Sem nome' };
  if (name.length > 200) return { ok: false, reason: 'Nome com mais de 200 caracteres' };
  const phone = normalizePhone(raw.phone);
  if (phone.error) return { ok: false, reason: phone.error };
  const email = normalizeEmail(raw.email);
  if (email.error) return { ok: false, reason: email.error };
  return { ok: true, value: { name, company: clean(raw.company, 200) || null, phone: phone.value, email: email.value, source: clean(raw.source, 80) || 'import' } };
}

/**
 * Separa o que entra do que fica de fora. `rows`: [{ line, ...crua }]; `existing`: { phones:Set, emails:Set } já na empresa.
 * Repetido DENTRO do arquivo (mesmo telefone ou e-mail) entra só a primeira vez.
 * @returns {{ create: {line, value}[], skipped: {line, reason}[] }}
 */
export function planContacts(rows, existing = {}) {
  const phones = new Set(existing.phones || []);
  const emails = new Set(existing.emails || []);
  const inFile = { phones: new Set(), emails: new Set() };
  const create = [];
  const skipped = [];
  for (const row of rows) {
    const v = validateContact(row);
    if (!v.ok) {
      skipped.push({ line: row.line, reason: v.reason });
      continue;
    }
    const { phone, email } = v.value;
    const why = phone && phones.has(phone) ? 'Já existe um contato com este telefone' : email && emails.has(email) ? 'Já existe um contato com este e-mail' : phone && inFile.phones.has(phone) ? 'Telefone repetido no arquivo' : email && inFile.emails.has(email) ? 'E-mail repetido no arquivo' : '';
    if (why) {
      skipped.push({ line: row.line, reason: why });
      continue;
    }
    if (phone) inFile.phones.add(phone);
    if (email) inFile.emails.add(email);
    create.push({ line: row.line, value: v.value });
  }
  return { create, skipped };
}

// ---------------------------------------------------------------------------------------------
// Negócios
// ---------------------------------------------------------------------------------------------

/**
 * Uma linha crua de negócio → { ok, value } ou { ok:false, reason }.
 * `ctx`: { stages: [{id, name, kind}], users: [{id, name, email}] }. Etapa em branco = a primeira em andamento;
 * responsável em branco = quem importa (o chamador decide: `ownerId: null`). Contato: telefone/e-mail/nome (opcionais).
 */
export function validateDeal(raw, ctx) {
  const title = clean(raw.title, 400);
  if (!title) return { ok: false, reason: 'Sem título' };
  if (title.length > 200) return { ok: false, reason: 'Título com mais de 200 caracteres' };
  const value = parseMoney(raw.value);
  if (Number.isNaN(value) || (value !== null && (value < 0 || value > 1e12))) return { ok: false, reason: 'Valor inválido' };
  const expectedClose = parseDate(raw.expectedClose);
  if (Number.isNaN(expectedClose)) return { ok: false, reason: 'Data de fechamento inválida' };
  let stageId;
  const stageName = fold(raw.stage);
  if (!stageName) stageId = (ctx.stages.find((s) => (s.kind || 'open') === 'open') || ctx.stages[0])?.id;
  else {
    const st = ctx.stages.find((s) => fold(s.name) === stageName);
    if (!st) return { ok: false, reason: `Etapa “${clean(raw.stage, 60)}” não existe neste funil` };
    stageId = st.id;
  }
  if (!stageId) return { ok: false, reason: 'O funil não tem etapas' };
  let ownerId = null;
  const ownerKey = fold(raw.owner);
  if (ownerKey) {
    const hits = ctx.users.filter((u) => fold(u.email) === ownerKey || fold(u.name) === ownerKey);
    if (hits.length !== 1) return { ok: false, reason: hits.length ? `Responsável “${clean(raw.owner, 60)}” ambíguo` : `Responsável “${clean(raw.owner, 60)}” não encontrado` };
    ownerId = hits[0].id;
  }
  const phone = normalizePhone(raw.contactPhone);
  if (phone.error) return { ok: false, reason: `Contato: ${phone.error.toLowerCase()}` };
  const email = normalizeEmail(raw.contactEmail);
  if (email.error) return { ok: false, reason: `Contato: ${email.error.toLowerCase()}` };
  const contactName = clean(raw.contactName, 200) || null;
  return { ok: true, value: { title, value, expectedClose, stageId, ownerId, contact: phone.value || email.value || contactName ? { name: contactName, phone: phone.value, email: email.value } : null } };
}

// ---------------------------------------------------------------------------------------------
// Mapeamento de colunas
// ---------------------------------------------------------------------------------------------

export const CONTACT_FIELDS = [
  { key: 'name', label: 'Nome', required: true, hints: ['nome', 'nome completo', 'name', 'contato', 'cliente', 'full name'] },
  { key: 'company', label: 'Empresa', hints: ['empresa', 'company', 'organizacao', 'razao social', 'organization'] },
  { key: 'phone', label: 'Telefone (WhatsApp)', hints: ['telefone', 'celular', 'whatsapp', 'phone', 'fone', 'tel', 'mobile', 'telefone celular'] },
  { key: 'email', label: 'E-mail', hints: ['email', 'e-mail', 'mail', 'e mail'] },
  { key: 'source', label: 'Origem', hints: ['origem', 'source', 'fonte', 'canal'] },
];
export const DEAL_FIELDS = [
  { key: 'title', label: 'Título do negócio', required: true, hints: ['titulo', 'negocio', 'nome do negocio', 'deal', 'oportunidade', 'nome'] },
  { key: 'contactName', label: 'Contato (nome)', hints: ['contato', 'cliente', 'nome do contato', 'contact'] },
  { key: 'contactPhone', label: 'Contato (telefone)', hints: ['telefone', 'celular', 'whatsapp', 'phone', 'fone'] },
  { key: 'contactEmail', label: 'Contato (e-mail)', hints: ['email', 'e-mail', 'mail'] },
  { key: 'value', label: 'Valor', hints: ['valor', 'preco', 'value', 'receita', 'total', 'valor total'] },
  { key: 'stage', label: 'Etapa', hints: ['etapa', 'fase', 'stage', 'estagio'] },
  { key: 'expectedClose', label: 'Previsão de fechamento', hints: ['previsao', 'previsao de fechamento', 'data de fechamento', 'fechamento', 'close date', 'data prevista'] },
  { key: 'owner', label: 'Responsável (e-mail ou nome)', hints: ['responsavel', 'dono', 'owner', 'vendedor', 'atendente'] },
];

/** Chute de qual coluna do arquivo é cada campo (cabeçalho igual a uma dica; senão, que contém a dica). Uma coluna serve a um campo só. */
export function guessMapping(headers, fields) {
  const folded = headers.map(fold);
  const used = new Set();
  const out = {};
  for (const pass of ['exact', 'partial']) {
    for (const f of fields) {
      if (out[f.key] !== undefined) continue;
      const i = folded.findIndex((h, idx) => !used.has(idx) && h && f.hints.some((hint) => (pass === 'exact' ? h === hint : h.includes(hint) && hint.length >= 4)));
      if (i !== -1) {
        out[f.key] = i;
        used.add(i);
      }
    }
  }
  return out;
}

/** Linha do arquivo + mapeamento → objeto cru por campo. */
export const rowToRaw = (cells, mapping) => Object.fromEntries(Object.entries(mapping).map(([key, i]) => [key, i === undefined || i === null || i < 0 ? '' : cells[i] ?? '']));
