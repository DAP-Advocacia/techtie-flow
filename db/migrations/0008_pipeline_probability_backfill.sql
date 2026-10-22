-- 0008_pipeline_probability_backfill.sql — preenche a probabilidade das etapas dos funis que já existiam.
-- Ganho = 100; abertas espalhadas pelo funil (2 abertas → 33 e 67; 3 → 25, 50 e 75); perdido segue 0.
-- Roda uma vez POR EMPRESA com o tenant definido (a RLS é FORCE: sem `app.tenant_id` o UPDATE não enxerga linha nenhuma —
-- foi o que deixou tudo em 0% na 0007). Só mexe no que ninguém configurou: etapa ganha com 0 e funis em que TODAS as
-- etapas abertas ainda estão em 0 (quem já ajustou algum valor pela tela não é sobrescrito). Pode rodar de novo sem efeito.
BEGIN;

-- lista as empresas com o papel administrador (a RLS de `tenants` esconderia todas depois de trocar de papel)
SELECT set_config('app.backfill_tenants', COALESCE((SELECT string_agg(id::text, ',') FROM tenants), ''), true);

SET LOCAL ROLE app_owner;

DO $$
DECLARE tid text;
BEGIN
  FOREACH tid IN ARRAY string_to_array(current_setting('app.backfill_tenants'), ',') LOOP
    CONTINUE WHEN tid = '';
    PERFORM set_config('app.tenant_id', tid, true);
    UPDATE pipeline_stages SET probability = 100 WHERE kind = 'won' AND probability = 0;
    UPDATE pipeline_stages s SET probability = r.p
      FROM (
        SELECT id,
               round(100.0 * row_number() OVER (PARTITION BY pipeline_id ORDER BY position, created_at) / (count(*) OVER (PARTITION BY pipeline_id) + 1))::int AS p,
               max(probability) OVER (PARTITION BY pipeline_id) AS mx
        FROM pipeline_stages
        WHERE kind = 'open'
      ) r
      WHERE s.id = r.id AND r.mx = 0;
  END LOOP;
END $$;

RESET ROLE;
COMMIT;
