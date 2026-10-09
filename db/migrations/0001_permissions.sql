-- =============================================================================
-- 0001_permissions.sql — esquema de CRM + permissões do TechTie Flow
-- =============================================================================
-- Como aplicar (idempotente; pode rodar de novo sem efeito colateral):
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_permissions.sql
-- Rode com um papel administrativo (postgres no Supabase, via DIRECT_URL/porta
-- 5432 — NÃO pelo pooler de transação). A migração cria os papéis, e então
-- assume `app_owner` (SET ROLE) para que TODO objeto pertença a ele.
--
-- ARQUITETURA DE SEGURANÇA (resumo — detalhes em docs/permissoes-banco.md)
--   * A APLICAÇÃO decide permissão (motor JS único). O Postgres só faz:
--       (1) isolamento de tenant EXATO por RLS (nenhum bug de aplicação o desliga);
--       (2) teto grosso de escopo por RLS em deals/contacts/conversations
--           (SEMPRE superset do que o motor permite);
--       (3) executa o WHERE compilado pelo motor (toSql) para filtrar listas.
--   * Contexto da requisição entra por set_config(..., true) LOCAL à transação
--     (app.tenant_id, app.user_id, app.team_ids, app.team_tree_ids,
--     app.read_scope_<tabela>) — compatível com PgBouncer em modo transação.
--   * Variável ausente/vazia => NULL => a política não casa => NENHUMA linha.
--
-- Convenções: tabelas e colunas em snake_case (columnOf do catálogo:
-- ownerId -> owner_id); toda tabela de negócio tem tenant_id NOT NULL e
-- UNIQUE (id, tenant_id) para servir de alvo de FK composta.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- FASE 0 — papéis e permissões de nível de banco (executada pelo administrador)
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  -- app_owner: dono do schema e das migrações. NOLOGIN de propósito: ninguém
  -- conecta como dono; a migração o assume com SET ROLE. Menos uma credencial
  -- para vazar, e o dono é o único papel que pode desligar RLS/FORCE.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- app_user: o papel que a aplicação usa em runtime. Sem senha aqui (segredo
  -- não entra em migração): defina com `ALTER ROLE app_user PASSWORD '...'`.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Reafirma os atributos mesmo se o papel já existia (alguém pode ter "ajudado"
-- com BYPASSRLS: isso anularia TODO o isolamento).
ALTER ROLE app_owner NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE app_user  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

DO $$
BEGIN
  -- Para o administrador poder SET ROLE app_owner (no Supabase o `postgres` não
  -- é superusuário; no PG16 quem cria o papel recebe ADMIN OPTION).
  IF NOT pg_has_role(current_user, 'app_owner', 'MEMBER') THEN
    EXECUTE format('GRANT app_owner TO %I', current_user);
  END IF;
  -- app_user NUNCA pode ser membro de app_owner (senão SET ROLE o promoveria).
  IF pg_has_role('app_user', 'app_owner', 'MEMBER') THEN
    EXECUTE 'REVOKE app_owner FROM app_user';
  END IF;
END $$;

-- Ninguém além do dono cria objetos em public (defesa contra "sombreamento"
-- de funções/tabelas por search_path). Em PG15+ já é o padrão; reafirmamos.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO app_owner;
GRANT USAGE ON SCHEMA public TO app_user;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_user', current_database());
  -- Sem tabelas temporárias para o app: um atacante com SQL arbitrário não
  -- consegue criar objetos em pg_temp para tentar sombrear tipos/relações.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'sem privilégio para ajustar GRANT/REVOKE no banco; faça manualmente (CONNECT para app_user, sem TEMPORARY para PUBLIC)';
END $$;

-- A partir daqui TODO objeto é criado/pertence a app_owner.
SET ROLE app_owner;

-- -----------------------------------------------------------------------------
-- FASE 1 — funções de contexto (lêem o set_config da transação)
-- -----------------------------------------------------------------------------
-- Todas SQL, STABLE e SECURITY INVOKER (nenhuma SECURITY DEFINER: função que
-- roda como dono ignoraria o chamador). NULLIF(...,''): depois que uma
-- transação com set_config(...,true) termina, a variável de sessão fica ''
-- (não NULL) — sem o NULLIF o cast ''::uuid LANÇARIA erro em conexão reusada
-- do pool. Com ele vira NULL => nenhuma linha (falha fechado, sem erro).
-- Valor lixo (não-uuid) ainda lança erro no cast: também falha fechado.

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- Formato: literal de array do Postgres, ex.: {uuid1,uuid2}
CREATE OR REPLACE FUNCTION app_team_ids() RETURNS uuid[]
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.team_ids', true), '')::uuid[] $$;

-- Equipes do usuário + todas as descendentes (calculado pela aplicação a
-- partir de team_closure; o motor usa o mesmo conjunto via expandTeams).
CREATE OR REPLACE FUNCTION app_team_tree_ids() RETURNS uuid[]
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.team_tree_ids', true), '')::uuid[] $$;

-- Escopo grosso de leitura da tabela: own|team|team_tree|tenant|none.
CREATE OR REPLACE FUNCTION app_read_scope(p_table text) RETURNS text
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.read_scope_' || p_table, true), '') $$;

-- Espelha scopePredicate() do engine.js (own / team / team_tree / tenant).
-- Valor ausente ou desconhecido => false (falha fechado).
CREATE OR REPLACE FUNCTION app_scope_allows(p_scope text, p_owner uuid, p_team uuid) RETURNS boolean
LANGUAGE sql STABLE AS
$$
  SELECT CASE p_scope
    WHEN 'tenant'    THEN true
    WHEN 'own'       THEN COALESCE(p_owner = app_user_id(), false)
    WHEN 'team'      THEN COALESCE(p_owner = app_user_id(), false)
                          OR COALESCE(p_team = ANY (app_team_ids()), false)
    WHEN 'team_tree' THEN COALESCE(p_owner = app_user_id(), false)
                          OR COALESCE(p_team = ANY (app_team_tree_ids()), false)
    ELSE false
  END
$$;

-- Trigger genérico: tenant_id é imutável. A RLS já barra (WITH CHECK compara a
-- linha NOVA com o tenant da sessão), mas isto vale também para manutenção
-- feita pelo dono e deixa a mensagem de erro inequívoca.
CREATE OR REPLACE FUNCTION forbid_tenant_change() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id é imutável (%.%)', TG_TABLE_NAME, OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------
-- FASE 2 — tabelas
-- -----------------------------------------------------------------------------

-- tenants: a "linha raiz". Não tem tenant_id; a própria id é o tenant.
CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  cnpj        text CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
  -- política do tenant lida pelo motor (ex.: {"requireMfaForSensitive": true})
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Registro dos perfis de SISTEMA. A definição (grants/denies...) vive no CÓDIGO
-- (shared/permissions/roles.js): o motor JS é a única fonte de avaliação e perfis
-- de sistema são imutáveis. Esta tabela só existe para ter FK de integridade em
-- user_roles. Sem tenant_id de propósito (catálogo global); app_user só lê.
CREATE TABLE IF NOT EXISTS system_roles (
  id          text PRIMARY KEY CHECK (id ~ '^role_[a-z][a-z0-9_]{1,40}$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_roles (id, name) VALUES
  ('role_admin', 'Admin'), ('role_manager', 'Gestor'), ('role_agent', 'Atendente'),
  ('role_sdr', 'SDR'), ('role_finance', 'Financeiro'), ('role_viewer', 'Somente leitura')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  email        text NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' AND char_length(email) <= 254),
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  -- o motor só concede algo a status 'active' (falha fechado nos demais)
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended', 'deactivated')),
  mfa_enabled  boolean NOT NULL DEFAULT false,
  -- subject.overrides do motor: {grants, denies, fields}. Validado pela app.
  overrides    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(overrides) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_uq ON users (tenant_id, lower(email));

-- Equipes (organograma). parent_id composta: o pai só pode ser do MESMO tenant.
CREATE TABLE IF NOT EXISTS teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  parent_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK (parent_id IS DISTINCT FROM id),
  FOREIGN KEY (parent_id, tenant_id) REFERENCES teams (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS teams_tenant_parent_ix ON teams (tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS team_members (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  team_id     uuid NOT NULL,
  user_id     uuid NOT NULL,
  is_lead     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id, tenant_id) REFERENCES teams (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS team_members_tenant_user_ix ON team_members (tenant_id, user_id);

-- Closure table de equipes: uma linha por par (ancestral, descendente), incluindo
-- (x, x, 0). Mantida por TRIGGERS em teams; a aplicação só LÊ (app_user não tem
-- INSERT/UPDATE/DELETE aqui — não dá para corromper o organograma por fora).
-- Por que closure e não CTE recursiva: "equipe + subequipes" é consultada em TODA
-- requisição (team_tree_ids) e vira um index lookup O(descendentes); organogramas
-- mudam raramente, e mover uma subárvore custa O(|subárvore| x |ancestrais|),
-- aceitável. CTE recursiva paga a travessia a cada leitura e não tem índice.
CREATE TABLE IF NOT EXISTS team_closure (
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  ancestor_id    uuid NOT NULL,
  descendant_id  uuid NOT NULL,
  depth          integer NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (tenant_id, ancestor_id, descendant_id),
  FOREIGN KEY (ancestor_id, tenant_id)   REFERENCES teams (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (descendant_id, tenant_id) REFERENCES teams (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS team_closure_tenant_desc_ix ON team_closure (tenant_id, descendant_id);

-- Perfis PERSONALIZADOS do tenant. Decisão: definição em JSONB (grants/denies/
-- partitions/fields) validada pela aplicação com validateRole(), em vez de
-- tabelas normalizadas — o motor JS é a única fonte de avaliação; normalizar
-- criaria uma segunda representação para manter sincronizada (e cada novo
-- operador/ação do catálogo viraria migração). O banco garante só o formato
-- grosso (CHECKs) e a integridade relacional (user_roles -> roles).
-- `version` = controle otimista de concorrência e trilha de auditoria; a
-- distinção "system" é estrutural (perfis de sistema ficam em system_roles/código).
CREATE TABLE IF NOT EXISTS roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description  text CHECK (description IS NULL OR char_length(description) <= 500),
  cloned_from  text REFERENCES system_roles (id),
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  definition   jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT roles_definition_shape CHECK (
    jsonb_typeof(definition) = 'object'
    AND COALESCE(jsonb_typeof(definition -> 'grants') = 'array', false)
    AND COALESCE(jsonb_typeof(definition -> 'denies') = 'array', false)
    AND COALESCE(jsonb_typeof(definition -> 'partitions'), 'object') = 'object'
    AND COALESCE(jsonb_typeof(definition -> 'fields'), 'array') = 'array'
    -- identidade vem das COLUNAS: o JSON não pode carregar id/tenantId/system
    -- (senão um perfil poderia se declarar "de outro tenant" ou "de sistema")
    AND NOT (definition ?| ARRAY['id', 'tenantId', 'tenant_id', 'system', 'name'])
    AND pg_column_size(definition) <= 262144
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_tenant_name_uq ON roles (tenant_id, lower(name));

CREATE OR REPLACE FUNCTION roles_touch() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.definition IS DISTINCT FROM OLD.definition THEN
    NEW.version := OLD.version + 1; -- a app não decide a versão: o banco garante monotonia
  ELSE
    NEW.version := OLD.version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Atribuição de perfis a usuários: ou um perfil de sistema, ou um perfil do
-- MESMO tenant (FK composta). Exatamente um dos dois.
CREATE TABLE IF NOT EXISTS user_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  user_id         uuid NOT NULL,
  system_role_id  text REFERENCES system_roles (id),
  role_id         uuid,
  granted_by      uuid,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(system_role_id, role_id) = 1),
  FOREIGN KEY (user_id, tenant_id)    REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id, tenant_id)    REFERENCES roles (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (granted_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_system_uq ON user_roles (tenant_id, user_id, system_role_id) WHERE system_role_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_role_uq   ON user_roles (tenant_id, user_id, role_id) WHERE role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_roles_role_ix ON user_roles (tenant_id, role_id);

-- Configuração mínima referenciada pelos atributos do catálogo (partições).
CREATE TABLE IF NOT EXISTS pipelines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  pipeline_id  uuid NOT NULL,
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  kind         text NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost')),
  position     integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, pipeline_id, tenant_id),
  FOREIGN KEY (pipeline_id, tenant_id) REFERENCES pipelines (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pipeline_stages_tenant_pipeline_ix ON pipeline_stages (tenant_id, pipeline_id);

CREATE TABLE IF NOT EXISTS instances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

-- ---- Entidades de CRM -------------------------------------------------------
-- owner_id/team_id: FKs compostas (id, tenant_id) — um negócio NÃO consegue
-- apontar para usuário/equipe de outro tenant. Isso é essencial: as verificações
-- de FK do Postgres IGNORAM RLS (rodam como dono), então só a FK composta
-- impede o vazamento cruzado. ON DELETE SET NULL (coluna) limpa só a coluna
-- (sem a lista, o SET NULL zeraria tenant_id também).

CREATE TABLE IF NOT EXISTS contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  owner_id    uuid,
  team_id     uuid,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  phone       text CHECK (phone IS NULL OR phone ~ '^[+]?[0-9]{8,15}$'),
  email       text CHECK (email IS NULL OR (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' AND char_length(email) <= 254)),
  document    text CHECK (document IS NULL OR document ~ '^([0-9]{11}|[0-9]{14})$'), -- CPF ou CNPJ, só dígitos
  source      text CHECK (source IS NULL OR source ~ '^[a-z0-9_]{1,40}$'),
  status      text CHECK (status IS NULL OR status ~ '^[a-z0-9_]{1,40}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (owner_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (owner_id),
  FOREIGN KEY (team_id, tenant_id)  REFERENCES teams (id, tenant_id) ON DELETE SET NULL (team_id)
);
CREATE INDEX IF NOT EXISTS contacts_tenant_owner_ix ON contacts (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS contacts_tenant_team_ix  ON contacts (tenant_id, team_id);
CREATE INDEX IF NOT EXISTS contacts_tenant_created_ix ON contacts (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  owner_id    uuid,
  team_id     uuid,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  document    text CHECK (document IS NULL OR document ~ '^([0-9]{11}|[0-9]{14})$'),
  status      text CHECK (status IS NULL OR status ~ '^[a-z0-9_]{1,40}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (owner_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (owner_id),
  FOREIGN KEY (team_id, tenant_id)  REFERENCES teams (id, tenant_id) ON DELETE SET NULL (team_id)
);
CREATE INDEX IF NOT EXISTS companies_tenant_owner_ix ON companies (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS companies_tenant_team_ix  ON companies (tenant_id, team_id);

CREATE TABLE IF NOT EXISTS deals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  owner_id     uuid,
  team_id      uuid,
  title        text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  pipeline_id  uuid,
  stage_id     uuid,
  value        numeric(14, 2) CHECK (value IS NULL OR value >= 0),
  -- denormalizado do tipo da etapa (filtra sem join); mantido pela aplicação
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  items        jsonb CHECK (items IS NULL OR jsonb_typeof(items) = 'array'),
  discount     numeric(5, 2) CHECK (discount IS NULL OR discount BETWEEN 0 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  -- FK composta é MATCH SIMPLE (ignorada se alguma coluna for NULL): sem este CHECK,
  -- uma etapa sem pipeline escaparia da verificação de tenant.
  CHECK (stage_id IS NULL OR pipeline_id IS NOT NULL),
  FOREIGN KEY (owner_id, tenant_id)    REFERENCES users (id, tenant_id) ON DELETE SET NULL (owner_id),
  FOREIGN KEY (team_id, tenant_id)     REFERENCES teams (id, tenant_id) ON DELETE SET NULL (team_id),
  FOREIGN KEY (pipeline_id, tenant_id) REFERENCES pipelines (id, tenant_id),
  -- a etapa precisa pertencer ao pipeline do negócio (e ao mesmo tenant)
  FOREIGN KEY (stage_id, pipeline_id, tenant_id) REFERENCES pipeline_stages (id, pipeline_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS deals_tenant_owner_ix    ON deals (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS deals_tenant_team_ix     ON deals (tenant_id, team_id);
-- (tenant_id, pipeline_id, ...) também serve de índice da FK de pipeline
CREATE INDEX IF NOT EXISTS deals_tenant_pipeline_ix ON deals (tenant_id, pipeline_id, stage_id);
CREATE INDEX IF NOT EXISTS deals_tenant_created_ix  ON deals (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  -- owner_id existe porque o catálogo declara ownerId em todo "record", mas o
  -- responsável da conversa (ownerField do catálogo) é assignee_id.
  owner_id     uuid,
  team_id      uuid,
  assignee_id  uuid,
  instance_id  uuid,
  status       text CHECK (status IS NULL OR status ~ '^[a-z0-9_]{1,40}$'),
  phone        text CHECK (phone IS NULL OR phone ~ '^[+]?[0-9]{8,15}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (owner_id, tenant_id)    REFERENCES users (id, tenant_id) ON DELETE SET NULL (owner_id),
  FOREIGN KEY (team_id, tenant_id)     REFERENCES teams (id, tenant_id) ON DELETE SET NULL (team_id),
  FOREIGN KEY (assignee_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (assignee_id),
  FOREIGN KEY (instance_id, tenant_id) REFERENCES instances (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS conversations_tenant_assignee_ix ON conversations (tenant_id, assignee_id);
CREATE INDEX IF NOT EXISTS conversations_tenant_team_ix     ON conversations (tenant_id, team_id);
CREATE INDEX IF NOT EXISTS conversations_tenant_owner_ix    ON conversations (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS conversations_tenant_instance_ix ON conversations (tenant_id, instance_id);

CREATE TABLE IF NOT EXISTS proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  owner_id      uuid,
  team_id       uuid,
  status        text CHECK (status IS NULL OR status ~ '^[a-z0-9_]{1,40}$'),
  discount_pct  numeric(5, 2) CHECK (discount_pct IS NULL OR discount_pct BETWEEN 0 AND 100),
  discount      numeric(14, 2) CHECK (discount IS NULL OR discount >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (owner_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (owner_id),
  FOREIGN KEY (team_id, tenant_id)  REFERENCES teams (id, tenant_id) ON DELETE SET NULL (team_id)
);
CREATE INDEX IF NOT EXISTS proposals_tenant_owner_ix ON proposals (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS proposals_tenant_team_ix  ON proposals (tenant_id, team_id);

CREATE TABLE IF NOT EXISTS tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  owner_id    uuid,
  team_id     uuid,
  title       text CHECK (title IS NULL OR char_length(title) <= 500),
  status      text CHECK (status IS NULL OR status ~ '^[a-z0-9_]{1,40}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (owner_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (owner_id),
  FOREIGN KEY (team_id, tenant_id)  REFERENCES teams (id, tenant_id) ON DELETE SET NULL (team_id)
);
CREATE INDEX IF NOT EXISTS tasks_tenant_owner_ix ON tasks (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS tasks_tenant_team_ix  ON tasks (tenant_id, team_id);

CREATE TABLE IF NOT EXISTS calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  owner_id     uuid,
  team_id      uuid,
  instance_id  uuid,
  direction    text CHECK (direction IS NULL OR direction IN ('inbound', 'outbound')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (owner_id, tenant_id)    REFERENCES users (id, tenant_id) ON DELETE SET NULL (owner_id),
  FOREIGN KEY (team_id, tenant_id)     REFERENCES teams (id, tenant_id) ON DELETE SET NULL (team_id),
  FOREIGN KEY (instance_id, tenant_id) REFERENCES instances (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS calls_tenant_owner_ix    ON calls (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS calls_tenant_team_ix     ON calls (tenant_id, team_id);
CREATE INDEX IF NOT EXISTS calls_tenant_instance_ix ON calls (tenant_id, instance_id);

-- Compartilhamento por registro. As colunas (tenant_id, entity, resource_id,
-- subject_type, subject_id, level) são EXATAMENTE as que toSql() usa.
-- resource_id e subject_id são polimórficos; para ter integridade referencial
-- MESMO ASSIM, colunas geradas projetam cada alvo possível numa FK composta:
-- o recurso e o destinatário precisam existir NO MESMO tenant, e o share some
-- junto com o recurso (CASCADE).
CREATE TABLE IF NOT EXISTS resource_shares (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  entity        text NOT NULL CHECK (entity IN ('contact', 'company', 'deal')),
  resource_id   uuid NOT NULL,
  subject_type  text NOT NULL CHECK (subject_type IN ('user', 'team')),
  subject_id    uuid NOT NULL,
  level         text NOT NULL CHECK (level IN ('read', 'edit')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  contact_id    uuid GENERATED ALWAYS AS (CASE WHEN entity = 'contact' THEN resource_id END) STORED,
  company_id    uuid GENERATED ALWAYS AS (CASE WHEN entity = 'company' THEN resource_id END) STORED,
  deal_id       uuid GENERATED ALWAYS AS (CASE WHEN entity = 'deal'    THEN resource_id END) STORED,
  user_subject_id uuid GENERATED ALWAYS AS (CASE WHEN subject_type = 'user' THEN subject_id END) STORED,
  team_subject_id uuid GENERATED ALWAYS AS (CASE WHEN subject_type = 'team' THEN subject_id END) STORED,
  UNIQUE (tenant_id, entity, resource_id, subject_type, subject_id),
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts  (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, tenant_id) REFERENCES companies (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (deal_id, tenant_id)    REFERENCES deals     (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_subject_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (team_subject_id, tenant_id) REFERENCES teams (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (created_by)
);
-- o EXISTS de toSql/RLS: por recurso...
CREATE INDEX IF NOT EXISTS resource_shares_resource_ix ON resource_shares (tenant_id, entity, resource_id);
-- ...e "tudo que foi compartilhado comigo/minha equipe"
CREATE INDEX IF NOT EXISTS resource_shares_subject_ix  ON resource_shares (tenant_id, subject_type, subject_id);

-- Pedidos de aprovação ("desconto acima de X exige gestor"). A decisão em si é
-- do motor (effect 'approval'); aqui fica o registro do pedido e do veredito.
CREATE TABLE IF NOT EXISTS approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  entity        text NOT NULL CHECK (entity ~ '^[a-z_]{1,40}$'),
  resource_id   uuid,
  action        text NOT NULL CHECK (action ~ '^[a-z_]{1,40}$'),
  context       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'), -- ex.: {"discountPct": 12}
  requested_by  uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (requested_by, tenant_id) REFERENCES users (id, tenant_id),
  FOREIGN KEY (decided_by, tenant_id)   REFERENCES users (id, tenant_id),
  -- quatro olhos: ninguém aprova o próprio pedido
  CONSTRAINT approvals_no_self_approval CHECK (decided_by IS DISTINCT FROM requested_by),
  CONSTRAINT approvals_decision_consistent CHECK (
    (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (status NOT IN ('approved', 'rejected'))
  )
);
CREATE INDEX IF NOT EXISTS approvals_tenant_status_ix   ON approvals (tenant_id, status);
CREATE INDEX IF NOT EXISTS approvals_tenant_resource_ix ON approvals (tenant_id, entity, resource_id);
CREATE INDEX IF NOT EXISTS approvals_tenant_requester_ix ON approvals (tenant_id, requested_by);

-- Auditoria APPEND-ONLY. actor_id NÃO tem FK de propósito: o histórico precisa
-- sobreviver à remoção do usuário. app_user só tem SELECT e INSERT (nunca
-- UPDATE/DELETE/TRUNCATE) e um trigger recusa as três operações mesmo para o dono
-- (cinto e suspensório; o dono ainda pode desabilitar o trigger — ver docs).
--
-- Particionamento mensal (recomendado a partir de ~dezenas de milhões de linhas).
-- Para ativar, troque a definição abaixo por esta (PK precisa incluir a chave
-- de partição) e crie as partições por mês via job/pg_partman:
--   CREATE TABLE audit_log (
--     id uuid NOT NULL DEFAULT gen_random_uuid(), seq bigint GENERATED ALWAYS AS IDENTITY, ..., occurred_at timestamptz NOT NULL DEFAULT now(),
--     PRIMARY KEY (id, occurred_at)
--   ) PARTITION BY RANGE (occurred_at);
--   CREATE TABLE audit_log_2026_10 PARTITION OF audit_log FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
-- RLS/policies/triggers definidos no PAI valem para as partições consultadas
-- por ele; GRANTs e FORCE precisam ser repetidos em cada partição criada.
CREATE TABLE IF NOT EXISTS audit_log (
  -- id uuid (o catálogo declara todo id como uuid, e filtros do motor fazem cast uuid);
  -- seq dá a ordem total de inserção.
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid,
  action       text NOT NULL CHECK (action ~ '^[a-z_.:]{1,60}$'),
  entity       text CHECK (entity IS NULL OR entity ~ '^[a-z_]{1,40}$'),
  entity_id    uuid,
  diff         jsonb,
  ip           inet,
  request_id   text CHECK (request_id IS NULL OR char_length(request_id) <= 100)
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_time_ix   ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_tenant_entity_ix ON audit_log (tenant_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_tenant_actor_ix  ON audit_log (tenant_id, actor_id);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'audit_log é append-only (% proibido)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- -----------------------------------------------------------------------------
-- FASE 3 — manutenção da closure de equipes (triggers)
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER aqui é deliberado e restrito: o app_user não pode escrever em
-- team_closure, então quem escreve é a função do dono. Mitigações: search_path
-- fixo (sem sombreamento), só funções de trigger (não chamáveis diretamente),
-- e o dono continua sob FORCE RLS — escreve apenas no tenant da sessão.

CREATE OR REPLACE FUNCTION teams_closure_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  INSERT INTO team_closure (tenant_id, ancestor_id, descendant_id, depth)
  VALUES (NEW.tenant_id, NEW.id, NEW.id, 0);
  IF NEW.parent_id IS NOT NULL THEN
    INSERT INTO team_closure (tenant_id, ancestor_id, descendant_id, depth)
    SELECT c.tenant_id, c.ancestor_id, NEW.id, c.depth + 1
      FROM team_closure c
     WHERE c.tenant_id = NEW.tenant_id AND c.descendant_id = NEW.parent_id;
  END IF;
  RETURN NULL;
END
$$;

-- Impede ciclo: o novo pai não pode ser a própria equipe nem um descendente dela.
CREATE OR REPLACE FUNCTION teams_closure_before_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM team_closure c
        WHERE c.tenant_id = NEW.tenant_id AND c.ancestor_id = NEW.id AND c.descendant_id = NEW.parent_id) THEN
    RAISE EXCEPTION 'ciclo no organograma de equipes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Mover subárvore: remove os vínculos da subárvore com os ancestrais ANTIGOS e
-- recria com os do novo pai.
CREATE OR REPLACE FUNCTION teams_closure_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
BEGIN
  DELETE FROM team_closure
   WHERE tenant_id = NEW.tenant_id
     AND descendant_id IN (SELECT descendant_id FROM team_closure WHERE tenant_id = NEW.tenant_id AND ancestor_id = NEW.id)
     AND ancestor_id IN (SELECT ancestor_id FROM team_closure WHERE tenant_id = NEW.tenant_id AND descendant_id = NEW.id AND ancestor_id <> NEW.id);
  IF NEW.parent_id IS NOT NULL THEN
    INSERT INTO team_closure (tenant_id, ancestor_id, descendant_id, depth)
    SELECT NEW.tenant_id, sup.ancestor_id, sub.descendant_id, sup.depth + sub.depth + 1
      FROM team_closure sup, team_closure sub
     WHERE sup.tenant_id = NEW.tenant_id AND sup.descendant_id = NEW.parent_id
       AND sub.tenant_id = NEW.tenant_id AND sub.ancestor_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION teams_closure_after_insert(), teams_closure_before_update(), teams_closure_after_update() FROM PUBLIC;

DROP TRIGGER IF EXISTS teams_closure_ai ON teams;
CREATE TRIGGER teams_closure_ai AFTER INSERT ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_closure_after_insert();
DROP TRIGGER IF EXISTS teams_closure_bu ON teams;
CREATE TRIGGER teams_closure_bu BEFORE UPDATE OF parent_id ON teams
  FOR EACH ROW WHEN (NEW.parent_id IS DISTINCT FROM OLD.parent_id) EXECUTE FUNCTION teams_closure_before_update();
DROP TRIGGER IF EXISTS teams_closure_au ON teams;
CREATE TRIGGER teams_closure_au AFTER UPDATE OF parent_id ON teams
  FOR EACH ROW WHEN (NEW.parent_id IS DISTINCT FROM OLD.parent_id) EXECUTE FUNCTION teams_closure_after_update();

DROP TRIGGER IF EXISTS roles_touch_bu ON roles;
CREATE TRIGGER roles_touch_bu BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION roles_touch();

-- -----------------------------------------------------------------------------
-- FASE 4 — RLS
-- -----------------------------------------------------------------------------
-- Desenho das políticas (leia antes de mexer):
--  * `tenant_isolation` é RESTRICTIVE: políticas PERMISSIVAS se combinam com OR,
--    então uma permissiva a mais, adicionada por engano no futuro ("USING (true)"
--    para um relatório), ABRIRIA o tenant. Restritivas se combinam com AND com o
--    resultado das permissivas — nenhuma permissiva consegue desligá-la.
--  * Como o Postgres exige ao menos uma permissiva para mostrar qualquer linha,
--    cada tabela tem `app_allow` (USING true): ela NÃO concede nada sozinha, só
--    "abre a porta" para as restritivas decidirem.
--  * FORCE ROW LEVEL SECURITY: o dono (app_owner) também fica sujeito às
--    políticas. Sem FORCE, quem roda migração/manutenção como dono ignoraria RLS.
--  * `tenant_id = app_tenant_id()` (= current_setting('app.tenant_id', true)::uuid
--    com NULLIF para o caso ''): variável ausente => NULL => comparação NULL =>
--    nenhuma linha, tanto em leitura quanto em escrita (WITH CHECK).
--  * WITH CHECK da mesma expressão: INSERT com tenant_id alheio e UPDATE que troque
--    tenant_id (a linha NOVA deixa de casar) são recusados.
--  * Sem views, sem SECURITY DEFINER de dados: nada contorna as políticas.

DO $$
DECLARE
  t text;
BEGIN
  -- tenants: a própria linha é o tenant.
  ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON tenants;
  CREATE POLICY tenant_isolation ON tenants AS RESTRICTIVE FOR ALL
    USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
  DROP POLICY IF EXISTS app_allow ON tenants;
  CREATE POLICY app_allow ON tenants AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);

  FOREACH t IN ARRAY ARRAY[
    'users', 'teams', 'team_members', 'team_closure', 'roles', 'user_roles',
    'pipelines', 'pipeline_stages', 'instances',
    'contacts', 'companies', 'deals', 'conversations', 'proposals', 'tasks', 'calls',
    'resource_shares', 'approvals', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS app_allow ON %I', t);
    EXECUTE format('CREATE POLICY app_allow ON %I AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)', t);
    -- tenant_id imutável (audit_log já é append-only; team_closure é só do trigger)
    IF t NOT IN ('audit_log') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_forbid_tenant_change', t);
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF tenant_id ON %I FOR EACH ROW EXECUTE FUNCTION forbid_tenant_change()', t || '_forbid_tenant_change', t);
    END IF;
  END LOOP;
END $$;

-- Camada 2 — teto grosso de LEITURA (deals, contacts, conversations).
-- Restritiva e só para SELECT: AND com a isolação de tenant. O escopo vem de
-- app.read_scope_<tabela> (calculado pela app: o MAIOR escopo que qualquer grant
-- do usuário dá sobre a entidade — ver db/read-scopes.mjs). Contrato: este teto é
-- SEMPRE superset do que o motor permite (sem condições/partições/negações/MFA,
-- que só restringem); o motor continua sendo quem decide. Inclui o
-- compartilhamento (resource_shares) onde a entidade é compartilhável, com as
-- equipes expandidas em subárvore (igual ao engine: expandTeams).
-- Atenção: policies SELECT também se aplicam a UPDATE/DELETE com WHERE/RETURNING e
-- a INSERT ... RETURNING — o escopo precisa cobrir toda ação do usuário sobre a linha.
DO $$
DECLARE
  r record;
  share_clause text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('deals',         'owner_id',    'deal',         true),
      ('contacts',      'owner_id',    'contact',      true),
      ('conversations', 'assignee_id', 'conversation', false)  -- ownerField = assigneeId; não compartilhável
    ) AS v(tbl, owner_col, entity, shareable)
  LOOP
    share_clause := '';
    IF r.shareable THEN
      share_clause := format(
        ' OR EXISTS (SELECT 1 FROM resource_shares rs WHERE rs.tenant_id = %1$I.tenant_id AND rs.entity = %2$L AND rs.resource_id = %1$I.id'
        || ' AND ((rs.subject_type = ''user'' AND rs.subject_id = app_user_id())'
        || ' OR (rs.subject_type = ''team'' AND rs.subject_id = ANY (app_team_tree_ids()))))',
        r.tbl, r.entity);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS read_scope ON %I', r.tbl);
    EXECUTE format('CREATE POLICY read_scope ON %1$I AS RESTRICTIVE FOR SELECT USING (app_scope_allows(app_read_scope(%2$L), %3$I, team_id)%4$s)',
                   r.tbl, r.tbl, r.owner_col, share_clause);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- FASE 5 — privilégios (mínimo necessário para app_user)
-- -----------------------------------------------------------------------------
-- RLS não vale para TRUNCATE nem REFERENCES: por isso app_user NUNCA os recebe.
-- Nada para PUBLIC. Sem DEFAULT PRIVILEGES: cada tabela nova exige GRANT explícito.

-- (só objetos DO app_owner: REVOKE ... ALL TABLES falha se houver tabela alheia em public)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE c.relkind IN ('r', 'p') AND pg_get_userbyid(c.relowner) = current_user LOOP
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', r.relname);
  END LOOP;
END $$;

GRANT SELECT ON tenants, system_roles, team_closure TO app_user;
GRANT UPDATE (name, settings) ON tenants TO app_user;     -- id/slug/status só o provisionamento (dono) altera
GRANT SELECT, INSERT, UPDATE ON users, approvals TO app_user; -- usuários são desativados (status), não apagados
GRANT SELECT, INSERT, UPDATE, DELETE ON
  teams, team_members, roles, pipelines, pipeline_stages, instances,
  contacts, companies, deals, conversations, proposals, tasks, calls, resource_shares
  TO app_user;
GRANT SELECT, INSERT, DELETE ON user_roles TO app_user;
GRANT SELECT, INSERT ON audit_log TO app_user;            -- append-only

-- Supabase: papéis do PostgREST/Storage nunca devem enxergar estas tabelas
-- (service_role tem BYPASSRLS — um GRANT para ele seria um backdoor total).
DO $$
DECLARE
  r text;
  t record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                WHERE c.relkind IN ('r', 'p') AND pg_get_userbyid(c.relowner) = current_user LOOP
        EXECUTE format('REVOKE ALL ON %I FROM %I', t.relname, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- FASE 6 — autoverificação: a migração FALHA (e faz rollback) se a postura de
-- segurança estiver errada. Pega tabela nova esquecida, papel com BYPASSRLS etc.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE c.relkind IN ('r', 'p')
     AND (c.relname = 'tenants' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND NOT p.polpermissive));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tabelas sem RLS FORÇADA + política tenant_isolation restritiva: %', bad;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('app_user', 'app_owner') AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'app_user/app_owner não podem ser SUPERUSER nem BYPASSRLS';
  END IF;

  IF has_table_privilege('app_user', 'audit_log', 'UPDATE') OR has_table_privilege('app_user', 'audit_log', 'DELETE')
     OR has_table_privilege('app_user', 'audit_log', 'TRUNCATE') THEN
    RAISE EXCEPTION 'app_user não pode alterar/apagar audit_log';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
              WHERE c.relkind IN ('r', 'p') AND (has_table_privilege('app_user', c.oid, 'TRUNCATE') OR has_table_privilege('app_user', c.oid, 'REFERENCES'))) THEN
    RAISE EXCEPTION 'app_user não pode ter TRUNCATE/REFERENCES (RLS não se aplica a eles)';
  END IF;

  -- único SECURITY DEFINER permitido: as 3 funções de trigger da closure
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.prosecdef AND p.proname NOT IN ('teams_closure_after_insert', 'teams_closure_before_update', 'teams_closure_after_update');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'funções SECURITY DEFINER inesperadas: %', bad;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public' WHERE c.relkind = 'v') THEN
    RAISE EXCEPTION 'views em public precisam ser revisadas (security_invoker) antes de entrar';
  END IF;
END $$;

RESET ROLE;

COMMIT;
