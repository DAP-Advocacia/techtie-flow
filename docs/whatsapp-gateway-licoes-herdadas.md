# WhatsApp Gateway (Baileys) — lições herdadas do DapZap

Este projeto nasceu como fork do `whatsapp-crm-gatway` (DapZap), em produção
real atendendo um escritório de advocacia desde 2026-07. Este documento
resume, sem nenhum dado de cliente, o que já foi testado/quebrado/corrigido
lá — para não redescobrir os mesmos problemas aqui do zero.

Fonte: comentários do próprio código em `src/whatsapp.js` e `src/sessions.js`
(preservados no fork), que documentam o *porquê* de cada decisão.

## 1. Risco de ban — é real e não é um bug deste app

Baileys é engenharia reversa do protocolo do WhatsApp Web, não API oficial.
O WhatsApp pode banir uma conta por qualquer motivo, a qualquer momento, sem
aviso. Isso não é algo que se "resolve" no código — só se mitiga.

**Mitigação testada: bloquear sync FULL de histórico no primeiro pareamento.**

Caso real: um número com histórico grande (milhares de contatos) foi banido
(`forbidden`) em menos de 20 minutos após conectar pela primeira vez. A causa
identificada: por padrão, o Baileys pede ao celular o histórico *completo*
(`syncType: FULL`) assim que a sessão pareia — isso gera um pico de tráfego
logo nos primeiros minutos, um padrão que os sistemas de detecção de
automação do WhatsApp monitoram.

Correção: sobrescrever `shouldSyncHistoryMessage` para aceitar `RECENT` e
`INITIAL_BOOTSTRAP` (conversas recentes — o que a maioria dos usuários
precisa no dia a dia) mas **rejeitar `FULL`**:

```js
shouldSyncHistoryMessage: (msg) => msg.syncType !== proto.HistorySync.HistorySyncType.FULL,
```

Isso não elimina o risco de ban (nada elimina), mas remove um fator real sob
controle da aplicação.

## 2. Fila de pareamento — picos simultâneos de conexão derrubam tudo

**Sintoma observado em produção:** quando uma empresa avisa toda a equipe de
uma vez (ex: notificação em massa) para conectar o WhatsApp, dezenas de
pessoas escaneiam o QR Code ao mesmo tempo. Investigação de dados reais:
num dia com pico de conexões simultâneas, ~40% das tentativas de pareamento
naquela janela de 1-2h nunca completaram (ficaram presas, sem erro
explícito) — Baileys/WhatsApp não aguenta `makeWASocket()` + handshake de
pareamento disparando em paralelo sem limite.

**Correção: fila de pareamento com concorrência máxima.** Em vez de chamar
`gateway.start()` imediatamente para cada sessão nova, ela entra numa fila; um
semáforo simples libera no máximo `N` pareamentos simultâneos (default 4,
configurável via `MAX_CONCURRENT_PAIRINGS`):

```js
// src/sessions.js
this.pairingQueue = [];
this.activePairings = 0;
this.maxConcurrentPairings = Number(process.env.MAX_CONCURRENT_PAIRINGS || 4);

_runPairingQueue() {
  while (this.activePairings < this.maxConcurrentPairings && this.pairingQueue.length) {
    const gateway = this.pairingQueue.shift();
    this.activePairings++;
    gateway.status = 'connecting'; // sai de 'queued' assim que o start() real começa
    gateway.start()
      .catch((err) => console.error(`falha ao iniciar sessão:`, err.message))
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
```

O frontend trata o status `'queued'` como "aguarde, sua vez está chegando" —
não como erro — e mostra progresso real em vez de um indicador genérico.

**Pendência conhecida (não resolvida no DapZap ainda):** mesmo com a fila,
picos muito grandes ainda produzem alguma taxa residual de falha — a fila
evita colapso total, mas não é 100% das conexões. Vale investigar se o motivo
residual é do lado do WhatsApp (rate limit por IP/janela de tempo) antes de
simplesmente aumentar `maxConcurrentPairings`.

## 3. Reconexão automática — nem toda queda deve tentar de novo para sempre

**Sintoma observado:** o código antigo tentava reconectar a cada 3s pra
sempre, não importa o motivo da queda. Isso causou dois incidentes reais:

1. Contas já banidas ficaram em loop de reconexão (150 tentativas em 7
   minutos), sobrecarregando o processo até o orquestrador matá-lo — o que
   derrubava **todas** as instâncias rodando no mesmo processo, inclusive as
   saudáveis.
2. Cada tentativa de reconexão numa conta já restrita **reseta o timer de
   cooldown do lado do WhatsApp** — insistir prolonga o próprio bloqueio.

**Correção: três categorias de motivo de desconexão, cada uma com
tratamento diferente:**

- **`loggedOut` (usuário deslogou pelo celular)** — sessão morta de
  propósito. Não reconecta; fica aguardando um QR novo.
- **Códigos permanentes** (`forbidden` 403 = banido/restrito,
  `connectionReplaced` 440 = outro dispositivo assumiu a sessão, `badSession`
  500 = credenciais corrompidas) — reconectar não resolve nada, só
  prejudica. Para de insistir e marca a instância como "precisa de atenção"
  para ação manual (reconectar via botão ou remover). **Nunca apaga
  credenciais automaticamente** — é destrutivo demais para uma decisão sem
  supervisão humana.
- **Código temporário (rede, timeout)** — reconecta com **backoff
  exponencial** (3s, 6s, 12s... até teto de 5min), e ainda assim com um
  **teto de tentativas totais** (default 20, configurável via
  `MAX_RECONNECT_ATTEMPTS`): sessões "mortas" que nunca batem um código
  permanente explícito (ex: número trocado de aparelho) mas também nunca
  mais conseguem reconectar de verdade, sem o teto, ficavam tentando
  indefinidamente (uma chegou a 142 tentativas / 11h+ seguidas). Ao bater o
  teto, trata como permanente: para e marca para atenção manual.

```js
const PERMANENT_CODES = new Set([
  DisconnectReason.forbidden,
  DisconnectReason.connectionReplaced,
  DisconnectReason.badSession,
]);
```

## 4. Outras decisões de resiliência que valem reaproveitar

- **Fetch da versão do protocolo em runtime** (`fetchLatestBaileysVersion()`
  antes de cada `makeWASocket`) em vez de fixar uma versão — o protocolo do
  WhatsApp Web muda sem aviso prévio da Meta.
- **Dedupe de mensagem por `(conversation_id, wa_message_id)`** na gravação —
  cobre o caso de uma mensagem chegar duas vezes (ex: uma vez via
  `messages.upsert` ao vivo, outra via `messaging-history.set` de backfill).
- **Mensagens de grupo, Status/Stories e posts de canal (`@newsletter`) nunca
  são gravadas no banco** — descartadas assim que chegam. Decisão de
  produto (não só técnica): esse conteúdo não é atendimento a cliente e não
  deveria virar dado persistido, por volume e por privacidade.
- **Contagem de contatos é cumulativa em memória, não uma consulta real** —
  Baileys não expõe um "snapshot" completo da agenda, só eventos
  incrementais (`contacts.upsert`/`update`). Qualquer feature que dependa de
  "quantos contatos esse número tem" precisa saber que esse número é um piso
  (contatos nunca vistos pelo WhatsApp Web não entram), não o total real do
  celular.

## 5. Para o TechTie Flow especificamente

Como a decisão de arquitetura foi oferecer **Baileys e WhatsApp Cloud API
oficial lado a lado** (não só um dos dois), o gateway deveria nascer já
desenhado como uma interface de canal (`WhatsAppChannel`) com pelo menos dois
backends:

- `BaileysChannel` — este conhecimento todo se aplica diretamente aqui.
- `CloudApiChannel` — não tem risco de ban nem fila de pareamento (é
  REST normal contra a Meta), mas tem custo por mensagem e exige onboarding
  via Embedded Signup (ver decisão de produto registrada na conversa de
  planejamento inicial).

Todas as lições acima (fila, backoff, categorização de erro permanente vs.
temporário) são específicas do `BaileysChannel` — não existe equivalente
necessário no `CloudApiChannel`, cujo modelo de falha é completamente
diferente (rate limit HTTP documentado pela Meta, não desconexão de socket).
