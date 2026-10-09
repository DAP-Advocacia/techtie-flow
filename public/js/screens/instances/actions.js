// Mutações de instâncias no store (única porta de escrita da tela) e o
// complemento local dos dados mock.
import { store } from '../../store.js';
import { generatePhone } from './channels.js';
import { audit } from '../../access.js';
import { check } from '../_ops/perm.js';

let seeded = false;

/**
 * Completa o mock sem tocar em data.js: defaults de campos e UMA instância em
 * 'attention' (número restrito, 403) para o estado "precisa de ação manual".
 * Roda uma vez por carga da página (o módulo persiste entre navegações), assim
 * remover a instância de exemplo não faz ela reaparecer ao voltar à tela.
 */
export function seedInstances() {
  if (seeded) return;
  seeded = true;
  store.update((s) => {
    for (const i of s.instances) {
      i.channel ??= 'baileys';
      i.conversations ??= 0;
      i.messagesToday ??= 0;
      i.aiActive ??= false;
      i.ownerName ??= '';
    }
    if (!s.instances.some((i) => i.status === 'attention' || i.id === 'i_financeiro')) {
      s.instances.push({
        id: 'i_financeiro',
        name: 'Financeiro',
        phone: '+55 11 4000-4040',
        ownerName: 'Marina Alves',
        channel: 'baileys',
        status: 'attention',
        attentionReason: 'forbidden',
        conversations: 41,
        messagesToday: 0,
        aiActive: false,
      });
    }
  });
}

export const findInstance = (id) => store.state.instances.find((i) => i.id === id);

/**
 * `entity`/`action`: permissão exigida (padrão instance.update). `event`/`detail`: auditoria.
 * Devolve false (sem gravar, sem lançar) se o motor negar ou a instância não existir.
 */
export function updateInstance(id, fn, { entity = 'instance', action = 'update', event, detail } = {}) {
  if (!check(entity, action).ok) return false;
  let found = false;
  store.update((s) => {
    const i = s.instances.find((x) => x.id === id);
    if (i) {
      fn(i);
      found = true;
    }
  });
  if (found && event) audit(event, id, detail);
  return found;
}

/** Devolve a nova instância, ou null se o motor negar `instance.create`. */
export function addInstance({ name, channel, ownerName, phone }) {
  if (!check('instance', 'create').ok) return null;
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  const inst = {
    id: `i_${slug || 'num'}_${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    phone: phone || generatePhone(name, store.state.instances),
    ownerName,
    channel,
    status: 'connected',
    conversations: 0,
    messagesToday: 0,
    aiActive: false,
  };
  store.update((s) => {
    s.instances.push(inst);
  });
  audit('instance.create', inst.id, `Instância "${inst.name}" (${inst.channel === 'cloud_api' ? 'API oficial' : 'QR Code'}, ${inst.phone}) conectada`);
  return inst;
}

/** Reconexão: exige instance.connect. */
export function markConnected(id) {
  const name = findInstance(id)?.name ?? id;
  return updateInstance(
    id,
    (i) => {
      i.status = 'connected';
      delete i.attentionReason;
    },
    { action: 'connect', event: 'instance.connect', detail: `Instância "${name}" reconectada` }
  );
}

/** Remove a instância (exige instance.delete). Devolve true se removeu. */
export function removeInstance(id) {
  const inst = findInstance(id);
  if (!inst || !check('instance', 'delete').ok) return false;
  store.update((s) => {
    s.instances = s.instances.filter((i) => i.id !== id);
  });
  audit('instance.delete', id, `Instância "${inst.name}" (${inst.phone || 'sem número'}) removida`);
  return true;
}

/**
 * Outros pontos do produto que apontam para a instância (Agente de IA e
 * automações com a instância escolhida). Remover deixaria o apontamento solto.
 */
export function usageNotes(id) {
  const s = store.state;
  const notes = [];
  if (s.agent?.instanceId === id) notes.push('o Agente de IA está ativo neste número (troque a instância em Agente de IA)');
  const autos = (s.automations || []).filter((a) => (a.nodes || []).some((n) => n.params?.instanceId === id)).length;
  if (autos) notes.push(`${autos} ${autos === 1 ? 'automação usa' : 'automações usam'} este número como gatilho`);
  return notes;
}

/** Conversas da Inbox que apontam para esta instância (impede remover deixando órfãs). */
export const conversationsUsing = (id) => store.state.conversations.filter((c) => c.instanceId === id).length;
