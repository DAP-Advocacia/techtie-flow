const fs = require('fs');
const path = require('path');
const { WhatsAppGateway } = require('./whatsapp');

/**
 * Gerencia VÁRIAS sessões de WhatsApp — uma por instância conectada,
 * potencialmente de tenants diferentes (SaaS multi-tenant).
 * Cada sessão tem sua própria pasta de credenciais em <baseFolder>/<sessionId>,
 * então cada instância conecta o próprio número escaneando o QR dela.
 *
 * O sessionId deve identificar unicamente a instância dentro do tenant
 * (ex: `${tenantId}_${instanceId}`) e é usado como nome de pasta, por isso é
 * sanitizado para evitar path traversal.
 */

function sanitize(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

class SessionManager {
  constructor({ baseFolder, onStatus, onMessage, onReaction, onMessageStatus, onPresence, onContact, isCardGroup }) {
    this.baseFolder = baseFolder;
    this.onStatus = onStatus; // (sessionId, status) => void
    this.onMessage = onMessage; // (sessionId, phone, message, pushName, isHistory, senderPhone, senderName) => void
    this.onReaction = onReaction; // (sessionId, phone, targetId, emoji, direction) => void
    this.onMessageStatus = onMessageStatus; // (sessionId, phone, messageId, status) => void
    this.onPresence = onPresence; // (sessionId, phone, state) => void
    // Nome de contato vindo direto da agenda do WhatsApp (contacts.upsert/
    // update ao vivo, ou a lista `contacts` dentro do backfill de
    // histórico) — diferente de onMessage/pushName, que só vem em mensagem
    // NOVA recebida (nunca em histórico). Ver WhatsAppGateway._extractContactInfo.
    this.onContact = onContact; // (sessionId, phone, name) => void
    // Repassado direto pro construtor de cada WhatsAppGateway (ver
    // whatsapp.js) — decide se uma mensagem de grupo é "de card" (feature
    // de Negócio) ou deve continuar sendo descartada, comportamento padrão
    // de sempre. Opcional — WhatsAppGateway já tem um default seguro.
    this.isCardGroup = isCardGroup;
    this.sessions = new Map(); // sessionId -> WhatsAppGateway

    // Fila de pareamento (2026-10-05) — mesma motivação do STAGGER_MS em
    // startAllExisting() (incidente de 31/07/2026: várias conexões abrindo
    // no mesmo instante parecem login em massa pro WhatsApp, que reage
    // deslogando sessões), mas cobrindo o OUTRO caminho que dispara
    // start(): alguém abrindo a tela de Conexões pela primeira vez (GET
    // /qr -> este get()). Sem fila aqui, uma campanha avisando "conecte
    // seu WhatsApp" fazia dezenas de pessoas chegarem nesta rota ao mesmo
    // tempo, cada uma disparando um handshake Noise + sync de histórico
    // simultâneo — saturava o único core do event loop e deixava até telas
    // sem relação nenhuma (Chat de quem já estava conectado) lentas.
    //
    // `get()` continua SÍNCRONO e retornando o gateway na hora — o
    // polling do frontend (GET /qr a cada 2.5s) depende de já existir um
    // objeto com getStatus()/getLastQr() desde a primeira chamada. O que
    // fica na fila é só a CHAMADA de start() (o trabalho pesado de
    // verdade); enquanto espera vaga, gateway.getStatus() devolve
    // 'queued' (ver WhatsAppGateway, novo status só pra isso).
    this.pairingQueue = [];
    this.activePairings = 0;
    this.maxConcurrentPairings = Number(process.env.MAX_CONCURRENT_PAIRINGS || 4);
  }

  _runPairingQueue() {
    while (this.activePairings < this.maxConcurrentPairings && this.pairingQueue.length) {
      const gateway = this.pairingQueue.shift();
      this.activePairings++;
      gateway.status = 'connecting'; // sai de 'queued' assim que o start() real começa
      gateway
        .start()
        .catch((err) => console.error(`[whatsapp:${gateway.sessionId}] falha ao iniciar sessão:`, err.message))
        .finally(() => {
          this.activePairings--;
          this._runPairingQueue();
        });
    }
  }

  _enqueuePairing(gateway) {
    gateway.status = 'queued';
    this.pairingQueue.push(gateway);
    this._runPairingQueue();
  }

  /**
   * Devolve (criando e iniciando se necessário) o gateway daquele usuário.
   * Iniciar gera um QR novo caso ainda não exista sessão pareada na pasta.
   */
  get(sessionId) {
    const id = sanitize(sessionId);
    if (!id) throw new Error('sessão inválida');
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id);
      // Sem isso, uma sessão deslogada pelo celular fica "morta" pra sempre —
      // requestFreshQr() não faz nada se ela não estiver deslogada, então é
      // seguro chamar em todo acesso (cada /qr, /status, /send, etc.).
      existing.requestFreshQr().catch((err) =>
        console.error(`[whatsapp:${id}] falha ao reiniciar sessão deslogada:`, err.message)
      );
      return existing;
    }

    const gateway = new WhatsAppGateway({
      authFolder: path.join(this.baseFolder, id),
      sessionId: id,
      isCardGroup: this.isCardGroup,
    });
    gateway.on('status', (status) => this.onStatus(id, status));
    gateway.on('message', ({ phone, message, pushName, isHistory, senderPhone, senderName }) =>
      this.onMessage(id, phone, message, pushName, isHistory, senderPhone, senderName)
    );
    gateway.on('reaction', ({ phone, targetId, emoji, direction }) => this.onReaction?.(id, phone, targetId, emoji, direction));
    gateway.on('messageStatus', ({ phone, messageId, status }) => this.onMessageStatus?.(id, phone, messageId, status));
    gateway.on('presence', ({ phone, state }) => this.onPresence?.(id, phone, state));
    gateway.on('contact', ({ phone, name }) => this.onContact?.(id, phone, name));
    this._enqueuePairing(gateway);

    this.sessions.set(id, gateway);
    return gateway;
  }

  /**
   * Desconecta e apaga uma sessão (usado ao remover uma instância). Some do
   * mapa em memória e limpa a pasta de credenciais em disco.
   */
  async remove(sessionId) {
    const id = sanitize(sessionId);
    const gateway = this.sessions.get(id);
    if (gateway) {
      await gateway.disconnect();
      this.sessions.delete(id);
      return;
    }
    const folder = path.join(this.baseFolder, id);
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  /**
   * No boot do servidor, reinicia todas as sessões que já têm credenciais
   * salvas em disco — assim usuários já pareados voltam a receber mensagens
   * mesmo sem ninguém ter aberto a aba ainda.
   *
   * Escalonado (um a cada STAGGER_MS, não tudo de uma vez): abrir dezenas de
   * conexões WebSocket pro WhatsApp no mesmo instante parece pro WhatsApp um
   * padrão de login em massa a partir do mesmo processo/IP, e a defesa
   * anti-abuso deles reage derrubando (deslogando) sessões — foi o que
   * causou o incidente de 31/07/2026 (instância 183168 e outras deslogadas
   * após um deploy). Um delay entre cada reconexão evita esse pico.
   */
  async startAllExisting() {
    if (!fs.existsSync(this.baseFolder)) return;
    const STAGGER_MS = Number(process.env.SESSION_STAGGER_MS || 15000);
    const entries = fs.readdirSync(this.baseFolder, { withFileTypes: true });
    // `creds.registered` (Baileys, ver initAuthCreds) só vira true DEPOIS do
    // QR ser escaneado com sucesso — antes disso, creds.json já existe (o
    // Baileys grava as chaves de criptografia assim que a sessão é aberta,
    // mesmo sem ninguém ter escaneado nada) mas não representa uma sessão
    // de verdade, só um QR gerado e nunca pareado. Sem este filtro, cada
    // "Conectar outro WhatsApp" abandonado no meio do caminho virava uma
    // pasta que o boot tentava reconectar pra sempre — encontrado um
    // acúmulo real de centenas dessas pastas (meses de QRs nunca
    // escaneados), sobrecarregando CPU/rede a cada boot e, no caso mais
    // grave, levando o WhatsApp a atrasar/recusar até pareamentos NOVOS
    // vindos do mesmo IP (mesmo padrão do incidente de 31/07 documentado
    // acima, só que em escala muito maior).
    let skippedUnregistered = 0;
    const pending = entries.filter((entry) => {
      if (!entry.isDirectory()) return false;
      const credsPath = path.join(this.baseFolder, entry.name, 'creds.json');
      if (!fs.existsSync(credsPath)) return false;
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        if (!creds.registered) {
          skippedUnregistered++;
          return false;
        }
        return true;
      } catch {
        // creds.json corrompido/ilegível — mesmo espírito de "não é uma
        // sessão de verdade utilizável", não tenta reconectar.
        skippedUnregistered++;
        return false;
      }
    });
    if (skippedUnregistered > 0) {
      console.log(`[sessions] ignorando ${skippedUnregistered} sessão(ões) nunca pareada(s) (QR gerado, nunca escaneado)`);
    }
    console.log(`[sessions] retomando ${pending.length} sessão(ões) salva(s), escalonado a cada ${STAGGER_MS}ms`);
    for (const entry of pending) {
      console.log(`[sessions] retomando sessão salva: ${entry.name}`);
      this.get(entry.name);
      if (entry !== pending[pending.length - 1]) {
        await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
      }
    }
  }

  /**
   * Lista as sessões que JÁ estão em memória (conectadas ou não), sem criar
   * nenhuma sessão nova — diferente de `get()`, que cria+inicia se ainda não
   * existir. Usado por diagnósticos que precisam de um socket Baileys
   * REALMENTE conectado (ex: resolver LID->telefone via
   * signalRepository.lidMapping) sem o risco de iniciar uma conexão nova só
   * de tentar ler o estado (HANDOFF Parte CP — investigação das conversas
   * antigas com telefone LID cru).
   */
  listActive() {
    return Array.from(this.sessions.entries()).map(([id, gateway]) => ({
      sessionId: id,
      status: gateway.getStatus(),
      hasSock: !!gateway.sock,
    }));
  }

  /**
   * Devolve o gateway já em memória (SEM criar/iniciar nada) — companheiro
   * de `listActive()` pra quando o diagnóstico já confirmou que a sessão
   * está online e precisa do objeto de verdade (ex: chamar
   * `resolveLidToPhone`). `undefined` se não estiver em memória.
   */
  getActiveGateway(sessionId) {
    return this.sessions.get(sanitize(sessionId));
  }
}

module.exports = { SessionManager, sanitize };
