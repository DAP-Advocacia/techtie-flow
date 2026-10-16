'use strict';
// BaileysChannel: liga o gateway herdado do DapZap (src/sessions.js + src/whatsapp.js, com as
// lições de produção: fila de pareamento, backoff, sync de histórico limitado) ao banco do
// TechTie Flow. Cada número (instância) é uma sessão `<tenantId>_<instanceId>`.
// A interface que o resto do sistema usa é só esta: connect / disconnect / sendText / state.
// (O CloudApiChannel terá a mesma forma — ver README, decisões de produto.)
const { SessionManager } = require('../sessions');
const { ingestMessage, updateMessageStatus, setInstanceStatus } = require('./ingest');

const SESSION_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const parseSession = (sid) => {
  const m = SESSION_RE.exec(sid);
  return m ? { tenantId: m[1].toLowerCase(), instanceId: m[2].toLowerCase() } : null;
};
const sessionId = (i) => `${i.tenantId}_${i.id}`;

// estados do gateway → estados do banco/tela
const DB_STATUS = { queued: 'queued', connecting: 'connecting', online: 'connected', offline: 'disconnected' };

function createBaileysChannel({ pool, config, notify, ai }) {
  const deps = { pool, notify, ai };
  const qrs = new Map(); // sessionId → último QR (data URL)
  const attached = new Set();
  const historyLane = new Map(); // sessionId → cadeia de promessas (histórico processado em série)
  const inHistoryLane = (sid, job) => {
    const next = (historyLane.get(sid) || Promise.resolve()).then(job, job).catch(() => {});
    historyLane.set(sid, next);
    return next;
  };

  const fail = (what) => (err) => console.error(`[baileys] ${what}:`, err.message);

  const manager = new SessionManager({
    baseFolder: config.authFolder,
    isCardGroup: async () => false, // TechTie Flow: grupos nunca viram conversa
    onStatus: (sid, status) => {
      const who = parseSession(sid);
      if (!who) return;
      let phone;
      if (status === 'offline') qrs.delete(sid); // QR de uma sessão que caiu está vencido
      if (status === 'online') {
        qrs.delete(sid);
        const jid = manager.getActiveGateway(sid)?.sock?.user?.id; // "5511999990000:12@s.whatsapp.net"
        phone = jid ? String(jid).split('@')[0].split(':')[0].replace(/\D/g, '') : undefined;
      }
      const qr = qrs.get(sid);
      setInstanceStatus(deps, { ...who, status: qr && status === 'connecting' ? 'qr' : DB_STATUS[status] || 'disconnected', phone, qr }).catch(fail('status'));
    },
    onMessage: (sid, phone, message, pushName, isHistory) => {
      const who = parseSession(sid);
      if (!who) return;
      const job = () => ingestMessage(deps, { ...who, phone, pushName, isHistory, message }).catch(fail('mensagem'));
      if (isHistory) inHistoryLane(sid, job);
      else job();
    },
    onMessageStatus: (sid, _phone, messageId, status) => {
      const who = parseSession(sid);
      if (who) updateMessageStatus(deps, { tenantId: who.tenantId, waMessageId: messageId, status }).catch(fail('status da mensagem'));
    },
  });

  /** O SessionManager não repassa o evento 'qr': anexamos uma vez por sessão. */
  function attach(sid, gateway) {
    if (attached.has(sid)) return;
    attached.add(sid);
    gateway.on('qr', (dataUrl) => {
      const who = parseSession(sid);
      if (!who) return;
      qrs.set(sid, dataUrl);
      setInstanceStatus(deps, { ...who, status: 'qr', qr: dataUrl }).catch(fail('qr'));
    });
  }

  return {
    manager,
    async connect(instance) {
      const sid = sessionId(instance);
      const gateway = manager.get(sid); // cria e coloca na fila de pareamento (máx. MAX_CONCURRENT_PAIRINGS)
      attach(sid, gateway);
      return { status: DB_STATUS[gateway.getStatus()] || 'connecting' };
    },
    async disconnect(instance) {
      const sid = sessionId(instance);
      qrs.delete(sid);
      attached.delete(sid);
      await manager.remove(sid); // desconecta e apaga as credenciais: para reconectar é preciso novo QR
      const who = parseSession(sid);
      if (who) await setInstanceStatus(deps, { ...who, status: 'disconnected' });
    },
    async sendText(instance, phone, text) {
      const gateway = manager.getActiveGateway(sessionId(instance));
      if (!gateway || gateway.getStatus() !== 'online') throw Object.assign(new Error('O WhatsApp deste número não está conectado.'), { status: 409 });
      return gateway.sendMessage(String(phone).replace(/\D/g, ''), text);
    },
    /** Há sessão viva (em memória) para este número? Usado para não mostrar "QR" de uma sessão que já morreu. */
    has(instance) {
      return !!manager.getActiveGateway(sessionId(instance));
    },
    state(instance) {
      const sid = sessionId(instance);
      const g = manager.getActiveGateway(sid);
      const qr = (g ? qrs.get(sid) || g.getLastQr() : null) || null;
      const raw = g ? DB_STATUS[g.getStatus()] || 'disconnected' : 'disconnected';
      // O gateway fica em 'connecting' enquanto espera a leitura do QR; para a tela isso é 'qr'.
      // (Sem esta regra, a consulta de segurança de 3 s apagava o QR da tela logo depois de aparecer.)
      return { status: raw === 'connecting' && qr ? 'qr' : raw, qr: raw === 'connected' ? null : qr };
    },
    /** No boot: retoma, escalonado, as sessões já pareadas que estão em disco. */
    resumeAll() {
      return manager.startAllExisting().catch(fail('retomada de sessões'));
    },
    parseSession,
  };
}

module.exports = { createBaileysChannel, parseSession };
