const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  isJidBroadcast,
  isJidNewsletter,
  proto,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const { EventEmitter } = require('events');
const { saveMedia } = require('./media');
const { convertToOggOpus } = require('./audioConvert');

// Teto de tentativas de reconexão CONSECUTIVAS pra um código "temporário"
// (não um dos PERMANENT_CODES abaixo) — ver comentário no handler de
// 'connection.update' (2026-09-30). Com o backoff exponencial até 5min de
// teto, 20 tentativas já passam de 1h30 insistindo — tempo generoso pra
// qualquer instabilidade de rede real se resolver sozinha, mas finito o
// bastante pra não deixar uma sessão morta (número trocado de aparelho,
// instância de teste abandonada) reconectando pra sempre.
const MAX_CONSECUTIVE_FAILURES = Number(process.env.MAX_RECONNECT_ATTEMPTS || 20);

/**
 * Encapsula UMA sessão de WhatsApp pessoal (um número).
 * Emite eventos que o resto da aplicação escuta:
 *   'qr'      -> novo QR Code disponível (data URL base64) para exibir na tela de login
 *   'status'  -> 'queued' | 'connecting' | 'online' | 'offline'
 *     ('queued' é setado de fora, por SessionManager._enqueuePairing — ver
 *     sessions.js — quando start() ainda não foi chamado, esperando vaga na
 *     fila de pareamento. Nunca emitido via this.emit('status', ...) daqui
 *     de dentro, só lido via getStatus(); o polling do frontend trata
 *     'queued' como "aguarde, sua vez está chegando", não como erro.)
 *   'message' -> nova mensagem (recebida), já normalizada
 *
 * AVISO: isto usa o protocolo não-oficial do WhatsApp Web (engenharia reversa via Baileys).
 * Não é a API oficial da Meta. Veja o aviso de risco de banimento já dado na conversa.
 */
class WhatsAppGateway extends EventEmitter {
  constructor({ authFolder, sessionId, isCardGroup }) {
    super();
    this.authFolder = authFolder;
    // Usado só pra prefixar arquivos de mídia salvos (ver saveMedia) — evita
    // colisão de nome quando duas instâncias diferentes geram o mesmo
    // key.id do WhatsApp (o espaço de ids não é coordenado entre contas).
    this.sessionId = sessionId;
    // Consulta se um JID de grupo é "grupo de card" (feature de Negócio, ver
    // wa_groups.source='card') — usado só pelo bypass condicional do
    // descarte de mensagem de grupo, abaixo. Injetado de fora (mesmo
    // espírito de authFolder/sessionId: esta classe não tem NENHUMA
    // dependência de banco, e não deveria passar a ter uma só pra isto —
    // quem instancia decide, via src/sessions.js/src/server.js). Default
    // seguro: nenhum grupo é "de card" até alguém passar a função real —
    // preserva o comportamento de descarte total pra qualquer código que
    // instancie este gateway sem passar essa opção.
    this.isCardGroup = isCardGroup || (async () => false);
    this.sock = null;
    this.status = 'offline';
    this.lastQrDataUrl = null;
    // true quando o WhatsApp encerrou a sessão pelo celular (loggedOut) — nesse
    // estado a sessão fica "morta" pra sempre até alguém chamar requestFreshQr().
    this.loggedOut = false;
    // true quando o WhatsApp recusou a conexão de forma que PARECE permanente
    // (403 forbidden, 440 connectionReplaced — outro dispositivo assumiu) mas
    // sem certeza absoluta de ser definitivo como loggedOut, então NÃO apaga
    // as credenciais sozinho (diferente de loggedOut) — só para de tentar
    // reconectar automaticamente e fica visível pro usuário decidir (ver
    // GET /instances, campo needsAttention). HANDOFF Parte CQ: até aqui,
    // qualquer código que não fosse loggedOut tentava de novo a cada 3s pra
    // sempre — 2 sessões banidas ficaram presas em loop (150 tentativas em 7
    // minutos), sobrecarregando o processo até o Swarm matá-lo (ExitCode
    // 137), o que derrubava TODAS as instâncias do servidor junto, mesmo as
    // saudáveis. Repetir reconexão numa conta já restrita também prolonga o
    // próprio bloqueio do lado do WhatsApp (cada tentativa reseta o timer de
    // cooldown) — parar de insistir sozinho é proteção pro usuário, não só
    // pro servidor.
    this.needsAttention = false;
    this.lastDisconnectReason = null;
    // Contagem de falhas consecutivas (zera ao conectar com sucesso) — usado
    // pro backoff crescente abaixo, segunda camada de proteção contra loop:
    // mesmo um código "temporário" que eu não tenha previsto como permanente
    // (ex: 408/503 batendo repetido) não fica preso em retry fixo de 3s pra
    // sempre, o intervalo cresce até um teto.
    this.consecutiveFailures = 0;
    // Contatos "vistos" via eventos do Baileys (contacts.upsert/update) —
    // Baileys não expõe uma chamada de "contar contatos" nem um snapshot
    // completo da agenda (só incrementos), então isto é um acumulado em
    // memória desde que o processo subiu, não a agenda telefônica real do
    // celular (que pode ter muito mais contatos nunca vistos pelo WhatsApp
    // Web). Zera a cada reinício do processo/reconexão do zero.
    this.contactIds = new Set();
  }

  getContactCount() {
    return this.contactIds.size;
  }

  /**
   * Grupos reais que este número participa (não é a tabela `wa_groups` local,
   * que só guarda grupos CRIADOS por este app) — ver GET /instances em
   * src/routes/whatsapp.js, card de instância. Só funciona com a sessão
   * online; é uma chamada de rede ao WhatsApp (não instantânea).
   */
  async getGroupCount() {
    if (this.status !== 'online' || !this.sock) return null;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      return Object.keys(groups || {}).length;
    } catch {
      return null;
    }
  }

  getStatus() {
    return this.status;
  }

  getLastQr() {
    return this.lastQrDataUrl;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'warn' }),
      // QR só é necessário até o primeiro pareamento; depois disso a sessão fica
      // salva em `authFolder` e o login persiste entre reinícios do processo.
      printQRInTerminal: false,
      // syncFullHistory já é o default (true) — só PEDE o histórico completo
      // ao celular. Quem de fato decide o que chega no evento
      // messaging-history.set é shouldSyncHistoryMessage.
      //
      // REVERTIDO (2026-10-02) — mitigação de risco de ban no 1º pareamento.
      // Caso real reportado: Natasha Teixeira conectou um número com 2169
      // contatos/histórico grande e levou `forbidden` do WhatsApp em menos
      // de 20min (ver instance_connection_events, instanceId ..._45066).
      // syncType FULL é exatamente o sync PROFUNDO (todo o histórico
      // guardado no celular, não só recente) — pra uma conta com muito
      // histórico, isso gera um pico grande de tráfego logo nos primeiros
      // minutos de conexão, um padrão que sistemas de detecção de
      // automação do WhatsApp monitoram. Não dá pra eliminar o risco de
      // ban (Baileys é uma API não-oficial, o WhatsApp pode banir por
      // qualquer motivo a qualquer momento — isso não é um bug deste app),
      // mas bloquear o sync mais pesado reduz um fator real sob nosso
      // controle. RECENT/INITIAL_BOOTSTRAP continuam liberados (trazem
      // conversas em andamento recentes, é o que a maioria dos usuários
      // precisa no dia a dia) — só o FULL (histórico muito antigo) deixa
      // de chegar automaticamente no pareamento. Dedupe por
      // (conversation_id, wa_message_id) em store.addMessage continua
      // cobrindo qualquer mensagem que chegue mais de uma vez.
      shouldSyncHistoryMessage: (msg) => msg.syncType !== proto.HistorySync.HistorySyncType.FULL,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.lastQrDataUrl = await QRCode.toDataURL(qr);
        this.status = 'connecting';
        this.loggedOut = false; // já estamos num pareamento novo, não é mais uma sessão "morta"
        this.emit('qr', this.lastQrDataUrl);
        this.emit('status', this.status);
      }

      if (connection === 'open') {
        this.status = 'online';
        this.lastQrDataUrl = null;
        this.loggedOut = false;
        this.needsAttention = false; // reconectou de verdade -> não é mais um caso "parado"
        this.consecutiveFailures = 0; // zera o backoff, a próxima queda começa do intervalo mínimo de novo
        this.emit('status', this.status);
        console.log('[whatsapp] conectado com sucesso');
      }

      if (connection === 'close') {
        this.status = 'offline';
        this.emit('status', this.status);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        // Códigos que o WhatsApp usa pra recusar de forma que NÃO é queda de
        // rede — insistir reconectando não resolve, só desperdiça e (pior)
        // prolonga o próprio bloqueio do lado do WhatsApp (ver comentário no
        // construtor). forbidden (403): conta restrita/banida ou credencial
        // rejeitada. connectionReplaced (440): outro dispositivo assumiu essa
        // sessão — reconectar aqui brigaria com o outro dispositivo pra
        // sempre. badSession (500): credenciais corrompidas, só resolve com
        // pareamento novo.
        const PERMANENT_CODES = new Set([
          DisconnectReason.forbidden,
          DisconnectReason.connectionReplaced,
          DisconnectReason.badSession,
        ]);
        const isPermanent = PERMANENT_CODES.has(statusCode);
        const sessionLabel = path.basename(this.authFolder);
        const reason = DisconnectReason[statusCode] || 'desconhecido';

        console.warn(
          `[whatsapp:${sessionLabel}] conexão encerrada. statusCode=${statusCode} (${reason}) loggedOut=${loggedOut} isPermanent=${isPermanent}`
        );

        if (loggedOut) {
          // usuário deslogou pelo celular -> as credenciais salvas não servem mais
          // pra reconectar (o WhatsApp já encerrou essa sessão do lado dele).
          // Fica marcado aqui; requestFreshQr() é quem de fato gera um QR novo,
          // chamado a cada acesso à sessão (ver SessionManager.get()).
          this.loggedOut = true;
          console.warn('[whatsapp] sessão encerrada pelo usuário. Aguardando novo login via /qr.');
        } else if (isPermanent) {
          // NÃO apaga credenciais sozinho (diferente de loggedOut acima) —
          // sem certeza se é definitivo, e apagar seria destrutivo demais pra
          // uma decisão automática. Só para de insistir e marca visível pro
          // usuário (ver GET /instances, needsAttention) — precisa de ação
          // manual: reconectar de novo (botão) ou remover a instância.
          this.needsAttention = true;
          this.lastDisconnectReason = reason;
          console.error(
            `[whatsapp:${sessionLabel}] desconexão PERMANENTE (${reason}) — parando de reconectar sozinho, precisa de ação manual.`
          );
        } else if (this.consecutiveFailures + 1 >= MAX_CONSECUTIVE_FAILURES) {
          // Teto de tentativas totais (não só de intervalo entre elas) —
          // achado 2026-09-30: sessões já pareadas um dia mas mortas/
          // inacessíveis (número trocado de aparelho, instância de teste
          // abandonada) caem sempre num código "temporário" (408 timeout),
          // nunca um dos PERMANENT_CODES acima, e ficavam reconectando pra
          // sempre a cada 5min — uma chegou a 142 tentativas (~11h+)
          // seguidas. Com dezenas de sessões assim ao mesmo tempo, é o
          // mesmo padrão de sobrecarga do incidente de sessões nunca
          // pareadas (ver sessions.js::startAllExisting), só que em runtime
          // em vez de no boot — não pegava naquela correção porque estas JÁ
          // tem creds.registered=true. Trata como PERMANENT_CODES: para de
          // insistir sozinho, marca precisando de atenção — não apaga nada
          // (decisão destrutiva demais pra automatizar; usuário decide
          // reconectar manualmente ou remover a instância).
          this.needsAttention = true;
          this.lastDisconnectReason = 'timeout persistente';
          console.error(
            `[whatsapp:${sessionLabel}] ${MAX_CONSECUTIVE_FAILURES} tentativas seguidas sem sucesso — parando de reconectar sozinho, precisa de ação manual.`
          );
        } else {
          // queda de conexão temporária (rede, timeout, etc) -> tenta
          // reconectar usando a sessão salva. Backoff crescente (não fixo em
          // 3s) — proteção contra qualquer código que eu não tenha previsto
          // como permanente também virar loop: 3s, 6s, 12s... até um teto de
          // 5min. Zera ao conectar com sucesso (ver connection === 'open'
          // acima), então uma queda isolada continua reconectando rápido.
          this.consecutiveFailures++;
          const backoffMs = Math.min(3000 * 2 ** (this.consecutiveFailures - 1), 5 * 60 * 1000);
          if (this.consecutiveFailures > 1) {
            console.warn(`[whatsapp:${sessionLabel}] tentativa ${this.consecutiveFailures}, próxima em ${Math.round(backoffMs / 1000)}s`);
          }
          setTimeout(() => this.start(), backoffMs);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const m of messages) {
        const payload = await this._processIncomingMessage(m);
        if (payload) this.emit('message', payload);
      }
    });

    // Histórico de conversas que o próprio WhatsApp manda pro dispositivo —
    // com shouldSyncHistoryMessage sobrescrito acima (aceita todo syncType,
    // incluindo FULL), chega aqui o histórico de verdade, não só uma janela
    // curta recente. Isso significa: ao conectar uma instância NOVA (1º
    // pareamento), pode chegar de uma vez um volume grande de mensagens
    // antigas (semanas/meses) — normal, não é bug; o log abaixo mostra
    // quantas foram processadas por chamada, várias chamadas podem
    // acontecer em sequência até isLatest=true.
    // Reusa o mesmo `_processIncomingMessage` do caminho de mensagem nova
    // (mesmos filtros de status/grupo/newsletter/reação, mesma resolução de
    // telefone) — o dedupe por (conversation_id, wa_message_id) em
    // store.addMessage cobre sozinho o caso de a mesma mensagem chegar de
    // novo depois por messages.upsert.
    this.sock.ev.on('messaging-history.set', async ({ messages, contacts, syncType, isLatest }) => {
      // `contacts` é sempre um array (pode vir vazio) — nome de exibição de
      // cada contato do backfill. Processado ANTES das mensagens de
      // propósito: mensagens de histórico nunca trazem m.pushName (só
      // mensagens ao vivo trazem, ver _processIncomingMessage), então sem
      // isto uma instância nova ficava com N conversas "sem nome" até a
      // PRÓXIMA mensagem ao vivo de cada contato (podendo nunca acontecer)
      // — usuário reportou com print (sessão 2026-08-12, mesmo dia da Parte
      // CR/CS). Emite os nomes primeiro, assim quando as mensagens abaixo
      // criam a conversa (upsertContact, ver src/server.js onMessage) o
      // nome já pode estar disponível, dependendo da ordem de processamento
      // no consumidor — mas não é uma garantia forte, upsertContact tem que
      // funcionar OK dos dois lados de qualquer ordem (coalesce, não
      // sobrescreve com vazio).
      for (const c of contacts || []) {
        try {
          const info = await this._extractContactInfo(c);
          if (info) this.emit('contact', info);
        } catch (err) {
          console.error('[whatsapp] falha ao extrair nome de contato do histórico:', err.message);
        }
      }

      if (!messages?.length) return;

      let saved = 0;
      for (const m of messages) {
        const payload = await this._processIncomingMessage(m, { isHistory: true });
        if (payload) {
          this.emit('message', payload);
          saved++;
        }
      }
      console.log(
        `[whatsapp] histórico recebido: ${saved}/${messages.length} mensagens processadas (syncType=${syncType}, isLatest=${isLatest})`
      );
    });

    // Confirmações de entrega/leitura de mensagens que NÓS enviamos (é isso
    // que vira o "✓✓ azul" na tela — ver tickIcon no frontend).
    //
    // Diferente do messages.upsert (onde o Baileys já decodifica e preenche
    // participantAlt/remoteJidAlt com o telefone real), este evento nasce do
    // recibo de entrega/leitura cru (handleReceipt, dentro do Baileys) e NUNCA
    // populam esses campos alt — só key.remoteJid, que pro sistema novo de LID
    // do WhatsApp pode vir como "<id>@lid" (um id interno, não o telefone).
    // Sem resolver isso, o telefone batia errado com o da conversa no banco
    // (updateMessageStatus não achava a linha) e o broadcast ia pro assunto
    // errado — o "✓✓ visualizado" nunca chegava na tela. Ver _resolveLidPhone.
    this.sock.ev.on('messages.update', async (updates) => {
      for (const u of updates) {
        const status = this._mapStatus(u.update?.status);
        if (!status || !u.key?.id) continue;
        const phoneSource =
          u.key.participantAlt || u.key.remoteJidAlt || u.key.participant || u.key.remoteJid;
        const phone = await this._resolveLidPhone(phoneSource);
        // Sem telefone resolvido, não dá pra saber qual conversa atualizar
        // (updateMessageStatus não teria com o que casar) — pula em vez de
        // emitir com `phone: null` (ver _resolveLidPhone).
        if (!phone) continue;
        this.emit('messageStatus', { phone, messageId: u.key.id, status });
      }
    });

    // "Digitando…"/"Gravando áudio…" do CONTATO (não da empresa) — só chega
    // pra quem o WhatsApp já mandou `presenceSubscribe` (ver subscribePresence,
    // chamado ao abrir uma conversa) e mesmo assim depende da privacidade de
    // cada contato: sem permissão, esse evento simplesmente nunca chega, sem
    // erro nenhum (best-effort, igual foto de perfil/grupos em comum).
    this.sock.ev.on('presence.update', ({ id, presences }) => {
      if (!id || id.endsWith('@g.us') || id.endsWith('@newsletter') || id.endsWith('@broadcast')) return;
      const info = presences?.[id] || Object.values(presences || {})[0];
      if (!info?.lastKnownPresence) return;
      this.emit('presence', { phone: this._jidToPhone(id), state: info.lastKnownPresence });
    });

    // Acumula contatos "vistos" pra estimativa de contagem no card da
    // instância (ver getContactCount) — Baileys só entrega incrementos
    // (upsert no sync inicial, update depois), nunca um total pronto.
    // Também aproveita a mesma lista pra emitir nome+telefone (ver
    // _extractContactInfo) — contacts.upsert dispara no sync inicial de uma
    // sessão já pareada há mais tempo (fora do backfill de histórico, que
    // tem sua própria lista de contacts dentro de messaging-history.set,
    // tratada abaixo), contacts.update em qualquer troca de nome depois.
    const trackContacts = (list) => {
      for (const c of list || []) {
        if (c?.id) this.contactIds.add(c.id);
        this._extractContactInfo(c)
          .then((info) => { if (info) this.emit('contact', info); })
          .catch((err) => console.error('[whatsapp] falha ao extrair nome de contato:', err.message));
      }
    };
    this.sock.ev.on('contacts.upsert', trackContacts);
    this.sock.ev.on('contacts.update', trackContacts);
  }

  // proto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2 (enviado),
  // DELIVERY_ACK=3 (entregue), READ=4, PLAYED=5 (áudio/vídeo reproduzido).
  // code === 0 é WAMessageStatus.ERROR — o WhatsApp ACEITA a mensagem no
  // envio (sock.sendMessage nunca lança erro nesse caso) e só REJEITA depois,
  // de forma assíncrona, via este mesmo evento messages.update. O caso real
  // mais comum: "error 463: account restricted or missing tctoken for
  // contact" — o WhatsApp exige um token de privacidade antes de deixar
  // iniciar conversa NOVA com alguém que nunca falou com este número; some
  // sozinho depois que já existe uma conversa. Sem tratar isto, code===0
  // caía no `return null` (igual a "nenhum status relevante") e a rejeição
  // ficava invisível pro sistema inteiro — Campanha marcava sucesso mesmo
  // sem a mensagem nunca chegar de verdade (bug real, achado via log de
  // produção: msgId+telefone bateram exatos com os do "error 463").
  _mapStatus(code) {
    if (code == null) return null;
    if (code === 0) return 'failed';
    if (code >= 4) return 'read';
    if (code === 3) return 'delivered';
    if (code === 2) return 'sent';
    return null;
  }

  /**
   * Chamado a cada acesso à sessão (ver SessionManager.get()). Se a sessão não
   * estiver deslogada, não faz nada. Se estiver, apaga as credenciais salvas
   * (inválidas — o WhatsApp já encerrou essa sessão do lado dele; tentar
   * reconectar com elas só falha de novo) e reinicia do zero, o que gera um QR
   * Code novo para o usuário escanear.
   */
  async requestFreshQr() {
    if (!this.loggedOut) return;
    this.loggedOut = false;
    if (fs.existsSync(this.authFolder)) {
      fs.rmSync(this.authFolder, { recursive: true, force: true });
    }
    await this.start();
  }

  /**
   * Decisão EXPLÍCITA do usuário (botão "Tentar reconectar" na tela de
   * Instâncias) de tentar de novo depois de uma desconexão marcada como
   * `needsAttention` (403/440/500 — ver connection.update). Diferente de
   * `requestFreshQr`: NÃO apaga as credenciais, tenta reconectar com o que
   * já está salvo (se o motivo real era temporário — ex: restrição de 48-72h
   * do WhatsApp que já passou — volta a funcionar sem precisar escanear QR
   * de novo). Se a sessão não estiver em `needsAttention`, não faz nada
   * (evita reiniciar uma sessão já saudável por engano). HANDOFF Parte CQ.
   */
  async retryManually() {
    if (!this.needsAttention) return;
    this.needsAttention = false;
    this.lastDisconnectReason = null;
    this.consecutiveFailures = 0;
    await this.start();
  }

  /**
   * Desconecta esse WhatsApp de vez — usado ao remover uma instância. Tenta
   * deslogar do lado do WhatsApp (some da lista "Aparelhos conectados" no
   * celular) e sempre apaga as credenciais salvas, mesmo se o logout falhar
   * (ex: já estava offline).
   */
  async disconnect() {
    try {
      await this.sock?.logout();
    } catch (err) {
      console.error('[whatsapp] falha ao deslogar (limpando mesmo assim):', err.message);
    }
    this.status = 'offline';
    this.sock = null;
    if (fs.existsSync(this.authFolder)) {
      fs.rmSync(this.authFolder, { recursive: true, force: true });
    }
  }

  /**
   * `replyTo` (opcional) — `{ id, fromMe, text, type }` da mensagem sendo
   * citada (ver store.getMessageForReply). Reconstruímos só o suficiente pro
   * Baileys montar o "balão citado": não guardamos a mensagem original do
   * WhatsApp (protobuf completo), só os campos que já persistimos mesmo.
   */
  async sendMessage(phone, text, replyTo) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }
    const jid = this._phoneToJid(phone);
    const options = replyTo ? { quoted: this._buildQuoted(jid, replyTo) } : undefined;
    const result = await this.sock.sendMessage(jid, { text }, options);
    return {
      id: result.key.id,
      text,
      direction: 'out',
      status: 'sent',
      createdAt: new Date().toISOString(),
    };
  }

  _buildQuoted(jid, replyTo) {
    return {
      key: { remoteJid: jid, id: replyTo.id, fromMe: !!replyTo.fromMe },
      message: { conversation: replyTo.text || `[${replyTo.type || 'mensagem'}]` },
    };
  }

  /**
   * Reage (ou remove a reação, com `emoji` vazio/null) a uma mensagem já
   * existente na conversa. `fromMe` precisa indicar quem enviou a mensagem
   * ORIGINAL (não quem está reagindo agora) — é assim que o Baileys monta a
   * `key` de referência.
   */
  async sendReaction(phone, messageId, emoji, fromMe) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }
    const jid = this._phoneToJid(phone);
    await this.sock.sendMessage(jid, {
      react: { text: emoji || '', key: { remoteJid: jid, id: messageId, fromMe: !!fromMe } },
    });
  }

  /**
   * Avisa o contato que a empresa está "digitando…" (`state: 'composing'`),
   * "gravando áudio…" (`'recording'`) ou parou (`'paused'`) — o mesmo
   * indicador que aparece quando uma pessoa de verdade está escrevendo no
   * WhatsApp dela. Puramente ao vivo (não fica salvo em lugar nenhum); se a
   * sessão não estiver online, simplesmente não faz nada (não é um erro
   * grave o suficiente pra travar a digitação de quem está atendendo).
   */
  async sendPresence(phone, state) {
    if (this.status !== 'online' || !this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(state, this._phoneToJid(phone));
    } catch (err) {
      console.error('[whatsapp] falha ao enviar presença:', err.message);
    }
  }

  /**
   * Pede pro WhatsApp avisar (evento 'presence.update' do Baileys, repassado
   * como 'presence' por esta classe) quando esse contato começar a digitar
   * ou gravar áudio — sem isso, a sessão nunca recebe presença de ninguém.
   * Best-effort: o contato pode ter essa informação bloqueada por
   * privacidade, e nesse caso o pedido não dá erro nenhum — só nunca chega
   * evento nenhum depois.
   */
  async subscribePresence(phone) {
    if (this.status !== 'online' || !this.sock) return;
    try {
      await this.sock.presenceSubscribe(this._phoneToJid(phone));
    } catch (err) {
      console.error('[whatsapp] falha ao inscrever presença:', err.message);
    }
  }

  /**
   * Envia imagem, áudio, vídeo ou documento. `type` é 'image' | 'audio' |
   * 'video' | 'document'; `buffer` são os bytes do arquivo; `mimetype` vem
   * do arquivo original (ex: 'image/jpeg', 'audio/mpeg', 'video/mp4',
   * 'application/pdf'). Áudio vai como arquivo normal (não como nota de
   * voz/PTT). `fileName` só se aplica a 'document' (PDF, PPT, DOCX etc. —
   * anexo genérico que o WhatsApp não sabe renderizar como mídia embutida,
   * então mostra um cartão com nome + ícone do arquivo).
   *
   * Devolve também `buffer`/`mimetype` (que podem ter sido convertidos, ver
   * áudio abaixo) para quem chamou salvar exatamente os bytes que foram
   * realmente enviados.
   */
  async sendMedia(phone, { type, buffer, mimetype, caption, fileName, replyTo }) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }

    let outBuffer = buffer;
    let outMimetype = mimetype;

    if (type === 'audio') {
      // O WhatsApp só entrega/reproduz áudio em OGG/Opus (mesmo formato das
      // notas de voz nativas). Áudio gravado no navegador (webm/opus, via
      // MediaRecorder) ou em outros formatos é aceito no upload mas não chega
      // a aparecer/tocar no destinatário sem essa conversão.
      outBuffer = await convertToOggOpus(buffer);
      outMimetype = 'audio/ogg; codecs=opus';
    }

    const jid = this._phoneToJid(phone);
    const content =
      type === 'image'
        ? { image: outBuffer, mimetype: outMimetype, caption: caption || undefined }
        : type === 'video'
        ? { video: outBuffer, mimetype: outMimetype, caption: caption || undefined }
        : type === 'document'
        ? { document: outBuffer, mimetype: outMimetype, fileName: fileName || 'arquivo', caption: caption || undefined }
        : { audio: outBuffer, mimetype: outMimetype, ptt: false };
    const options = replyTo ? { quoted: this._buildQuoted(jid, replyTo) } : undefined;
    const result = await this.sock.sendMessage(jid, content, options);
    return {
      id: result.key.id,
      direction: 'out',
      status: 'sent',
      createdAt: new Date().toISOString(),
      buffer: outBuffer,
      mimetype: outMimetype,
    };
  }

  /**
   * Cria um grupo de WhatsApp de verdade (não é a "lista" de contatos da
   * Campanha — é um grupo do WhatsApp mesmo, com JID "xxxxx@g.us"). Depois de
   * criado, mandar mensagem pra esse JID (via sendMessage/sendMedia, usando o
   * id do grupo no lugar do telefone) entrega UMA mensagem que o próprio
   * WhatsApp distribui a todos os participantes.
   */
  async createGroup(name, phones) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }
    const jids = phones.map((p) => this._phoneToJid(p));
    const metadata = await this.sock.groupCreate(name, jids);
    return {
      id: metadata.id,
      name: metadata.subject || name,
      participantCount: metadata.participants?.length ?? jids.length,
    };
  }

  /**
   * Promove um participante já no grupo a admin (ex: gatilho de grupo por
   * etapa do negócio, src/dealGroupTrigger.js, que promove o número fixo do
   * escritório). Quem CRIA o grupo (esta própria instância, ver
   * createGroup acima) já nasce admin automaticamente — isto é só para
   * promover alguém ALÉM do criador.
   */
  async promoteParticipant(groupId, phone) {
    if (this.status !== 'online') {
      throw new Error('WhatsApp não está conectado no momento');
    }
    const jid = this._phoneToJid(phone);
    await this.sock.groupParticipantsUpdate(groupId, [jid], 'promote');
  }

  /**
   * Telefones dos participantes de um grupo (usado pra achar "grupos em
   * comum" com um contato, no painel de detalhes do Chat). Mesma questão de
   * LID já conhecida deste projeto (ver diagnóstico do bug de recebimento no
   * HANDOFF) — aqui o Baileys já resolve isso sozinho: cada participante
   * (`GroupParticipant extends Contact`) tem `id` (formato preferido, pode
   * ser `@lid`) e opcionalmente `phoneNumber` (formato `@s.whatsapp.net`,
   * com o telefone de verdade) — igual ao par `participant`/`participantAlt`
   * já usado pra mensagens. Sem `phoneNumber` (participante só com LID e sem
   * essa info disponível), esse participante simplesmente não aparece na
   * lista devolvida — best-effort, não uma garantia de achar todo mundo.
   */
  async getGroupParticipantPhones(groupId) {
    if (this.status !== 'online' || !this.sock) return [];
    try {
      const metadata = await this.sock.groupMetadata(groupId);
      return (metadata.participants || [])
        .map((p) => this._jidToPhone(p.phoneNumber || p.id))
        .filter((phone) => phone);
    } catch {
      return [];
    }
  }

  /**
   * URL da foto de perfil do contato (ou grupo). Devolve null se a sessão não
   * estiver online, o contato não existir, ou a privacidade dele bloquear a
   * própria foto pra nós — tudo tratado como "sem foto", não como erro.
   */
  async getProfilePicture(phone) {
    if (this.status !== 'online' || !this.sock) return null;
    try {
      const jid = this._phoneToJid(phone);
      return await this.sock.profilePictureUrl(jid, 'image');
    } catch {
      return null;
    }
  }

  // ----- helpers de formato -----

  _phoneToJid(phone) {
    const raw = String(phone);
    if (raw.includes('@')) return raw; // já é um JID pronto (grupo "@g.us" ou usuário "@s.whatsapp.net")
    const digits = raw.replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  // O JID pode vir com um sufixo de dispositivo ("<telefone>:0@...", "...:12@...")
  // — sem remover isso, o telefone salvo não batia com o da conversa no banco
  // (ex: "5511999999999:0" ≠ "5511999999999"), e updateMessageStatus nunca
  // encontrava a linha pra atualizar. Confirmado no log: era exatamente essa
  // a causa do "✓✓ visualizado" nunca aparecer.
  _jidToPhone(jid) {
    return (jid || '').split('@')[0].split(':')[0];
  }

  // Resolve um JID "<id>@lid" (sistema novo de identificador do WhatsApp,
  // usado quando não há participantAlt/remoteJidAlt disponível — ver
  // messages.update acima) pro telefone de verdade, via o mapeamento
  // LID<->PN que o próprio Baileys mantém internamente.
  //
  // Devolve `null` (não o id cru do LID) quando não consegue resolver —
  // até 2026-08-12 caía de volta pro id cru (`_jidToPhone(jid)`), que faz
  // sentido pra um "telefone temporariamente ilegível" só enquanto isso
  // vira uma linha isolada de mensagem estranha, mas viesse a ser tratado
  // como telefone de verdade (salvo em `messages.phone`, ou upsertado como
  // CONTATO desde o sync automático — HANDOFF Parte CO) e o resultado é um
  // "contato" com um ID interno de 12-15 dígitos no lugar do telefone —
  // exatamente o que apareceu na tela de Contatos como várias linhas "sem
  // nome" com números sem relação nenhuma com WhatsApp de verdade. Quem
  // chama esta função precisa tratar `null` explicitamente (descartar a
  // mensagem/pular o upsert), nunca assumir que sempre vem uma string.
  async _resolveLidPhone(jid) {
    if (!jid) return null;
    if (!jid.endsWith('@lid')) return this._jidToPhone(jid) || null;
    try {
      const pn = await this.sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn) return this._jidToPhone(pn) || null;
    } catch (err) {
      console.error('[whatsapp] falha ao resolver LID->telefone:', err.message);
    }
    // Ainda não temos o mapeamento LID->telefone pra este contato — melhor
    // não processar agora (a próxima mensagem tenta de novo) do que salvar
    // com um telefone errado que nunca mais seria corrigido sozinho.
    return null;
  }

  // Nome + telefone resolvido a partir de um objeto Contact do Baileys —
  // usado tanto pelos eventos ao vivo (contacts.upsert/update) quanto pelos
  // `contacts` que vêm dentro de messaging-history.set (backfill). Precisa
  // existir porque mensagens de HISTÓRICO nunca trazem m.pushName (só
  // mensagens ao vivo trazem — ver _processIncomingMessage), então sem ler
  // esta lista separada as 5+ primeiras conversas de um pareamento novo
  // ficavam com nome null pra sempre (usuário reportou com print, sessão
  // 2026-08-12 — mesmo dia da Parte CR/CS).
  //
  // Contact.id vem em formato jid OU lid (preferencialmente jid, por doc do
  // próprio Baileys) — reaproveita _resolveLidPhone, que já trata os dois
  // casos. Contact.phoneNumber (formato PN dedicado) é preferido quando
  // presente por evitar uma resolução de LID a mais, mas nem sempre vem
  // preenchido.
  //
  // Nome: prioriza `notify` (nome que o PRÓPRIO contato definiu no WhatsApp
  // dele — mesmo significado de m.pushName em mensagem ao vivo, mantém
  // consistência) sobre `name` (nome que nós/o dono do número salvou na
  // agenda dele — mais raro de vir preenchido via Web, mas serve de
  // fallback). Devolve `{ phone, name } | null` — null quando não sobra
  // nome nenhum pra extrair (não vale a viagem ao banco só pra não mudar
  // nada) ou quando o telefone não resolve (mesmo critério de descarte de
  // _resolveLidPhone).
  async _extractContactInfo(contact) {
    if (!contact) return null;
    const name = contact.notify || contact.name || null;
    if (!name) return null;
    const phone = contact.phoneNumber
      ? this._jidToPhone(contact.phoneNumber) || null
      : await this._resolveLidPhone(contact.id);
    if (!phone) return null;
    return { phone, name };
  }

  // Wrapper PÚBLICO de _resolveLidPhone pensado pro diagnóstico de conversas
  // antigas com telefone LID cru salvo (HANDOFF Parte CP) — recebe só o
  // NÚMERO do LID (sem "@lid", que é como ficou salvo em conversations.phone
  // desde antes da correção), reconstrói o JID e tenta resolver. Só leitura,
  // não muda nada no socket/sessão. `null` = não foi possível resolver ainda
  // (mesma semântica de _resolveLidPhone).
  async resolveLidToPhone(lidNumber) {
    if (!this.sock || this.status !== 'online') return null;
    return this._resolveLidPhone(`${lidNumber}@lid`);
  }

  // Normaliza UMA mensagem crua do Baileys pro formato que o resto da
  // aplicação consome (mesmo payload de `this.emit('message', ...)`) —
  // usado tanto por `messages.upsert` (mensagem em tempo real) quanto por
  // `messaging-history.set` (histórico). Devolve `null` quando a mensagem
  // deve ser descartada (status, grupo, newsletter, reação, sem conteúdo).
  //
  // `isHistory: true` muda só o tratamento de falha ao baixar mídia: mensagem
  // nova sem mídia seria uma notificação incompleta (descarta, como sempre
  // foi), mas mensagem antiga sem mídia (link do CDN do WhatsApp expirado,
  // comum em histórico) ainda tem valor — mantém o texto/legenda em vez de
  // jogar a mensagem toda fora.
  async _processIncomingMessage(m, { isHistory = false } = {}) {
    if (!m.message) return null;

    // Status/Stories do WhatsApp (remoteJid "status@broadcast") — quando
    // o número conectado consegue ver o Status de um contato, o Baileys
    // entrega isso aqui igual a uma mensagem normal, com `participant`
    // identificando quem postou. Sem esse descarte, o Status virava uma
    // "mensagem" de verdade salva na conversa 1:1 daquele contato (uma
    // foto/vídeo que a pessoa nunca mandou pra ninguém, só postou no
    // Status dela). Descarta e segue, sem gravar nada.
    if (isJidBroadcast(m.key.remoteJid)) return null;

    // Mensagem de GRUPO (remoteJid termina em "@g.us") — decisão do
    // usuário depois de ver que, mesmo isolando numa conversa própria e
    // já arquivada (primeira tentativa de correção), o conteúdo do
    // grupo continuava fisicamente salvo no banco (visível direto pelo
    // Table Editor do Supabase) — o que ele não quer de jeito nenhum.
    // Descarta por completo, mesmo tratamento do Status acima. Efeito
    // colateral aceito: a funcionalidade de "criar grupo" (ver
    // createGroup()) continua criando/enviando pro grupo normalmente,
    // só que respostas de quem está no grupo não aparecem em lugar
    // nenhum do CRM — só a mensagem enviada pela própria empresa (que
    // segue outro caminho, sendMessage/sendMedia, não passa por aqui).
    //
    // EXCEÇÃO (2026-08-20): grupos "de card" (criados pela feature de
    // Negócio — aba DapZap do card, ver src/routes/cardGroup.js,
    // wa_groups.source='card') SÃO processados normalmente — decisão do
    // usuário, esse conteúdo precisa aparecer na conversa dentro do
    // card. Qualquer outro grupo (manual, POST /groups da tela
    // Contatos/Chat) continua descartando, sem nenhuma mudança.
    const isGroupMsg = (m.key.remoteJid || '').endsWith('@g.us');
    if (isGroupMsg && !(await this.isCardGroup(m.key.remoteJid))) return null;

    // Canal do WhatsApp (remoteJid termina em "@newsletter") — posts de
    // canais seguidos (ex: ESPN Brasil, Netflix Brasil) chegam pelo mesmo
    // evento messages.upsert, igual Status e grupo. Não é conversa com
    // cliente nenhum, então descarta por completo também.
    if (isJidNewsletter(m.key.remoteJid)) return null;

    // Mensagens de SISTEMA da própria Meta (avisos genéricos tipo "Conheça
    // o WhatsApp Business"/"Salve notas privadas..." — mandadas uma vez a
    // toda conta Business, sem remetente real). Não são conversa com
    // ninguém: chegam com key.remoteJid vazio/inválido, então
    // _resolveLidPhone (abaixo) nunca acha um telefone e o resultado virava
    // uma "conversa" fantasma com phone="0" (HANDOFF Parte CP — achado ao
    // investigar contatos fantasma de LID, causa raiz diferente daquela).
    // wa_message_id é o MESMO em toda conta que recebe (não é gerado por
    // instância) — filtro por id fixo é mais confiável que tentar inferir
    // "remetente vazio" de outro jeito.
    const SYSTEM_MESSAGE_IDS = new Set(['1484720636734891-1', '785376054348615-1']);
    if (SYSTEM_MESSAGE_IDS.has(m.key.id)) return null;

    // Reação (emoji) a uma mensagem existente — não é uma mensagem nova,
    // é um "ponteiro" pra mensagem original (reactionMessage.key.id).
    // `text` vazio significa que a reação foi removida.
    if (m.message.reactionMessage) {
      const r = m.message.reactionMessage;
      if (!r.key?.id) return null;
      const phoneSource = m.key.participantAlt || m.key.remoteJidAlt || m.key.participant || m.key.remoteJid;
      this.emit('reaction', {
        phone: this._jidToPhone(phoneSource),
        targetId: r.key.id,
        emoji: r.text || null,
        direction: m.key.fromMe ? 'out' : 'in',
      });
      return null;
    }

    // Não filtramos fromMe aqui: mensagens enviadas pelo próprio usuário direto
    // do celular (fora do widget) também chegam como fromMe:true, e precisam
    // ser salvas. As que já foram enviadas via sendMessage()/sendMedia() também
    // passam por aqui (o WhatsApp ecoa a própria mensagem enviada) — o dedupe
    // por id em store.addMessage evita salvar/mostrar elas duas vezes.

    // O WhatsApp novo entrega o remetente/destinatário como "<id>@lid" (sistema LID).
    // Nesta versão do Baileys, o telefone real vem em key.participantAlt
    // (mensagem de grupo) ou key.remoteJidAlt (conversa direta) — os campos
    // key.senderPn/participantPn documentados não existem nesta versão.
    // Mensagem de grupo (não-card) já foi descartada acima, então
    // participant* aqui só apareceria num caso estranho fora do fluxo de
    // grupo de card (não deveria acontecer na prática). Mas esse caso
    // "estranho" acontece na prática com frequência (LID sem alt
    // disponível ainda) — por isso passa por _resolveLidPhone (mesmo
    // helper já usado em messages.update acima), que tenta o mapeamento
    // LID->telefone real via o próprio Baileys antes de aceitar o id cru.
    // Sem isso, um contato com LID ainda não mapeado virava uma "mensagem"
    // salva com o ID interno do WhatsApp no lugar do telefone (12-15
    // dígitos, sem relação com o número de verdade) — e, desde o sync
    // automático de contatos (HANDOFF Parte CO), isso passou a criar um
    // contato fantasma "sem nome" também, não só uma mensagem estranha.
    let phone;
    let senderPhone = null;
    let senderName = null;
    if (isGroupMsg) {
      // Grupo de card (única forma de chegar aqui com isGroupMsg=true, ver
      // acima): a IDENTIDADE DA CONVERSA é o JID DO GRUPO (mesmo "phone"
      // usado nas rotas de envio/histórico, ver db/schema.sql:419-421),
      // NUNCA o participante — senão cada pessoa que fala no grupo criaria
      // uma "conversa" própria, em vez de todas caírem na conversa do
      // grupo. Quem mandou DENTRO do grupo fica em senderPhone/senderName,
      // separado (grupo tem N remetentes possíveis; DM sempre teve só 1).
      const participantSource = m.key.participantAlt || m.key.participant;
      // Sem remetente identificável dentro do grupo, não dá pra saber quem
      // mandou — descarta em vez de salvar sem essa informação.
      if (!participantSource) return null;
      senderPhone = await this._resolveLidPhone(participantSource);
      senderName = m.key.fromMe ? null : m.pushName || null;
      phone = m.key.remoteJid;
    } else {
      const phoneSource = m.key.participantAlt || m.key.remoteJidAlt || m.key.participant || m.key.remoteJid;
      phone = await this._resolveLidPhone(phoneSource);
    }
    // Sem telefone resolvido, não tem conversa/contato pra associar — mesma
    // decisão de grupo/status/newsletter acima: descarta em vez de salvar
    // com um id interno no lugar do telefone (ver _resolveLidPhone). A
    // mensagem original continua no WhatsApp; se o mapeamento LID->telefone
    // resolver depois, a PRÓXIMA mensagem dessa conversa já vem certa.
    if (!phone) return null;

    const media = this._extractMediaInfo(m.message);
    const text = media ? media.caption : this._extractText(m.message);
    let mediaUrl = null;
    let mimetype = null;

    if (media) {
      try {
        const buffer = await downloadMediaMessage(m, 'buffer', {});
        mediaUrl = await saveMedia(this.sessionId, m.key.id, buffer, media.mimetype);
        mimetype = media.mimetype;
      } catch (err) {
        if (!isHistory) {
          console.error('[whatsapp] falha ao baixar mídia recebida:', err.message);
          return null;
        }
        console.warn(
          '[whatsapp] mídia histórica indisponível (link do WhatsApp provavelmente expirado), salvando só o texto/legenda:',
          err.message
        );
      }
    }

    if (!mediaUrl && !text) return null;

    return {
      phone,
      // Nome que o próprio contato definiu no WhatsApp dele — só vem em
      // mensagens recebidas (m.key.fromMe === false); usado pra já
      // preencher o nome do contato na interface sem cadastro manual.
      // Em grupo, NUNCA vem daqui (senão o nome da CONVERSA seria
      // sobrescrito pelo nome de quem mandou por último) — o nome do
      // grupo já vem de outro lugar (wa_groups.name, definido na criação),
      // e quem mandou fica em senderName, separado.
      pushName: isGroupMsg || m.key.fromMe ? null : m.pushName || null,
      // Preenchidos SÓ em mensagem de grupo de card — telefone/nome de
      // quem mandou DENTRO do grupo (não a conversa em si). DM nunca
      // preenche isso (remetente já é a conversa inteira, sem
      // ambiguidade) — ver comentário acima de onde phone é resolvido.
      senderPhone,
      senderName,
      // true pra mensagem que veio de messaging-history.set (backfill) —
      // usado por quem consome o evento 'message' pra decidir se dispara
      // notificação/broadcast/timeline (mensagem histórica não deveria,
      // ver src/server.js onMessage).
      isHistory,
      message: {
        id: m.key.id,
        type: mediaUrl ? media.type : 'text',
        text,
        mediaUrl,
        mimetype: mediaUrl ? mimetype : null,
        direction: m.key.fromMe ? 'out' : 'in',
        status: m.key.fromMe ? 'sent' : 'delivered',
        createdAt: new Date((m.messageTimestamp || Date.now() / 1000) * 1000).toISOString(),
        replyToId: this._extractReplyToId(m.message),
        fileName: media?.fileName || null,
      },
    };
  }

  _extractText(message) {
    return message.conversation || message.extendedTextMessage?.text || null;
  }

  // Id da mensagem original quando esta é uma resposta ("reply") a outra —
  // o WhatsApp guarda isso em `contextInfo.stanzaId`, dentro do tipo real da
  // mensagem (nunca em `conversation`: uma resposta de texto sempre chega
  // como extendedTextMessage, mesmo sem nenhuma formatação especial).
  _extractReplyToId(message) {
    const ctx =
      message.extendedTextMessage?.contextInfo ||
      message.imageMessage?.contextInfo ||
      message.videoMessage?.contextInfo ||
      message.audioMessage?.contextInfo;
    return ctx?.stanzaId || null;
  }

  // Mensagem de imagem, áudio ou vídeo -> { type, mimetype, caption } | null.
  // (Documento ainda não é tratado.)
  _extractMediaInfo(message) {
    if (message.imageMessage) {
      return {
        type: 'image',
        mimetype: message.imageMessage.mimetype,
        caption: message.imageMessage.caption || null,
      };
    }
    if (message.videoMessage) {
      return {
        type: 'video',
        mimetype: message.videoMessage.mimetype,
        caption: message.videoMessage.caption || null,
      };
    }
    if (message.audioMessage) {
      return {
        type: 'audio',
        mimetype: message.audioMessage.mimetype,
        caption: null,
      };
    }
    if (message.documentMessage) {
      return {
        type: 'document',
        mimetype: message.documentMessage.mimetype,
        caption: message.documentMessage.caption || null,
        fileName: message.documentMessage.fileName || null,
      };
    }
    return null;
  }
}

module.exports = { WhatsAppGateway };
