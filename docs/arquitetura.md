# Arquitetura do TechTie Flow

Visão de conjunto de como o sistema está montado **hoje** (24/10/2026). O planejamento de capacidade para centenas de
números está em [arquitetura-hospedagem.md](arquitetura-hospedagem.md); aqui é o que existe no código.

## 1. Dois modos, um processo

`src/server.js` é um único processo Node (CommonJS, sem framework) que sobe em um de dois modos:

| Modo | Quando | O que faz |
|---|---|---|
| **Demonstração** | sem `DATABASE_URL`/`AUTH_TOKEN_SECRET` (ou site estático da Vercel) | serve só `public/` (+ `/shared`) com **dados fictícios no navegador** (`public/js/mock/data.js`). Sem login real, sem banco, sem WhatsApp |
| **Operação** | com `DATABASE_URL` e `AUTH_TOKEN_SECRET` | liga também a **API** (`/api/*`), o **WebSocket** (`/ws`), o canal de **WhatsApp** (Baileys) e o **Agente de IA** |

O navegador descobre o modo por `window.__TTF__.live` em `/config.js` (o servidor gera o arquivo no modo operação; no site
estático, `scripts/build-static.mjs` o gera a partir de `TTF_API_URL`). Ver [frontend.md](frontend.md).

```
navegador ──HTTPS──► Coolify (Traefik, TLS) ──► contêiner techtie-flow :3333
                                                  ├─ estáticos: public/ e /shared (módulos isomórficos)
                                                  ├─ API REST  /api/*      (src/api)
                                                  ├─ WebSocket /ws         (src/api/ws.js)
                                                  ├─ WhatsApp  Baileys     (src/channels/baileys.js) ◄── volume /app/auth_session
                                                  ├─ Agente de IA          (src/ai) ──► OpenAI
                                                  └─► Supabase: Postgres (RLS) + Storage de mídia
```

Ordem de inicialização no modo operação (`server.js`): pool Postgres → hub de WebSocket → cliente OpenAI → runtime da IA →
canal Baileys (se `WHATSAPP_ENABLED` não for `false`) → `createApp` (rotas). Rotas fora de `/api` caem nos estáticos e, para
caminhos desconhecidos, no `index.html` (SPA).

## 2. Multi-tenant e isolamento

- **Um código, várias empresas.** Toda tabela de negócio tem `tenant_id`; o Postgres impõe o isolamento com **RLS FORCE**.
- A aplicação conecta como **`app_user`** (sem `BYPASSRLS`), nunca como `postgres`. Cada requisição abre uma transação com
  `withTenant`/`tx` (`src/db-tenant.js`, `src/api/app.js`), que grava `app.tenant_id`, `app.user_id`, `app.team_ids`,
  `app.team_tree_ids` e os alcances de leitura por tabela com `set_config(..., true)` (valem só naquela transação).
- **Armadilha conhecida:** com RLS FORCE e sem `app.tenant_id` o Postgres **não mostra nenhuma linha** (um `UPDATE` afeta 0).
  Backfills em migração precisam definir o tenant, empresa por empresa (foi o caso da migração 0008).
- FKs compostas `(id, tenant_id)` impedem um registro de apontar para outro tenant.
- A identidade de login (senha, tentativas, convites) fica em tabela fora do alcance direto do papel da aplicação, acessada por
  funções `SECURITY DEFINER` (migração 0002).

Detalhes em [banco.md](banco.md) e [permissoes-banco.md](permissoes-banco.md).

## 3. Permissões (a regra única)

O motor em `shared/permissions/` é **ESM isomórfico**: o navegador o carrega por `/shared/permissions/...` (esconde botões e campos)
e o servidor o importa dinamicamente (`src/api/access.js`) para **decidir de verdade**. O front é apenas reflexo.

- **Catálogo** (`catalog.js`): entidades × ações × alcance (`none < own < team < team_tree < tenant`), atributos, campos
  ocultáveis/travaveis (`deal.value`, `contact.phone`…), partições (funil, instância) e ações *sensíveis*.
- **Decisão** (`engine.js`): `decide(ctx, entidade, ação, linha, contexto)` → `allow`, `deny` ou `approval`. **Permissões somam**
  entre os perfis da pessoa; **restrições vencem** (uma negação ou campo oculto em qualquer perfil prevalece); isolamento de tenant
  é incondicional; **falha fechado** (entidade, ação ou atributo desconhecido = negado). `filterFor` gera o filtro de listas
  (a mesma regra decide o objeto e a lista), `checkPatch` confere campos alterados, `maskRow` remove campos ocultos e `expr.js`
  compila a regra para **SQL** (o banco repete a barreira).
- **Perfis de fábrica** (`roles.js`, travados por uma matriz dourada nos testes): Admin, Gestor, Atendente, SDR, Financeiro e
  Somente leitura. São imutáveis; a empresa **clona** e ajusta, sem escalonamento (quem cria perfil não concede o que não tem).
- No servidor: `must(access, entidade, ação, linha, contexto)` nas rotas, `listWhere` nas listas, auditoria em `audit_log`.
- Compartilhamento por registro (`resource_shares`) vale para negócios e tarefas.

Contrato completo, decisões e revisão de segurança: [permissoes.md](permissoes.md).

## 4. API e tempo real

- `src/api/app.js` mantém um **registro de rotas**: `route(método, caminho, handler, { limit })`. O handler recebe
  `{ req, res, params, query, body, access }` e devolve o objeto de resposta (JSON). Erros usam `HttpError` (`bad`, `notFound`).
  Módulos de rota (`routes-crm`, `routes-tasks`, `routes-pipelines`, `routes-chat`, `routes-import`, `ai-routes`, `dashboard`)
  recebem o mesmo conjunto de ajudantes (`H`) e se registram em `app.js`.
- **Login**: senha com scrypt, token assinado HMAC-SHA256 (12 h por padrão), bloqueio por tentativas, limitadores por IP.
  **Convite**: link de uso único (`/#/accept?...`). O token do navegador fica na `sessionStorage`.
- `GET /api/bootstrap` entrega, de uma vez, tudo o que a pessoa **pode ver**: usuários, perfis, equipes, funis e motivos de perda,
  contatos, negócios, produtos, tarefas, conversas, instâncias, agente de IA, permissões efetivas e metas.
- **WebSocket** (`/ws?ticket=…`; o ticket de 30 s vem de `POST /api/ws-ticket`): canal só servidor → cliente. Cada evento é
  entregue **só a quem o motor permitiria ler** aquele dado (`emit` com checagem; `emitTo` para lista fixa de pessoas, usado no
  chat interno). Eventos: `ready`, `message`, `instance` (com o QR), `tasks`, `pipelines`, `directory`, `chat`.
- Lista de rotas, permissões e códigos: [api.md](api.md).

## 5. WhatsApp (Baileys)

- Núcleo herdado do DapZap: `src/sessions.js` (gerenciador de sessões, **fila de pareamento** com `MAX_CONCURRENT_PAIRINGS`,
  reconexão com backoff e **teto** `MAX_RECONNECT_ATTEMPTS`) e `src/whatsapp.js`. Lições e riscos (ban, restrição 403):
  [whatsapp-gateway-licoes-herdadas.md](whatsapp-gateway-licoes-herdadas.md).
- `src/channels/baileys.js` liga o núcleo ao banco. Cada número é uma sessão `<tenantId>_<instanceId>`; a interface usada pelo
  resto do sistema é só `connect / disconnect / sendText / state` (o futuro `CloudApiChannel` terá a mesma forma).
- `src/channels/ingest.js` grava o que chega, **idempotente**: contato → conversa → mensagem, com dedupe pelo id do WhatsApp,
  fila para conversa nova, atribuição a quem responde primeiro. Histórico é processado em série e limitado (só conversas recentes).
- **Números da empresa × pessoais**: `instances.owner_id` nulo = número da empresa (conversa nova vai para a fila); preenchido =
  número pessoal (vai direto ao dono). Ver [piloto.md](piloto.md).
- As credenciais ficam em disco (`AUTH_FOLDER`, volume persistente). Perder o volume obriga a ler o QR de novo.
- Mídia recebida: Supabase Storage quando configurado; senão `MEDIA_FOLDER`. Envio de mídia pela Inbox **ainda não existe** (só texto).

## 6. Agente de IA

`src/ai/`: `agent.js` (puro: quebra a base em trechos de ~900 caracteres, escolhe os mais parecidos por termos, monta o prompt,
interpreta a resposta JSON), `openai.js` (cliente), `runtime.js` (quando responder). Responde mensagem **nova** de cliente quando o
número tem a IA ligada, a conversa não tem atendente, não foi pausada, não passou do limite de respostas e do teto diário de
tokens. Humano que responde **pausa** a IA; ela mesma transfere quando precisa. Erro da OpenAI = silêncio. A chave nunca vai ao
navegador. Detalhes: [ia.md](ia.md).

## 7. Dashboard

`src/api/dashboard.js` calcula no banco, respeitando as permissões de cada pessoa (conversas, negócios e relatórios):
novos leads (conversas cuja 1ª mensagem do cliente caiu no período), conversas ativas, conversão (ganhos ÷ ganhos+perdidos),
receita ganha, barras por hora/dia, funil do pipeline com mais negócios e desempenho por pessoa — incluindo a **mediana** do tempo
até a 1ª resposta (a média era distorcida por conversas antigas respondidas dias depois). Fuso fixo do Brasil (UTC−3).

## 8. Módulos isomórficos

`shared/` roda igual no navegador e no servidor, sem dependências: `permissions/` e `import/rules.js` (as regras do CSV são as
mesmas na tela e na API). No navegador chegam por `/shared/...` (no site estático, `build-static` copia a pasta para `dist/shared`);
no servidor, por `import()` dinâmico. Os testes de tela mapeiam `/shared/` com um carregador (`test/permissions/shared-loader.mjs`).

## 9. Build, imagem e publicação

- **Sem build** para o front: módulos ES nativos servidos como estão. `npm run build:static` só copia `public/` + `shared/` para
  `dist/` (Vercel) e confere se toda referência absoluta existe.
- `Dockerfile`: `node:22-bookworm-slim`, `npm ci --omit=dev`, `COPY . .`, `AUTH_FOLDER=/app/auth_session`, porta 3333, healthcheck em
  `/api/health`. Qualquer arquivo versionado entra na imagem.
- Publicação: Coolify (build pack Dockerfile) a partir da `main`. **Push não publica; é preciso Redeploy.** Passo a passo:
  [deploy-vps.md](deploy-vps.md). CI (GitHub Actions) roda a verificação de sintaxe e a suíte de testes ([testes.md](testes.md)).

## 10. Limites conhecidos (hoje)

- Um único contêiner com todos os números: serve ao piloto (dezenas de números). Escala para centenas: workers, credenciais no
  banco e Redis, ver [arquitetura-hospedagem.md](arquitetura-hospedagem.md).
- Cache de acesso do usuário de 5 s (mudança de perfil/suspensão vale quase na hora, não instantaneamente).
- Token de login em `sessionStorage` (migrar para cookie `httpOnly` quando front e API estiverem sob o mesmo domínio de cookies).
- Marca/domínio personalizado e a criação/edição de **equipes** pela tela não são persistidos no servidor (perfis de acesso, convite, suspensão e atribuição de equipes a usuários são).
- Motor de automações no servidor, Cloud API oficial, envio de mídia e campos personalizados: no [roadmap](roadmap-recursos.md).
