// Ponte entre a tela Inbox e o motor de permissões (access.js). A tela NÃO tem
// regra própria: tudo aqui só pergunta ao motor (decide / visible / fieldLevel / mask)
// e devolve um formato fácil de desenhar. Se o perfil mudar, a tela muda junto.
import { visible, decide, can, mask, fieldLevel, denyMessage } from '../../access.js';

/** Texto que substitui um campo oculto pelo perfil (nunca carrega o valor real). */
export const HIDDEN = '••• oculto';
export const HIDDEN_HINT = 'Campo oculto pelo seu perfil de acesso';

/** ÚNICA fonte de conversas da tela: só o que o usuário pode ler. */
export const visibleConvs = (store) => visible('conversation', store.state.conversations);

const verdict = (d) => ({ ok: d.effect === 'allow', effect: d.effect, reason: d.reason, msg: d.effect === 'allow' ? '' : denyMessage(d) });

/** Decisão do motor para uma ação sobre a conversa: { ok, effect, reason, msg }. */
export const decision = (action, conv) => verdict(decide('conversation', action, conv));

/** Ações da conversa que a tela gateia. */
export function convAccess(conv) {
  return {
    send: decision('send_message', conv),
    note: decision('note', conv),
    transfer: decision('transfer', conv),
    resolve: decision('resolve', conv),
  };
}

/** Responsável quando a conversa é de OUTRA pessoa (nem minha, nem da fila); senão null. */
export function otherAssignee(store, conv) {
  const s = store.state;
  if (!conv?.assigneeId || conv.assigneeId === s.currentUserId) return null;
  return store.userById(conv.assigneeId) || { id: conv.assigneeId, name: 'outro usuário' };
}

/** Resumo para o composer: o que cada aba pode e qual aviso de contexto mostrar. */
export function composerAccess(store, conv, access, firstName) {
  const other = otherAssignee(store, conv);
  let notice = '';
  if (!access.send.ok && !access.note.ok) {
    const noActions = !access.transfer.ok && !access.resolve.ok;
    notice = noActions
      ? 'Somente leitura — seu perfil não permite responder.'
      : other
        ? `Supervisionando a conversa de ${firstName(other.name)} — seu perfil não permite responder.`
        : 'Seu perfil não permite responder nesta conversa.';
  } else if (!access.send.ok) {
    notice = 'Seu perfil não permite responder ao contato — apenas notas internas.';
  } else if (!access.note.ok) {
    notice = 'Seu perfil não permite criar notas internas nesta conversa.';
  }
  return { send: access.send, note: access.note, notice };
}

/**
 * Destinos válidos de transferência: usuários ativos que PODEM ler e responder a
 * conversa no destino (o motor decide com o usuário do destino). O Agente de IA
 * (bot) não tem perfil no motor, então só entra pelo fato de existir e estar ativo.
 * `staysVisible`: a conversa continua na MINHA lista depois de transferir?
 */
export function transferTargets(store, conv) {
  const s = store.state;
  return s.users
    .filter((u) => u.status === 'active' && u.tenantId === s.tenant.id)
    .filter((u) => {
      if (u.isBot) return true;
      const at = { ...conv, assigneeId: u.id, teamId: undefined };
      return can('conversation', 'read', at, undefined, u.id) && can('conversation', 'send_message', at, undefined, u.id);
    })
    .map((u) => ({
      user: u,
      current: u.id === conv.assigneeId,
      staysVisible: can('conversation', 'read', { ...conv, assigneeId: u.id, teamId: undefined }),
    }));
}

/** Depois de devolver à fila, ainda vejo a conversa? */
export const staysVisibleInQueue = (conv) => can('conversation', 'read', { ...conv, assigneeId: null, teamId: undefined });

/** Negócio só existe para a tela se o usuário pode lê-lo. */
export const canReadDeal = (deal) => !!deal && can('deal', 'read', deal);

/** Nível do campo ('write' | 'readonly' | 'hidden'). */
export const isHidden = (entity, field) => fieldLevel(entity, field) === 'hidden';

/** Contato sem os campos ocultos (para exibir e para buscar). */
export const maskedContact = (contact) => (contact ? mask('contact', contact) : null);
