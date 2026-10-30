# CLAUDE.md — guia para quem mexe neste repositório

TechTie Flow: CRM + contact center white-label com WhatsApp (Baileys), multi-tenant, Postgres/Supabase com RLS. Node 22 (CommonJS no
servidor, ES modules no front e em `shared/`). Idioma do produto e dos comentários: **português do Brasil**. Visão geral em
[README.md](README.md); índice em [docs/README.md](docs/README.md).

## Comandos

```bash
npm start                      # http://localhost:3333 (sem env = modo demonstração; com DATABASE_URL + AUTH_TOKEN_SECRET = operação)
npm test                       # suíte completa (~846 testes; os de Postgres usam Docker e são pulados sem ele)
node --test test/ui/x.test.mjs # um arquivo
node db/migrate.mjs            # aplica db/migrations/*.sql (precisa de DIRECT_URL; idempotente)
npm run build:static           # dist/ para site estático (Vercel)
```

## Mapa rápido

- `src/api/app.js` registro de rotas (`route(método, caminho, handler, { limit })`); módulos `routes-*.js`, `ai-routes.js`, `dashboard.js`.
- `src/api/access.js` + `shared/permissions/` motor de permissões (a **mesma** regra no navegador, no servidor e no SQL).
- `public/js/app.js` shell + rotas; `store.js` estado; `live.js` + `live-state.js` modo operação; `screens/<tela>/` telas; `fields/`, `lists/`, `fx.js`.
- `db/migrations/NNNN_*.sql` esquema; `test/` testes (ver [docs/testes.md](docs/testes.md)).

## Regras que não se quebra

1. **Permissão é decidida no servidor** (`must(access, entidade, ação, linha, contexto)`); a tela só reflete. O contexto da operação
   (etapa de destino, quantidade) é **derivado no servidor**, nunca copiado do corpo da requisição. Respostas passam por `maskRow`.
2. **Todo dado de negócio tem `tenant_id` + RLS FORCE.** A aplicação usa `app_user` (sem BYPASSRLS), sempre dentro de `tx`/`withTenant`.
   **Armadilha:** com RLS FORCE e sem `app.tenant_id` o `UPDATE` afeta 0 linhas; backfill de migração é empresa por empresa.
3. **Sem `innerHTML`** no front: use `h()`. Texto de usuário nunca vira HTML.
4. **Sem segredo no Git, no chat ou em argumentos de comando.** `.env` não é versionado; chaves ficam no Coolify como *secret*.
5. **Dado de demonstração não pode aparecer em operação** (ver `dropDemoData` em `public/js/live-state.js`). O que o servidor não guarda
   começa vazio e a tela avisa, em vez de fingir.
6. **Campos de data, hora e contato:** use `public/js/fields/` (os nativos seguem o idioma do navegador e não escalam com milhares de contatos).
7. **Modais:** largura por `--modal-w` (nunca `width` inline), folha de baixo no celular, medidas por `--vvh/--vvt` (nunca `100vh`).
   Ponto de corte do celular: 820 px. Animações respeitam `prefers-reduced-motion`.
8. Visual **sóbrio, preto e dourado da marca**; nada de "cara de IA genérica".

## Fluxo de trabalho

- **Push não publica.** A produção (https://crm.techtie.digital, Coolify) só muda com *Redeploy*. Mantenha `APP_URL=https://crm.techtie.digital`.
- **Migração nova:** crie o arquivo, liste-a nos carregadores de teste (`test/api/api.test.mjs`, `db-pilot.test.mjs`, `server-smoke.test.mjs`,
  `test/permissions-sql/_harness.mjs`), aplique na produção com `node db/migrate.mjs` **antes** do Redeploy e atualize [docs/banco.md](docs/banco.md).
- **Regra de negócio nova:** lógica pura em `model.js` (testada em Node) + tela fina. Rota nova: teste em `test/api/api.test.mjs` contra Postgres
  real (permissão por perfil, isolamento entre empresas, auditoria).
- **Documentação no mesmo commit** da mudança (índice e regras em [docs/README.md](docs/README.md)); entrada no [CHANGELOG.md](CHANGELOG.md).
- A pasta local `imagens 8-10/` **não é versionada** (nunca `git add -A` sem excluí-la: `git add -A -- . ':!imagens 8-10'`).
- `Dockerfile` usa `COPY . .`: arquivo versionado entra na imagem (cuidado com tamanho e segredos).

## Testes: armadilhas

- Telas rodam num DOM simulado (linkedom; `test/ui/dom-env.mjs`): **não medem layout**. Para celular/modais, só testes estáticos do CSS
  (`test/ui/overlays.test.mjs`) e conferência no navegador após o Redeploy.
- Não faça `assert.equal(elementoDom, null)` (serializar o DOM estoura a memória); use `assert.ok(!el)`.
- Handlers assíncronos com `busy` precisam de `await tick()`; `linkedom` não envia `<form>` ao clicar: dispare `submit`.
- A memória de listas (`lists/table.js`) persiste entre testes do mesmo arquivo.

## Ambiente Windows

Scripts de edição com muitas aspas ou barras: grave em arquivo (Python em `.claude/tmp/`) em vez de *heredoc* no shell. `.claude/tmp/` é rascunho
local. Docker Desktop precisa estar rodando para os testes de banco.

## Onde está o quê (documentos por assunto)

Permissões → [docs/permissoes.md](docs/permissoes.md) · Banco → [docs/banco.md](docs/banco.md) · API → [docs/api.md](docs/api.md) ·
Front → [docs/frontend.md](docs/frontend.md) · Variáveis → [docs/configuracao.md](docs/configuracao.md) · Deploy → [docs/deploy-vps.md](docs/deploy-vps.md) ·
Roadmap → [docs/roadmap-recursos.md](docs/roadmap-recursos.md) · Histórico → [docs/historico.md](docs/historico.md).

## Próximos passos combinados

3) **Automações de verdade** (motor no servidor, robôs por etapa primeiro) · 4) **Campos personalizados** · 5) **Mascote de IA** (a desenhar:
nome, personalidade, onde mora, fase inicial) · e persistir **marca/domínio** no servidor. Detalhes em [docs/roadmap-recursos.md](docs/roadmap-recursos.md).
