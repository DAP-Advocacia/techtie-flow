-- 0006_deal_expected_close.sql — previsão de fechamento do negócio (data). Alimenta "Fechando este mês" no Início
-- e o campo "Previsão de fechamento" da página do negócio. Só data (sem hora): coluna `date`.
BEGIN;
SET LOCAL ROLE app_owner;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS expected_close date;
CREATE INDEX IF NOT EXISTS deals_tenant_expected_close_ix ON deals (tenant_id, expected_close) WHERE expected_close IS NOT NULL;
RESET ROLE;
COMMIT;
