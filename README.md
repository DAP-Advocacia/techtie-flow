# TechTie Flow

CRM + Contact Center **white-label** com **WhatsApp como canal nativo** de atendimento.
Produto comercial (SaaS multi-tenant) da TechTie — não confundir com o **DapZap**, o produto interno
usado hoje pelo escritório de advocacia, que roda só integrado ao Bitrix24.

O repositório nasceu como fork de `whatsapp-crm-gatway` (DapZap), aproveitando a base madura de conexão
WhatsApp via Baileys (ver [docs/whatsapp-gateway-licoes-herdadas.md](docs/whatsapp-gateway-licoes-herdadas.md)).
Desde então os dois projetos evoluem de forma independente: nenhuma correção em um se propaga sozinha para o outro.

> **Em produção (piloto):** https://crm.techtie.digital — um único contêiner Docker na VPS (Hostinger + Coolify),
> banco no Supabase (São Paulo). `git push` na `main` **não publica**: é preciso clicar em *Redeploy* no Coolify.

---

## Status (24/10/2026)

O produto saiu da fase de protótipo e opera de verdade: banco real com isolamento por empresa, login, permissões
aplicadas no servidor, WhatsApp (Baileys), tempo real, Agente de IA com OpenAI e dashboard com números reais.
Continua existindo um **modo demonstração** (dados fictícios no navegador, sem servidor) usado no site estático e
nos testes de tela.

### O que já funciona em operação

| Área | O que existe |
|---|---|
| **Acesso** | Login (scrypt + token assinado, bloqueio por tentativas), convite de usuário por link de uso único, perfis e equipes |
| **Permissões** | Motor `entidade × ação × alcance` (nenhum / só o dele / equipe / equipe e subequipes / tudo), campos ocultos ou travados por perfil, compartilhamento por registro, auditoria; decidido **no servidor** e no banco (RLS) |
| **Inbox** | Conversas de WhatsApp (fila, atribuir, transferir, resolver, notas), tempo real entregue só a quem pode ver; **chat interno** (direto e grupos) alternando na mesma aba |
| **WhatsApp** | Números pela Baileys (QR), número da empresa ou pessoal, fila de pareamento, reconexão com teto; Cloud API oficial **ainda não** |
| **Negócios** | Funis **configuráveis pela tela** (etapas, probabilidade, motivos de perda), quadro Kanban com painel recolhível, lista em tabela (colunas, filtros, visões salvas, ações em massa), página do negócio (Path, abas, atividade), propostas com produtos, previsão de fechamento e receita ponderada |
| **Contatos** | Lista e ficha, tabela com filtros e visões, tags, atividade, "+ Negócio" |
| **CSV** | Exportar a lista filtrada e **importar** contatos e negócios com assistente em 4 passos ([docs/csv.md](docs/csv.md)) |
| **Tarefas** | Individuais, compartilháveis e delegáveis, avulsas ou ligadas a negócio/contato, criação rápida em português |
| **Agente de IA** | Responde clientes no WhatsApp sozinho (OpenAI), base de conhecimento (PDF/DOCX/TXT/MD/CSV), regras de transbordo, teto diário de tokens |
| **Dashboard / Início** | Indicadores reais (leads, conversas ativas, conversão, receita, funil, desempenho por pessoa, mediana de 1ª resposta); Início com "Para hoje", "Fechando este mês" e meta de receita |
| **Perfil** | "Meu perfil": nome, cargo, telefone e sobre |
| **Experiência** | Visual preto e dourado da marca, PWA instalável, celular com navegação própria, animações sóbrias (estrelinhas, ondinha, esqueletos), campos de data e hora em pt-BR, busca global (Ctrl+K) |

### Ainda é demonstração ou ainda não existe

- **Automações:** o editor visual existe, mas o **motor que executa os fluxos no servidor não** (próximo item do roadmap). Em operação a tela abre vazia e avisa.
- **Marca e domínio personalizado:** o cartão em Configurações guarda só na tela; a verificação de CNAME é simulada.
- **Equipes:** criar/editar equipe pela tela ainda não grava no servidor (só atribuir equipes a um usuário grava). Perfis de acesso, convite e suspensão de usuário **gravam**; editar e-mail/nome de outro usuário e redefinir MFA, não.
- **Cloud API oficial da Meta**, ligações (VoIP), campos personalizados, mascote de IA, importação de `.xlsx`, troca de senha/e-mail pelo perfil, MFA.

A lista completa e priorizada está em [docs/roadmap-recursos.md](docs/roadmap-recursos.md); o histórico, em
[CHANGELOG.md](CHANGELOG.md) e [docs/historico.md](docs/historico.md).

---

## Rodando

Requisitos: **Node 22+**. Para a operação completa: Postgres (Supabase serve) e, para os testes de banco, Docker.

```bash
npm install
npm start          # http://localhost:3333  (PORT para mudar)
npm run dev        # idem, reinicia ao editar src/
npm test           # ~850 testes (precisa de Docker para os de Postgres; sem Docker eles são pulados)
```

Sem nenhuma variável de ambiente o servidor sobe em **modo demonstração**: serve só `public/` com dados fictícios.
Com `DATABASE_URL` e `AUTH_TOKEN_SECRET` ele liga também a API (`/api/*`), o WebSocket (`/ws`) e o WhatsApp.
O passo a passo está em [docs/piloto.md](docs/piloto.md); todas as variáveis, em [docs/configuracao.md](docs/configuracao.md).

```bash
cp .env.example .env                       # preencha DATABASE_URL, DIRECT_URL, AUTH_TOKEN_SECRET, APP_USER_PASSWORD
node db/migrate.mjs                        # aplica db/migrations/*.sql (idempotente) e define a senha do app_user
node db/seed.mjs                           # 1º tenant + administrador + funis (variáveis SEED_*)
npm start
```

## Estrutura do repositório

```
src/                    servidor Node (CommonJS)
  server.js             HTTP + estáticos + WebSocket; liga a API só se houver DATABASE_URL e AUTH_TOKEN_SECRET
  config.js             variáveis de ambiente
  api/                  API REST: app.js (registro de rotas, login, bootstrap, conversas, usuários, perfis),
                        routes-crm / routes-tasks / routes-pipelines / routes-chat / routes-import,
                        ai-routes, dashboard, access (permissões por requisição), ws (tempo real)
  channels/             baileys.js (canal WhatsApp), ingest.js (mensagem recebida → contato/conversa)
  ai/                   agent.js (prompt, busca na base), openai.js (cliente), runtime.js (quando a IA responde)
  sessions.js, whatsapp.js   núcleo Baileys herdado do DapZap
  db.js, db-tenant.js   pool Postgres e execução por tenant (RLS)
shared/                 módulos isomórficos (navegador e servidor)
  permissions/          motor de permissões (catálogo, engine, expr→SQL, validação, perfis de fábrica)
  import/rules.js       regras de importação CSV (a tela e o servidor usam as mesmas)
public/                 front-end SPA sem build (módulos ES nativos)
  js/                   app (shell + roteador), store, live (API), screens/, fields/, lists/, shell/, search/, mock/
  css/                  tokens, base e css/screens/<tela>.css
db/                     migrations/0001…0009, migrate.mjs, seed.mjs, read-scopes.mjs
test/                   api/ (modelos puros + API contra Postgres), permissions/, permissions-sql/, ui/ (DOM simulado)
docs/                   documentação (índice em docs/README.md)
scripts/build-static.mjs   gera dist/ (site estático em modo demonstração, ex.: Vercel)
Dockerfile              imagem única usada no Coolify
```

Detalhes em [docs/arquitetura.md](docs/arquitetura.md), [docs/frontend.md](docs/frontend.md), [docs/banco.md](docs/banco.md) e
[docs/api.md](docs/api.md).

## Decisões de produto fechadas

- **Multi-tenant com código único** (não um deploy por cliente). Isolamento por `tenant_id` no Postgres com RLS;
  white-label por subdomínio ou domínio próprio (CNAME), não por instância física separada.
- **WhatsApp: Baileys e Cloud API oficial lado a lado.** Baileys é grátis e conecta por QR, com risco de ban real (do número do
  cliente, deixado claro na tela e em contrato). A Cloud API (Meta) não tem risco de ban, cobra por mensagem e exige a TechTie ser
  Tech Provider. Implicação: `whatsapp.js` deve virar uma interface de canal com dois backends (hoje só o Baileys existe).
- **Permissões decididas no servidor e no banco**, nunca só na tela; o motor é único e compartilhado.
- **Front sem build e sem framework** (módulos ES, `h()` helper, sem `innerHTML`): dado de usuário nunca vira HTML.
- **Visual sóbrio e fiel à marca** (preto/dourado), sem cara de "IA genérica".
- **Fork independente do gateway** (não pacote compartilhado com o DapZap, por ora).

## Publicação

Contêiner único (site + API + WebSocket + WhatsApp) no Coolify, porta 3333, volume em `/app/auth_session`, health check em
`/api/health`. Passo a passo e checklist em [docs/deploy-vps.md](docs/deploy-vps.md). O site estático da Vercel (`npm run build:static`)
fica em modo demonstração, a menos que `TTF_API_URL` aponte uma API.

## Documentação

Índice completo em **[docs/README.md](docs/README.md)**. Principais:

| Documento | Assunto |
|---|---|
| [docs/arquitetura.md](docs/arquitetura.md) | Como as peças se encaixam (modos, processo, tempo real, IA, WhatsApp) |
| [docs/frontend.md](docs/frontend.md) | Front-end: roteador, store, modo operação, componentes, CSS, PWA |
| [docs/banco.md](docs/banco.md) | Tabelas, migrações, RLS e armadilhas |
| [docs/api.md](docs/api.md) | Rotas, autenticação, tempo real, auditoria |
| [docs/configuracao.md](docs/configuracao.md) | Variáveis de ambiente |
| [docs/testes.md](docs/testes.md) | Estratégia e como rodar os testes |
| [docs/permissoes.md](docs/permissoes.md), [docs/permissoes-banco.md](docs/permissoes-banco.md) | Motor de permissões e camada Postgres |
| [docs/piloto.md](docs/piloto.md), [docs/deploy-vps.md](docs/deploy-vps.md) | Colocar para operar e publicar |
| [docs/roadmap-recursos.md](docs/roadmap-recursos.md) | O que falta, em que ordem |
| [docs/historico.md](docs/historico.md), [CHANGELOG.md](CHANGELOG.md) | Como chegamos até aqui |

## Licença

Ver [LICENSE](LICENSE) — herdada do projeto de origem; revisar antes de qualquer distribuição ou venda comercial.
