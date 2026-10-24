# Testes

`npm test` roda tudo com o executor nativo do Node (`node --test "test/**/*.test.mjs"`). Estado em 24/10/2026: **846 testes, 840 passam,
0 falham, 6 `todo`** (achados de segurança/integração documentados e ainda não corrigidos, marcados `# TODO` no próprio teste).

## O que existe

| Pasta | O que cobre | Precisa de |
|---|---|---|
| `test/permissions/` | **Motor de permissões** (`shared/permissions`): decisões, escalonamento, falha fechada, propriedades (aleatórias), matriz dourada dos perfis de fábrica, validação, expressões→SQL, interface simples | só Node |
| `test/permissions-sql/` | O mesmo motor **contra Postgres real**: esquema, isolamento por RLS entre empresas, teste **diferencial** (o filtro SQL nunca é menor que o motor) | Docker |
| `test/api/*.test.mjs` (modelos) | Regras **puras** do front e do servidor: `lists-model`, `funnels-model`, `chat-model`, `profile-model`, `home-model`, `home-goals`, `tasks-model`, `search-model`, `csv`, `import-rules`, `fields-model`, `live-state`, `ai-agent`, `baileys-state`, `sessions-paired`, `logging` | só Node |
| `test/api/api.test.mjs` | **API de ponta a ponta** contra Postgres real: login, convite, permissões por perfil, conversas, negócios, funis, tarefas, chat, perfil, CSV, metas, dashboard, IA (OpenAI simulada), WebSocket (entrega só a quem pode ver) | Docker |
| `test/api/db-pilot.test.mjs`, `server-smoke.test.mjs` | Camada do piloto (migração 0002, seed, login, backfill 0008) e o servidor subindo | Docker |
| `test/ui/` | **Telas executadas num DOM simulado** (linkedom): Início, Negócios, página do negócio, Contatos, Tarefas, Funis, CSV, chat, perfil, campos pt-BR, modais/viewport, efeitos, casca do app, "smoke" que monta todas as telas com vários perfis | só Node |

Docker: os testes de banco sobem um **Postgres descartável** (`postgres:16-alpine`, nome `ttf-pgtest-*`, porta livre aleatória), aplicam as
migrações e **sempre removem** o contêiner (também em sinal/saída). Sem Docker, sem a imagem baixada (`docker pull postgres:16-alpine`) ou
com `TTF_SKIP_SQL_TESTS=1`, esses testes são **pulados** (não falham). `TTF_PG_PATH` aponta um `node_modules/pg` externo se preciso.

## Rodando

```bash
npm test                                          # tudo
node --test test/api/csv.test.mjs                 # um arquivo
node --test test/ui/tasks-ui.test.mjs test/api/live-state.test.mjs
TTF_SKIP_SQL_TESTS=1 npm test                     # sem Docker
```

Em Windows, o Docker Desktop precisa estar rodando. Saída longa: filtre por `^# (tests|pass|fail)|^not ok`.

## Testes de tela (DOM simulado)

`test/ui/dom-env.mjs` instala `window/document` (linkedom) e **complementa o que ele não tem**: `select.value`, `selectedOptions`,
`matchMedia`, `localStorage`, `Event`… e registra o carregador que mapeia `/shared/…` para a pasta `shared/` (o navegador importa por
essa URL). Ajudantes: `fire(el, tipo, extra)`, `tick(ms)`, `waitFor(cond)`, `$`, `$$`, `text`.

Armadilhas já pagas:
- **Não use `assert.equal(elemento, null)`**: se falhar, o Node tenta serializar o DOM e estoura a memória. Use `assert.ok(!elemento)`.
- Handlers assíncronos protegidos por `busy` precisam de `await tick()` entre ações.
- A memória de listas (`memory` em `lists/table.js`) **persiste entre testes do mesmo arquivo**; limpe o `localStorage`/estado no começo.
- `linkedom` não envia o formulário ao clicar no botão: dispare `submit` no `<form>`.
- Campos que trocam o `value` do elemento (`timeField`) precisam de escrita "crua" nos testes (ver `rawSet` em `test/ui/fields-ui.test.mjs`).
- Esses testes **não medem layout** (CSS, pixels, rolagem). Para modais, celular e animações há apenas testes estáticos do CSS
  (`test/ui/overlays.test.mjs`); a conferência visual é no navegador.

## Quando mexer em…

| Mudança | Teste a criar/atualizar |
|---|---|
| Regra pura (filtros, prazos, CSV, valores) | `test/api/<área>-model.test.mjs` |
| Rota nova | caso em `test/api/api.test.mjs` (permissão por perfil, isolamento entre empresas, auditoria) |
| Migração nova | listá-la nos carregadores (`api.test`, `db-pilot.test`, `server-smoke`, `_harness`) e testar o efeito |
| Tela nova | `test/ui/<tela>-ui.test.mjs` + conferir `screens-smoke.test.mjs` |
| Permissão/perfil de fábrica | matriz dourada em `test/permissions/golden.test.mjs` (mudar perfil sem querer **quebra** o build) |

## Integração contínua

`.github/workflows/ci.yml` (GitHub Actions, em `push` e `pull_request` na `main`): instala com `npm ci`, checa a **sintaxe** de todo
`.js` e roda `npm test` (o runner do GitHub tem Docker, então os testes de banco também rodam).

## O que os testes NÃO provam

- Conexão com um WhatsApp **de verdade** (testada com canal falso; o gateway herdado roda em produção no DapZap).
- Aparência e comportamento no navegador (layout, teclado do celular, animações): conferir à mão após cada Redeploy.
- Chamadas reais à OpenAI (simulada nos testes).
