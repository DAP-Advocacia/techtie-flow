// Importar e exportar CSV — permissões e execução. Em operação o servidor decide e grava (src/api/routes-import.js, com as MESMAS
// regras de shared/import/rules.js da prévia); no protótipo aplica no navegador com essas mesmas regras e o mesmo formato de resposta.
import { store } from '../../store.js';
import { decide, audit, visible } from '../../access.js';
import * as live from '../../live.js';
import * as PA from '../pipeline/actions.js';
import { MAX_ROWS, planContacts, validateDeal, fold, normalizePhone } from '/shared/import/rules.js';

const me = () => store.state.currentUserId;
const myRow = () => ({ ownerId: me(), teamId: store.user()?.teamIds?.[0] ?? null });

/** Pode exportar esta lista? (o motor confere, inclusive o limite por quantidade de linhas, se o perfil tiver) */
export const canExport = (entity, rowCount = 0) => decide(entity, 'export', myRow(), { rowCount }).effect === 'allow';
/** Pode importar? Importar contatos exige também criar contatos; negócios, importar negócios. */
export const canImport = (entity) => decide(entity, 'import', myRow(), { rowCount: 1 }).effect === 'allow' && (entity !== 'contact' || decide('contact', 'create', myRow()).effect === 'allow');
export { MAX_ROWS };

/** Registra a exportação (auditoria) ANTES de baixar. { ok } ou { ok:false, error }. */
export async function logExport(entity, count) {
  if (!canExport(entity, count)) return { ok: false, error: 'Seu perfil não permite exportar.' };
  try {
    if (live.enabled) await live.logExport(entity, count);
    else audit(`${entity}.export`, entity, `Exportação em CSV de ${count} ${entity === 'contact' ? 'contatos' : 'negócios'}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'Não foi possível exportar.' };
  }
}

const digits = (s) => String(s || '').replace(/\D/g, '');

/** Telefones e e-mails que já existem (no protótipo, os contatos que o usuário enxerga são todos os que o servidor mostraria). */
export function existingContacts() {
  const all = store.state.contacts;
  return { phones: new Set(all.map((c) => normalizePhone(c.phone).value).filter(Boolean)), emails: new Set(all.map((c) => String(c.email || '').trim().toLowerCase()).filter(Boolean)) };
}

/** @returns {Promise<{ ok, created, skipped: {line, reason}[], skippedTotal, contactsCreated? , error? }>} */
export async function importContacts(rows) {
  if (!canImport('contact')) return { ok: false, error: 'Seu perfil não permite importar contatos.' };
  if (!rows.length || rows.length > MAX_ROWS) return { ok: false, error: rows.length ? `Importe até ${MAX_ROWS} linhas por vez.` : 'Não há linhas para importar.' };
  try {
    if (live.enabled) return { ok: true, ...(await live.importContacts(rows)) };
    const plan = planContacts(rows, existingContacts());
    store.update((s) => {
      for (const { value: v } of plan.create) s.contacts.push({ id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: v.name, company: v.company || '', phone: v.phone ? `+${v.phone}` : '', email: v.email || '', ownerId: me(), source: v.source, tags: [], createdAt: Date.now() });
    });
    audit('contact.import', 'contact', `Importação de contatos: ${plan.create.length} criados, ${plan.skipped.length} de fora`);
    return { ok: true, created: plan.create.length, skipped: plan.skipped, skippedTotal: plan.skipped.length };
  } catch (e) {
    return { ok: false, error: e.message || 'Não foi possível importar.' };
  }
}

/** Contexto para validar negócios: etapas do funil e pessoas ativas. */
export const dealContext = (pipeline) => ({ stages: (pipeline?.stages || []).map((s) => ({ id: s.id, name: s.name, kind: s.kind || 'open' })), users: store.state.users.filter((u) => !u.isBot && u.status === 'active').map((u) => ({ id: u.id, name: u.name, email: u.email })) });

export async function importDeals(pipeline, rows) {
  if (!canImport('deal')) return { ok: false, error: 'Seu perfil não permite importar negócios.' };
  if (!rows.length || rows.length > MAX_ROWS) return { ok: false, error: rows.length ? `Importe até ${MAX_ROWS} linhas por vez.` : 'Não há linhas para importar.' };
  try {
    if (live.enabled) return { ok: true, ...(await live.importDeals(pipeline.id, rows)) };
    const ctx = dealContext(pipeline);
    const readable = visible('contact', store.state.contacts);
    const skipped = [];
    let created = 0;
    let contactsCreated = 0;
    for (const raw of rows) {
      const skip = (reason) => skipped.push({ line: raw.line, reason });
      const v = validateDeal(raw, ctx);
      if (!v.ok) {
        skip(v.reason);
        continue;
      }
      const d = v.value;
      let contactId = null;
      let newContact = null;
      if (d.contact) {
        const k = d.contact;
        const hit = readable.find((c) => (k.phone && normalizePhone(c.phone).value === k.phone) || (k.email && String(c.email || '').toLowerCase() === k.email)) || (!k.phone && !k.email && k.name ? readable.find((c) => fold(c.name) === fold(k.name)) : null);
        if (hit) contactId = hit.id;
        else if (k.phone && store.state.contacts.some((c) => digits(c.phone) === k.phone)) {
          skip('O contato já existe, mas você não pode vê-lo para ligar o negócio');
          continue;
        } else newContact = { name: k.name || k.email || `+${k.phone}`, phone: k.phone ? `+${k.phone}` : '', email: k.email || '' };
      }
      const r = PA.createDeal({ title: d.title, contactId, newContact, value: d.value ?? 0, ownerId: d.ownerId || me(), pipelineId: pipeline.id, stageId: d.stageId });
      if (!r.ok) {
        skip('Seu perfil não permite criar este negócio (responsável, funil ou etapa)');
        continue;
      }
      if (d.expectedClose) PA.editDeal(r.deal.id, { expectedClose: d.expectedClose });
      created++;
      if (newContact) contactsCreated++;
    }
    audit('deal.import', 'deal', `Importação de negócios em ${pipeline.name}: ${created} criados, ${skipped.length} de fora`);
    return { ok: true, created, contactsCreated, skipped, skippedTotal: skipped.length };
  } catch (e) {
    return { ok: false, error: e.message || 'Não foi possível importar.' };
  }
}
