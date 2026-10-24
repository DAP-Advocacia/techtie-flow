# API do TechTie Flow

Referência das rotas de `src/api/`. Tudo é JSON em UTF-8. A API só existe no **modo operação** (com `DATABASE_URL` e
`AUTH_TOKEN_SECRET`). O front a chama por `public/js/live.js`.

## Convenções

- **Autenticação:** `Authorization: Bearer <token>` (token HMAC-SHA256 emitido no login). Rotas públicas: `POST /api/auth/login`,
  `POST /api/auth/accept-invite`, `GET /api/health`, `GET /config.js` e os estáticos. O token do navegador fica na `sessionStorage`.
- **Autorização:** nenhuma rota confia no front. Cada uma chama `must(access, entidade, ação, linha, contexto)` (motor de
  [permissões](permissoes.md)); listas usam o filtro do motor; campos ocultos saem de toda resposta (`maskRow`). O contexto de uma
  operação (etapa de destino, quantidade exportada…) é **derivado no servidor**, nunca copiado do corpo.
- **Tenant:** vem do token. Cada requisição roda numa transação com o contexto do tenant (RLS), ver [banco.md](banco.md).
- **Erros:** `{ "error": "mensagem em português" }` com `400` (dado inválido), `401` (sem login), `403` (o motor negou; a mensagem
  diz o motivo), `404`, `409` (conflito, ex.: nome repetido), `429` (limite de tentativas), `503` (OpenAI sem chave).
- **Limites:** corpo padrão pequeno; importação de CSV até 2,5 MB; documentos da IA até 9 MB (arquivo de 6 MB). Login, convite e IP
  têm limitadores (`makeLimiter`).
- **Auditoria:** operações que mudam dados gravam em `audit_log` (`ator, ação, entidade, id, diff, IP`). Ações usadas hoje:
  `ai_agent.update|doc.add|doc.remove`, `chat.group_create|group_add`, `contact.update|delete|import|export`,
  `conversation.resolve|transfer`, `deal.create|update|delete|share|unshare|import|export`, `instance.create|update|delete`,
  `pipeline.create|update|delete|stages|loss_reasons`, `product.create|update`, `profile.update`, `proposal.send`,
  `role.create|update|delete|assign`, `task.create|update|delete|delegate|share|unshare`, `tenant.goals`, `user.invite|teams`.

## Sessão e dados iniciais

| Rota | O que faz |
|---|---|
| `POST /api/auth/login` | `{ email, password }` → `{ token, ... }`. Bloqueia por tentativas; gasta o mesmo tempo se o e-mail não existe |
| `POST /api/auth/accept-invite` | `{ token, password }` — usa o convite (uso único) e define a senha (10 a 200 caracteres); depois é só entrar no login |
| `GET /api/health` | `{ ok: true }` (healthcheck do Docker/Coolify) |
| `GET /api/me` | usuário, tenant e **permissões efetivas** |
| `PATCH /api/me` | o **próprio** perfil: `name`, `jobTitle`, `phone`, `bio` (ignora qualquer outro campo) |
| `POST /api/ws-ticket` | ticket de 30 s para abrir o WebSocket |
| `GET /api/bootstrap` | tudo que a pessoa pode ver: `tenant` (política, metas), `users`, `roles`, `teams`, `pipelines` (com etapas e probabilidade), `lossReasons`, `contacts`, `deals`, `products`, `tasks`, `conversations`, `instances`, `agent`, `permissions` |
| `GET /config.js` | `window.__TTF__ = { live: true, apiUrl: '' }` (gerado pelo servidor) |

## CRM

| Rota | Permissão | Notas |
|---|---|---|
| `POST /api/contacts` | `contact.create` | nome, empresa, telefone (normalizado), e-mail |
| `PATCH /api/contacts/:id` · `DELETE …` | `contact.update` · `contact.delete` | campos travados por perfil são recusados |
| `POST /api/deals` | `deal.create` | `{ title, pipelineId, stageId, contactId?, value?, ownerId?, expectedClose? }`; dono diferente só se o motor permitir criar para ele |
| `PATCH /api/deals/:id` | `deal.update` / `move` / `transfer` | título, valor, previsão (`expectedClose`), etapa (com `lossReason` quando há lista de motivos), responsável, itens da proposta |
| `DELETE /api/deals/:id` | `deal.delete` | |
| `POST·DELETE /api/deals/:id/shares[/:type/:subjectId]` | `deal.share` | compartilhar com pessoa ou equipe (ver / editar) |
| `POST /api/deals/:id/proposal/send` | `proposal.send` | envia a proposta pelo WhatsApp |
| `GET /api/deals/:id/activity` | leitura do negócio | linha do tempo real (auditoria + tarefas ligadas) |
| `POST /api/products` · `PATCH /api/products/:id` | `product.create|update` | catálogo usado nas propostas |
| `PATCH /api/tenant/goals` | `tenant_settings.update` | `{ monthlyRevenue }` — meta do mês (guardada em `tenants.settings.goals`) |

### Funis (`routes-pipelines.js`)
`POST /api/pipelines` (`pipeline.create`) · `PATCH /api/pipelines/:id` (renomear) · `PUT /api/pipelines/:id/stages` (lista inteira na
ordem da tela: 3 a 30 etapas, ao menos uma de cada tipo; etapa com negócio não some nem muda de tipo; mantém o id) ·
`DELETE /api/pipelines/:id` (só sem negócios; sempre sobra um) · `PUT /api/loss-reasons` (até 30 motivos de 80 caracteres).
Auditoria `pipeline.*`; o tempo real avisa `pipelines`. Ver [funis.md](funis.md).

### Tarefas (`routes-tasks.js`)
`POST /api/tasks` · `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id` · `POST /api/tasks/:id/delegate` (`task.transfer`) ·
`POST·DELETE /api/tasks/:id/shares[/:type/:subjectId]` (`task.share`) · `GET·POST /api/tasks/:id/comments`. As tarefas vêm no
bootstrap (concluídas há mais de 30 dias ficam de fora). Ver [tarefas.md](tarefas.md).

### CSV (`routes-import.js`)
`POST /api/exports` — registra a exportação na auditoria **antes** de a tela baixar o arquivo (confere `export` do motor).
`POST /api/import/contacts` (`contact.create` + `contact.import`) e `POST /api/import/deals` (`deal.import`; cada linha passa
pelo motor como criação manual). Até 2000 linhas por chamada; regras em `shared/import/rules.js`; resposta com criados, de fora (linha
e motivo) e contatos novos. Ver [csv.md](csv.md).

## Atendimento

| Rota | Notas |
|---|---|
| `GET·POST /api/conversations/:id/messages` | histórico e envio de texto pelo WhatsApp (a conversa precisa ser visível; responder atribui a quem respondeu e pausa a IA) |
| `POST /api/conversations/:id/read` | zera não lidas |
| `PATCH /api/conversations/:id` | `status` (`open`/`queue`/`resolved`, exige `conversation.resolve`) e `assigneeId` (exige `conversation.transfer`) |
| `GET /api/whatsapp/media/:filename` | mídia recebida (checa a permissão da conversa) |
| `POST /api/instances` | cria número (`companyNumber: true` para número da empresa) — `instance.create` |
| `PATCH·DELETE /api/instances/:id` | renomear, vincular, ligar a IA; remover de verdade |
| `POST /api/instances/:id/connect` · `/disconnect` · `GET …/qr` | pareamento por QR (o QR também chega pelo WebSocket) — `instance.connect` |

### Chat interno (`routes-chat.js`)
`GET·POST /api/chat/rooms` (direta ou grupo, até 50 pessoas ativas da empresa) · `POST /api/chat/rooms/:id/members` (só grupo) ·
`GET·POST /api/chat/rooms/:id/messages` (até 4000 caracteres; não se editam nem apagam) · `POST /api/chat/rooms/:id/read`. Só
**participantes** leem e escrevem (nem o Admin lê conversa alheia); não passa pelo motor. Ver [chat-e-perfil.md](chat-e-perfil.md).

## Administração

`POST /api/users/invite` (`user.create` + `role.assign`; devolve o link, que usa o endereço do próprio site) ·
`PATCH /api/users/:id` (`user.update`, inclui suspender/reativar) · `POST /api/users/:id/roles` (`role.assign`) ·
`POST /api/users/:id/teams` · `POST /api/roles` · `PATCH·DELETE /api/roles/:id` (sem escalonamento: não dá para conceder o que
não se tem; perfis de sistema são imutáveis).

## Agente de IA e Dashboard

| Rota | Permissão | Notas |
|---|---|---|
| `GET·PUT /api/ai-agent` | `ai_agent.read|update` | personalidade, regras de transbordo, limite de respostas; devolve a base, `configured`, modelo e tokens do dia |
| `POST /api/ai-agent/docs` | `ai_agent.update` | `{ name, base64 }` ou `{ name, text }`: PDF, DOCX, TXT, MD, CSV; 40 documentos, 6 MB |
| `DELETE /api/ai-agent/docs/:id` | `ai_agent.update` | |
| `POST /api/ai-agent/test` | `ai_agent.read` | fala com a OpenAI com o que está **salvo**, sem enviar nada ao WhatsApp; 20 por minuto |
| `GET /api/dashboard` | `report.read` (+ ler conversas/negócios) | períodos `today` (Hoje), `week` (7 dias) e `month` (30 dias) com KPIs, variações, barras, funil e equipe; números que o perfil não pode ver vêm zerados |

## Tempo real (`/ws?ticket=…`)

Servidor → cliente, JSON `{ type, ... }`, entregue só a quem poderia ler o dado:

| `type` | Quando | Quem recebe |
|---|---|---|
| `ready` | ao conectar | a própria pessoa |
| `message` | mensagem nova ou status de entrega, com a conversa | quem pode ler aquela conversa |
| `instance` | estado do número (e o QR durante o pareamento) | quem pode ler (ou conectar, se há QR) o número |
| `tasks` | alguém recebeu, perdeu ou ganhou acesso a uma tarefa | as pessoas afetadas |
| `pipelines` | funil ou motivo de perda mudou | todos do tenant (recarregam) |
| `directory` | nome/dados de pessoa mudaram | todos do tenant |
| `chat` | mensagem, sala ou leitura no chat interno | só os participantes (`emitTo`) |

O cliente (`live.js`) reconecta sozinho e refaz o bootstrap incremental quando preciso.
