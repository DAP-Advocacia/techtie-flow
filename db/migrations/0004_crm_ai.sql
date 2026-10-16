-- 0004_crm_ai.sql — o que faltava para o CRM gravar de verdade e para o Agente de IA existir:
--   * contatos com empresa;
--   * catálogo de PRODUTOS (as propostas dos negócios usam);
--   * Agente de IA: configuração do tenant, base de conhecimento, uso (custo) e marcas nas conversas/mensagens;
--   * número de WhatsApp com a IA ligada ou não.
-- Aplique depois de 0003 (db/migrate.mjs faz isso).
BEGIN;
SET LOCAL ROLE app_owner;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS proposal_sent_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company text CHECK (company IS NULL OR char_length(btrim(company)) BETWEEN 1 AND 200);

-- ---- produtos ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  unit        text NOT NULL DEFAULT 'un' CHECK (char_length(btrim(unit)) BETWEEN 1 AND 40),
  price       numeric(14, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS products_tenant_ix ON products (tenant_id, active, name);

-- ---- Agente de IA -----------------------------------------------------------------------------
-- Uma configuração por empresa. Em quais números ele responde é `instances.ai_active`.
CREATE TABLE IF NOT EXISTS ai_agents (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants (id),
  prompt          text NOT NULL DEFAULT '' CHECK (char_length(prompt) <= 4000),
  handoff_rules   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(handoff_rules) = 'array'),
  max_replies     integer NOT NULL DEFAULT 8 CHECK (max_replies BETWEEN 1 AND 50),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (updated_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (updated_by)
);

-- Base de conhecimento: textos que o agente consulta (PDF/DOCX/TXT já convertidos em texto pelo servidor).
CREATE TABLE IF NOT EXISTS ai_knowledge_docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  content     text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 400000),
  chunks      integer NOT NULL DEFAULT 1,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS ai_docs_tenant_ix ON ai_knowledge_docs (tenant_id, created_at);

-- Uso da IA (tokens): base do teto diário de gasto e da auditoria de custo.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  conversation_id    uuid,
  kind               text NOT NULL CHECK (kind IN ('reply', 'test')),
  model              text NOT NULL,
  prompt_tokens      integer NOT NULL DEFAULT 0,
  completion_tokens  integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_tenant_day_ix ON ai_usage (tenant_id, created_at);

ALTER TABLE instances     ADD COLUMN IF NOT EXISTS ai_active boolean NOT NULL DEFAULT false;
ALTER TABLE messages      ADD COLUMN IF NOT EXISTS by_ai boolean NOT NULL DEFAULT false;
-- ai_paused: um humano assumiu (ou a IA transferiu) — a IA não responde mais esta conversa
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_paused boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_replies integer NOT NULL DEFAULT 0;

-- ---- RLS de tenant (mesmo padrão do 0001/0002) ------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products', 'ai_agents', 'ai_knowledge_docs', 'ai_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS app_allow ON %I', t);
    EXECUTE format('CREATE POLICY app_allow ON %I AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_forbid_tenant_change', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF tenant_id ON %I FOR EACH ROW EXECUTE FUNCTION forbid_tenant_change()', t || '_forbid_tenant_change', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON products, ai_knowledge_docs TO app_user;
GRANT SELECT, INSERT, UPDATE ON ai_agents TO app_user;
GRANT SELECT, INSERT ON ai_usage TO app_user;       -- append-only
GRANT USAGE ON SEQUENCE ai_usage_id_seq TO app_user;

-- Supabase: papéis do PostgREST nunca enxergam estas tabelas
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON products, ai_agents, ai_knowledge_docs, ai_usage FROM %I', r);
    END IF;
  END LOOP;
END $$;

RESET ROLE;
COMMIT;
