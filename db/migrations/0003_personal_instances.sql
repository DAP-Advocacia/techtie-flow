-- Números individuais: uma instância (número de WhatsApp) pode ter RESPONSÁVEL (owner_id) e EQUIPE (team_id).
--   owner_id NULL  = número da empresa (as conversas novas vão para a fila de todos)
--   owner_id = X   = número pessoal do atendente X (as conversas novas vão direto para ele)
-- FKs compostas (id, tenant_id): um número não aponta para usuário/equipe de outro tenant.
ALTER TABLE instances
  ADD COLUMN IF NOT EXISTS owner_id uuid,
  ADD COLUMN IF NOT EXISTS team_id  uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instances_owner_fk') THEN
    ALTER TABLE instances ADD CONSTRAINT instances_owner_fk
      FOREIGN KEY (owner_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (owner_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instances_team_fk') THEN
    ALTER TABLE instances ADD CONSTRAINT instances_team_fk
      FOREIGN KEY (team_id, tenant_id) REFERENCES teams (id, tenant_id) ON DELETE SET NULL (team_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS instances_tenant_owner_ix ON instances (tenant_id, owner_id);
