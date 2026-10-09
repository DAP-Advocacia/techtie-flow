// Simulação do pareamento do WhatsApp (Baileys) com os estados REAIS do gateway
// (docs/whatsapp-gateway-licoes-herdadas.md §2): a sessão nova entra numa fila
// com concorrência máxima ('queued' — "aguarde, sua vez está chegando", NÃO é
// erro), só então abre o socket ('connecting') e mostra o QR, que expira.
//
//   idle -> queued -> connecting -> qr -> (expired) -> syncing -> connected
//
// 'expired' + regenerate() NÃO volta pra fila: a vaga de pareamento já é nossa.
// Todos os timers vivem aqui dentro; destroy() limpa tudo (chamado na saída da tela).

const QUEUE_STEP_MS = 1100; // quanto tempo cada posição da fila "anda"
const CONNECT_MS = 1500; // abrir o socket e obter o primeiro QR
const REGEN_MS = 900; // novo QR dentro da mesma vaga
const SYNC_MS = 1800; // importação das conversas recentes após ler o QR
export const QR_TTL_S = 45; // o QR do WhatsApp real vence em ~20-60s

export function createPairing({ queueSize = 3 } = {}) {
  let snap = { phase: 'idle', position: 0, queueTotal: queueSize, seed: 0, remaining: 0, phone: '' };
  let seedCounter = 0;
  let tickId = null;
  const timers = new Set();
  const subs = new Set();

  const emit = () => subs.forEach((fn) => fn({ ...snap }));
  const set = (patch) => {
    snap = { ...snap, ...patch };
    emit();
  };
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };
  function clearAll() {
    timers.forEach(clearTimeout);
    timers.clear();
    clearInterval(tickId);
    tickId = null;
  }

  function showQr() {
    seedCounter += 1;
    set({ phase: 'qr', seed: 0x51a9 + seedCounter * 7919, remaining: QR_TTL_S });
    tickId = setInterval(() => {
      const remaining = snap.remaining - 1;
      if (remaining <= 0) {
        clearInterval(tickId);
        tickId = null;
        set({ phase: 'expired', remaining: 0 });
      } else set({ remaining });
    }, 1000);
  }

  function advanceQueue() {
    if (snap.position <= 1) {
      set({ phase: 'connecting', position: 0 });
      later(showQr, CONNECT_MS);
    } else {
      set({ position: snap.position - 1 });
      later(advanceQueue, QUEUE_STEP_MS);
    }
  }

  return {
    snapshot: () => ({ ...snap }),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** Entra na fila de pareamento. Sem efeito se já estiver conectado. */
    start() {
      if (snap.phase === 'connected') return;
      clearAll();
      set({ phase: 'queued', position: queueSize, queueTotal: queueSize });
      later(advanceQueue, QUEUE_STEP_MS);
    },
    /** "Gerar novo QR": mesma vaga, sem passar pela fila. */
    regenerate() {
      if (snap.phase !== 'qr' && snap.phase !== 'expired') return;
      clearAll();
      set({ phase: 'connecting', remaining: 0 });
      later(showQr, REGEN_MS);
    },
    /** Demo: finge que o usuário leu o QR no celular. */
    simulateScan() {
      if (snap.phase !== 'qr') return;
      clearAll();
      set({ phase: 'syncing', remaining: 0 });
      later(() => set({ phase: 'connected', phone: `+55 11 9${1000 + (snap.seed % 8999)}-${1000 + ((snap.seed * 7) % 8999)}` }), SYNC_MS);
    },
    /** Desiste do pareamento em andamento (ex.: escolheu a API oficial). */
    cancel() {
      if (snap.phase === 'connected') return;
      clearAll();
      set({ phase: 'idle', position: 0, remaining: 0 });
    },
    destroy() {
      clearAll();
      subs.clear();
    },
  };
}
