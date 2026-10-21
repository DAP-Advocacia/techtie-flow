-- 0005_tasks.sql — módulo de TAREFAS (individual, compartilhável e delegável; avulsa ou ligada a negócio/contato).
-- A tabela `tasks` já existia só com o esqueleto de permissões (título, status, dono, equipe). Aqui ela ganha o resto:
-- descrição, prioridade, prazo, vínculos, criador (quem delegou), conclusão e checklist; mais comentários/histórico
-- e o compartilhamento por registro (resource_shares) passa a valer para tarefas.
-- Depende só de 0001 (não de 0002/0004): o harness de SQL carrega esta migração junto com o núcleo.
BEGIN;
SET LOCAL ROLE app_owner;

UPDATE tasks SET title = '(sem título)' WHERE title IS NULL OR btrim(title) = '';
UPDATE tasks SET status = 'todo' WHERE status IS NULL OR status NOT IN ('todo', 'doing', 'waiting', 'done');

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS description   text CHECK (description IS NULL OR char_length(description) <= 10000),
  ADD COLUMN IF NOT EXISTS priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS due_at        timestamptz,
  ADD COLUMN IF NOT EXISTS due_has_time  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deal_id       uuid,
  ADD COLUMN IF NOT EXISTS contact_id    uuid,
  ADD COLUMN IF NOT EXISTS created_by    uuid,
  ADD COLUMN IF NOT EXISTS completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS checklist     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checklist) = 'array'),
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

ALTER TABLE tasks ALTER COLUMN title SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'todo';
ALTER TABLE tasks ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_status_values') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_values CHECK (status IN ('todo', 'doing', 'waiting', 'done'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_title_nonblank') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_title_nonblank CHECK (char_length(btrim(title)) >= 1);
  END IF;
  -- FKs compostas (id, tenant_id): uma tarefa nunca aponta para negócio/contato/usuário de outro tenant.
  -- Apagar o negócio/contato NÃO apaga a tarefa (só desfaz o vínculo): ela continua sendo trabalho de alguém.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_deal_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_deal_fk FOREIGN KEY (deal_id, tenant_id) REFERENCES deals (id, tenant_id) ON DELETE SET NULL (deal_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_contact_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_contact_fk FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE SET NULL (contact_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_created_by_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_created_by_fk FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (created_by);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tasks_tenant_owner_due_ix ON tasks (tenant_id, owner_id, status, due_at);
CREATE INDEX IF NOT EXISTS tasks_tenant_creator_ix   ON tasks (tenant_id, created_by);
CREATE INDEX IF NOT EXISTS tasks_tenant_deal_ix      ON tasks (tenant_id, deal_id);
CREATE INDEX IF NOT EXISTS tasks_tenant_contact_ix   ON tasks (tenant_id, contact_id);

-- ---- comentários e histórico da tarefa (delegou, mudou status, compartilhou…) --------------------------
CREATE TABLE IF NOT EXISTS task_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  task_id     uuid NOT NULL,
  author_id   uuid,
  kind        text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'event')),
  body        text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 5000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (task_id, tenant_id)   REFERENCES tasks (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (author_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (author_id)
);
CREATE INDEX IF NOT EXISTS task_comments_task_ix ON task_comments (tenant_id, task_id, created_at);

DO $$
BEGIN
  ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE task_comments FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON task_comments;
  CREATE POLICY tenant_isolation ON task_comments AS RESTRICTIVE FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
  DROP POLICY IF EXISTS app_allow ON task_comments;
  CREATE POLICY app_allow ON task_comments AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
  DROP TRIGGER IF EXISTS task_comments_forbid_tenant_change ON task_comments;
  CREATE TRIGGER task_comments_forbid_tenant_change BEFORE UPDATE OF tenant_id ON task_comments FOR EACH ROW EXECUTE FUNCTION forbid_tenant_change();
END $$;
REVOKE ALL ON task_comments FROM PUBLIC;
GRANT SELECT, INSERT ON task_comments TO app_user; -- histórico não se edita nem se apaga (some junto com a tarefa)

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON task_comments FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- compartilhamento por registro também para tarefas -------------------------------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'resource_shares'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%entity%' AND pg_get_constraintdef(oid) LIKE '%deal%' LOOP
    EXECUTE format('ALTER TABLE resource_shares DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE resource_shares ADD CONSTRAINT resource_shares_entity_check CHECK (entity IN ('contact', 'company', 'deal', 'task'));
END $$;
ALTER TABLE resource_shares ADD COLUMN IF NOT EXISTS task_id uuid GENERATED ALWAYS AS (CASE WHEN entity = 'task' THEN resource_id END) STORED;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_task_fk') THEN
    ALTER TABLE resource_shares ADD CONSTRAINT resource_shares_task_fk FOREIGN KEY (task_id, tenant_id) REFERENCES tasks (id, tenant_id) ON DELETE CASCADE;
  END IF;
END $$;

RESET ROLE;
COMMIT;
