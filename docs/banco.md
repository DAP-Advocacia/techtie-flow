# Banco de dados

Postgres (Supabase, São Paulo). Esquema versionado em `db/migrations/NNNN_nome.sql`, aplicado por `node db/migrate.mjs`.
O desenho do isolamento (RLS em três camadas, papéis, decisões) está em [permissoes-banco.md](permissoes-banco.md); aqui é o
mapa do que existe e como mexer com segurança.

## Papéis e conexões

| Papel | Uso | Conexão |
|---|---|---|
| `postgres` (administrador do Supabase) | **só** para migrar e semear | `DIRECT_URL` (sessão, porta 5432) |
| `app_user` | a aplicação em runtime; `NOBYPASSRLS`; **nunca** membro de `app_owner` | `DATABASE_URL` (pooler de transação) |
| `app_owner` | dono dos objetos (`NOLOGIN`) | — |

A senha do `app_user` não entra em migração: `APP_USER_PASSWORD=... node db/migrate.mjs` a define. Nunca coloque `DIRECT_URL` nem
`APP_USER_PASSWORD` no Coolify (só servem para migrar).

## Como migrar

```bash
node db/migrate.mjs     # lê db/migrations/*.sql em ordem, uma vez cada (tabela schema_migrations), idempotente
node db/seed.mjs        # 1º tenant + admin + funis (SEED_TENANT_NAME/SLUG, SEED_ADMIN_NAME/EMAIL/PASSWORD)
```

Regras ao escrever migração: idempotente (`IF NOT EXISTS`), cada arquivo roda numa chamada, **sem segredo**, sempre com RLS (ver abaixo)
e, se mexer em dados existentes, **um tenant por vez** (armadilha da RLS FORCE). Depois de criar uma migração, atualize os
carregadores dos testes que listam migrações (`test/api/api.test.mjs`, `test/api/db-pilot.test.mjs`, `test/api/server-smoke.test.mjs`,
`test/permissions-sql/_harness.mjs`). Migrações já aplicadas na produção piloto: **0001 a 0009**.

## Migrações

| # | Arquivo | O que traz |
|---|---|---|
| 0001 | `permissions` | Núcleo: `tenants`, `users`, `system_roles`, `roles`, `user_roles`, `teams`, `team_members`, `team_closure` (fechamento transitivo de equipes), `contacts`, `companies`, `deals`, `pipelines`, `pipeline_stages`, `conversations`, `proposals`, `tasks` (esqueleto), `calls`, `resource_shares`, `approvals`, `audit_log` (imutável), papéis `app_owner`/`app_user`, funções `app_*` (contexto da sessão), RLS FORCE em tudo |
| 0002 | `pilot` | `messages` (dedupe por id do WhatsApp), vínculos conversa↔contato↔negócio, `instances` (canal, status, telefone), `auth_identities` (login fora do alcance direto do papel) e funções `SECURITY DEFINER` `auth_register/auth_lookup/auth_login_result/auth_accept_invite` |
| 0003 | `personal_instances` | `instances.owner_id` e `team_id` (número pessoal × da empresa), FKs compostas |
| 0004 | `crm_ai` | `contacts.company`, `products`, Agente de IA (`ai_agents`, `ai_knowledge_docs`, `ai_usage`), `conversations.ai_paused/ai_replies`, `messages.by_ai`, `instances.ai_active`, `deals.proposal_sent_at` |
| 0005 | `tasks` | `tasks` completa (descrição, prioridade, prazo, vínculos, criador, checklist), `task_comments`, compartilhamento de tarefas em `resource_shares` |
| 0006 | `deal_expected_close` | `deals.expected_close` (data) |
| 0007 | `pipeline_config` | `pipeline_stages.probability`, `deals.lost_reason`, `loss_reasons` |
| 0008 | `pipeline_probability_backfill` | preenche a probabilidade dos funis antigos, **empresa por empresa** |
| 0009 | `chat_profile` | `users.job_title/phone/bio`, `chat_rooms`, `chat_members`, `chat_messages` |

Metas do mês ficam em `tenants.settings.goals` (JSON), não em tabela própria; a política do tenant (ex.: MFA para ações sensíveis),
em `tenants.settings`.

## Como o isolamento funciona (resumo)

1. **Tenant (camada 1):** toda política exige `tenant_id = app_tenant_id()`. A API define `app.tenant_id` em cada transação
   (`withTenant`/`tx`). `forbid_tenant_change` impede mover linha de empresa.
2. **Teto de leitura (camada 2):** `deals`, `contacts` e `conversations` têm política por alcance (`app.read_scope_<tabela>`), calculada
   a partir do **motor** (`db/read-scopes.mjs`): o maior alcance que qualquer permissão da pessoa dá, ignorando condições. É um superset
   do que o motor deixa ver; o motor afina por cima. Um teste diferencial prova que nunca é menor.
3. **Motor (camada 3):** `filterFor` → `toSql` gera o `WHERE` exato por requisição.

`audit_log` não aceita `UPDATE`/`DELETE` (gatilho `audit_log_immutable`). `chat_messages` e `task_comments` só têm inserção.

## Armadilhas

- **RLS FORCE sem `app.tenant_id` = zero linhas.** Um `UPDATE`/`DELETE` em migração "funciona" e afeta 0 linhas. Defina o tenant
  (`set_config('app.tenant_id', id, true)`) por empresa — foi o bug da 0007 que a 0008 corrigiu.
- **`numeric` do `pg` chega como string** (`"100.50"`): normalize (`::float8` ou `Number`) antes de comparar ou decidir.
- **Comparação de texto depende da collation** do banco (Supabase usa `en_US.UTF-8`); o motor em JS compara por code unit. Há testes
  marcados `todo` documentando isso.
- **Pooler de transação:** não use estado de sessão fora de transação; por isso o contexto é sempre `set_config(..., true)` local.
- **FKs compostas `(id, tenant_id)`:** inserir referência para registro de outro tenant falha (de propósito).

## Adicionar uma tabela ou entidade nova

1. Migração nova com `tenant_id`, RLS FORCE e política por tenant (copie o padrão de `0009`).
2. Se for dado de negócio com permissão: entrada no `catalog.js` (entidade, ações, atributos, tabela) e, se precisar de teto de
   leitura, entrar em `RLS_SCOPED_ENTITIES`; senão decida pela API.
3. Rota em `src/api/` com `must(...)` e `audit(...)`; teste em `test/api/api.test.mjs` contra Postgres real.
4. Atualizar os carregadores de migração dos testes (ver acima) e este documento.
