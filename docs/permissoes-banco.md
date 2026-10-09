# Permissões no banco (Postgres) — camada de dados

Complementa `shared/permissions/` (motor JS). **A aplicação decide** (motor único em
JS); o Postgres faz três coisas: (1) isolamento exato de tenant por RLS — a barreira
que nenhum bug de aplicação desliga; (2) um teto grosso de escopo por RLS, sempre
*superset* do motor; (3) executa o `WHERE` que o motor compila (`toSql`) para listar.

Arquivos: `db/migrations/0001_permissions.sql` · `db/read-scopes.mjs` ·
`src/db-tenant.js` · `test/permissions-sql/*.test.mjs`.

## Esquema (texto)

```
tenants ─┬─ users ──┬─ user_roles ──► roles (JSONB, por tenant)   system_roles (ids; defs no código)
         │          ├─ team_members ─► teams (parent_id) ◄── team_closure (ancestral, descendente, depth)
         │          └─ overrides jsonb (subject.overrides do motor)
         ├─ pipelines ─ pipeline_stages        instances
         ├─ contacts  companies  deals  conversations  proposals  tasks  calls     (owner_id, team_id [, pipeline/stage/instance...])
         ├─ resource_shares (tenant_id, entity, resource_id, subject_type, subject_id, level, created_by, created_at)
         ├─ approvals (pedidos; 4 olhos)      audit_log (append-only)
```

Toda tabela tem `tenant_id NOT NULL` + `UNIQUE (id, tenant_id)`; toda referência é
**FK composta** `(x_id, tenant_id) → alvo(id, tenant_id)`. Exceções deliberadas:
`tenants` (a própria linha é o tenant), `system_roles` (catálogo global, só leitura),
`audit_log.actor_id` (sem FK: o histórico sobrevive ao usuário).

## Decisões e porquês

| Tema | Escolha | Porquê |
|---|---|---|
| Perfis | `roles.definition` **JSONB** (grants/denies/partitions/fields) validada por `validateRole` na app; `version` incrementada por trigger; perfis de sistema só em código (`system_roles` = registro de ids p/ FK) | O motor JS é a única fonte de avaliação; normalizar criaria 2ª representação a sincronizar e uma migração a cada operador/ação novos. O banco garante o formato grosso (CHECK: grants/denies arrays, sem `id/tenantId/system` dentro do JSON, ≤256 KB) e a integridade relacional (`user_roles`). Contra-ponto aceito: não dá para consultar "quem pode X" por SQL — essa pergunta é do motor (`effectiveMatrix`). `system` é estrutural (tabela), não flag. |
| Equipes | **closure table** mantida por triggers | `team_tree_ids` é lido em *toda* requisição → lookup indexado O(descendentes). CTE recursiva re-percorre a árvore a cada leitura; organogramas mudam raramente (mover subárvore = O(subárvore × ancestrais)). Triggers também barram ciclo; `app_user` só lê a closure. |
| FKs compostas | `(id, tenant_id)` em tudo, `ON DELETE SET NULL (coluna)` | Verificações de FK **ignoram RLS** (rodam como dono): sem FK composta, `owner_id` de outro tenant seria aceito. Erro idêntico para "inexistente" e "de outro tenant" (sem oráculo). `MATCH SIMPLE` ignora FK com coluna NULL → CHECK `stage_id ⇒ pipeline_id`. |
| RLS | `tenant_isolation` **RESTRICTIVE** `FOR ALL` (USING + WITH CHECK) + `app_allow` permissiva `true` | Permissivas combinam por **OR**: uma `USING (true)` futura abriria o tenant. Restritivas combinam por AND. `ENABLE + FORCE` (dono também obedece). Teste de mutação prova os dois pontos. Variável ausente/`''` → `NULLIF` → NULL → nenhuma linha (sem erro); lixo não-uuid → erro de cast (falha fechado). |
| Camada 2 | `read_scope` RESTRICTIVE `FOR SELECT` em deals/contacts/conversations lê `app.read_scope_<tabela>` (`own/team/team_tree/tenant/none`) + `app.user_id/team_ids/team_tree_ids`; inclui `resource_shares` (equipes expandidas em subárvore, como `expandTeams`) | Defesa em profundidade, **nunca mais restritiva que o motor**: a app envia o *maior* escopo de qualquer grant sobre a entidade (`db/read-scopes.mjs`, derivado do motor, ignora condições/partições/negações/MFA). Variável ausente ou valor desconhecido → nada (falha fechado). Conversas usam `assignee_id` (ownerField) e não são compartilháveis. |
| Contexto | `set_config(..., true)` por transação (`withTenant`) | Com PgBouncer em modo transação (Supabase, porta 6543) a conexão física muda a cada transação: só o `local` é seguro. Após o COMMIT a GUC fica `''` na sessão — por isso `NULLIF`. Nada de `SET` de sessão, nada de prepared statements nomeados. |
| Papéis | `app_owner` NOLOGIN, dono de tudo (migração faz `SET ROLE`); `app_user` LOGIN NOSUPERUSER NOBYPASSRLS, só DML necessário, sem TRUNCATE/REFERENCES | RLS não vale para TRUNCATE. `app_user` não é membro de `app_owner` (testado: `SET ROLE`, `SET SESSION AUTHORIZATION`, `row_security=off`, DDL, `ALTER ROLE`… negados). Sem TEMP no banco. Senha fora da migração (`ALTER ROLE app_user PASSWORD`). |
| Auditoria | `audit_log` só SELECT/INSERT p/ `app_user` + trigger recusa UPDATE/DELETE/TRUNCATE (até do dono) | Append-only por privilégio **e** por trigger. Particionamento mensal: bloco comentado na migração. |
| SECURITY DEFINER | só as 3 funções de trigger da closure (search_path fixo) | Funções de contexto são `SECURITY INVOKER`. A migração **falha** (autoverificação) se achar outra DEFINER, view em `public`, tabela com `tenant_id` sem RLS forçada/política restritiva, BYPASSRLS, ou `app_user` com UPDATE/DELETE/TRUNCATE em `audit_log`. |

## Como a aplicação usa

```js
const { withTenant } = require('./db-tenant');
const { readScopesFor } = await import('../db/read-scopes.mjs');
const { filterFor, toSql, ENTITIES } = await import('../shared/permissions/index.js');

const { expr } = filterFor(ctx, 'deal', 'read');
const { sql, params } = toSql(expr, ENTITIES.deal, { alias: 't', startAt: 1 });
await withTenant(pool, { tenantId, userId, teamIds, teamTreeIds, readScopes: readScopesFor(ctx) },
  (c) => c.query(`SELECT * FROM deals t WHERE ${sql} ORDER BY t.created_at DESC LIMIT 50`, params));
```
`teamTreeIds` = `SELECT DISTINCT descendant_id FROM team_closure WHERE ancestor_id = ANY($1)`.
Jobs de sistema (webhooks) sem usuário: `readScopes: 'tenant'` e sem `userId`.
**Linhas lidas do pg vão ao `decide()`**: `numeric` chega como *string* (`'100.50'`) e quebra
`eq`/`in` numéricos — registre `pg.types.setTypeParser(1700, parseFloat)` ou use `::float8`.

## Aplicar a migração

Idempotente; rode com o administrador (no Supabase: **`DIRECT_URL`**, porta 5432 — nunca
o pooler de transação):

```
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_permissions.sql
psql "$DIRECT_URL" -c "ALTER ROLE app_user PASSWORD '...'"   # uma vez
```
Depois aponte `DATABASE_URL` (pooler, `pgbouncer=true`) para `app_user`
(`postgresql://app_user.SEU-PROJETO:SENHA@...:6543/postgres`). No Supabase, remova o schema
`public` de "Exposed schemas" do PostgREST: `service_role` tem BYPASSRLS (a migração já
revoga `anon/authenticated/service_role` nas tabelas, mas a exposição em si é desnecessária).
Mudanças futuras: `0002_*.sql` (a 0001 usa `CREATE TABLE IF NOT EXISTS`: não altera tabela existente).

## Adicionar uma entidade nova

1. `shared/permissions/catalog.js`: `record({ table, actions, attrs, … })` (ou `config`).
2. Migração `000N`: tabela com `id`, `tenant_id NOT NULL`, `owner_id/team_id` (FK composta,
   `ON DELETE SET NULL (col)`), uma coluna **snake_case por atributo** (`columnOf`) com o tipo
   do catálogo (uuid/text/numeric/boolean), `UNIQUE (id, tenant_id)`, índices
   `(tenant_id, owner_id)`, `(tenant_id, team_id)` e por partição; adicione o nome ao `ARRAY`
   do laço de RLS (ENABLE/FORCE/`tenant_isolation`/`app_allow`/trigger de tenant) e os `GRANT`s
   (nunca TRUNCATE). Camada 2: inclua a linha em `VALUES` do bloco `read_scope` e em
   `RLS_SCOPED_ENTITIES` (`db/read-scopes.mjs`) + `SCOPED_TABLES` (`src/db-tenant.js`).
   Compartilhável? amplie o CHECK de `resource_shares.entity` e adicione coluna gerada + FK.
3. A autoverificação da migração acusa se esquecer RLS. Rode `npm test` (Docker): o teste
   "colunas do catálogo" e o diferencial cobrem a entidade nova se entrar em `TABLE_ENTITIES`.

## Testes (Postgres real, contêiner descartável)

`test/permissions-sql/`: `isolation` (isolamento, escape de papel, mutações), `schema`
(closure, JSONB, FKs, camada 2, `withTenant`), `differential` (≥3 tenants, 36 usuários,
2400 deals/contacts/conversations, PRNG fixo; SQL × JS idênticos; RLS ⊇ motor; controles que
provam que o teste detecta erro). `TTF_DIFF_SEED=n` muda a semente. Pulam sozinhos sem
Docker/`pg`/imagem `postgres:16-alpine` (`TTF_SKIP_SQL_TESTS=1` força o pulo).

## Riscos conhecidos e o que NÃO é coberto

- **GUC é forjável por quem executa SQL arbitrário como `app_user`** (`SELECT set_config('app.tenant_id', …)`; há teste documentando). O desenho assume: SQL sempre parametrizado, nenhum SQL vindo do cliente, `app_user` só na app. Endurecimento futuro: contexto assinado (HMAC verificado em função de dono).
- **Colação**: `lt/gt` em `text` usam a collation do banco/coluna; o JS compara por code unit (diverge em `en_US.UTF-8`). Evite ordem em `text` nas condições (ou fixe `COLLATE "C"` em `toSql`).
- **Tipos de literal não são validados** (`ownerId eq 'abc'`, `value gt 'x'`): JS dá falso, o SQL **erra** no cast (falha fechado, mas derruba a listagem); `status eq 5` casa `'5'` no SQL e não no JS.
- O teto de leitura também limita UPDATE/DELETE/`INSERT … RETURNING` de linhas fora do escopo de leitura: o escopo é o máximo de *todas* as ações — mantenha assim.
- RLS **não** protege `TRUNCATE`/DDL (por isso nunca concedidos) nem o dono desabilitando trigger/RLS; `audit_log` não é à prova de dono/superusuário (use réplica/WORM para isso).
- Login: achar o tenant pelo slug/e-mail **antes** de haver contexto exige um caminho privilegiado (papel/função dedicados) — fora do escopo.
- **Campos ocultos/travados** (`maskRow`, `canWriteField`) são da aplicação, não do banco; **gravações de chamada** (Storage) e a regra `deal.status` ↔ tipo da etapa também. Configurações do catálogo sem tabela ainda (products, automations, ai_agents, reports, tenant_settings, billing, api_keys) seguem o roteiro acima.
- Janela de consistência: `read_scope` e `team_tree_ids` vêm da app no início da transação; mudança de perfil/organograma vale na transação seguinte.
