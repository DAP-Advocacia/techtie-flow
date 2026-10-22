-- 0007_pipeline_config.sql — funis configuráveis pela tela: probabilidade por etapa (previsão de receita ponderada) e
-- motivos de perda (lista por empresa; o negócio guarda o texto do motivo escolhido).
-- Depende só de 0001 (tenants, pipelines, pipeline_stages, deals).
BEGIN;
SET LOCAL ROLE app_owner;

-- Probabilidade (0 a 100) de a etapa virar ganho. Preenchimento inicial: ganho 100, perdido 0 e as abertas
-- distribuídas ao longo do funil (3 abertas → 25, 50 e 75). Só roda na primeira vez (a coluna ainda não existe).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pipeline_stages' AND column_name = 'probability') THEN
    ALTER TABLE pipeline_stages ADD COLUMN probability smallint NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100);
    UPDATE pipeline_stages SET probability = 100 WHERE kind = 'won';
    UPDATE pipeline_stages s SET probability = r.p
      FROM (
        SELECT id, round(100.0 * row_number() OVER (PARTITION BY pipeline_id ORDER BY position, created_at) / (count(*) OVER (PARTITION BY pipeline_id) + 1))::int AS p
        FROM pipeline_stages WHERE kind = 'open'
      ) r
      WHERE s.id = r.id;
  END IF;
END $$;

-- Motivo da perda escolhido ao mover o negócio para uma etapa "perdida" (some ao reabrir).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason text CHECK (lost_reason IS NULL OR char_length(lost_reason) <= 200);

-- Lista de motivos de perda da empresa. O negócio guarda o TEXTO (apagar ou renomear um motivo não mexe no histórico).
CREATE TABLE IF NOT EXISTS loss_reasons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  position    integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS loss_reasons_tenant_name_uq ON loss_reasons (tenant_id, lower(btrim(name)));

DO $$
BEGIN
  ALTER TABLE loss_reasons ENABLE ROW LEVEL SECURITY;
  ALTER TABLE loss_reasons FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON loss_reasons;
  CREATE POLICY tenant_isolation ON loss_reasons AS RESTRICTIVE FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
  DROP POLICY IF EXISTS app_allow ON loss_reasons;
  CREATE POLICY app_allow ON loss_reasons AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
  DROP TRIGGER IF EXISTS loss_reasons_forbid_tenant_change ON loss_reasons;
  CREATE TRIGGER loss_reasons_forbid_tenant_change BEFORE UPDATE OF tenant_id ON loss_reasons FOR EACH ROW EXECUTE FUNCTION forbid_tenant_change();
END $$;
REVOKE ALL ON loss_reasons FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON loss_reasons TO app_user;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON loss_reasons FROM %I', r);
    END IF;
  END LOOP;
END $$;

RESET ROLE;
COMMIT;
