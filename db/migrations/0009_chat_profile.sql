-- 0009_chat_profile.sql — CHAT INTERNO (conversa direta e grupos entre pessoas da empresa) e campos do PERFIL do usuário.
-- Chat: só quem participa da sala lê e escreve (a API confere a participação; a RLS garante o isolamento por empresa).
-- Mensagens não se editam nem se apagam (histórico). Perfil: cargo, telefone e "sobre" (o nome já existia).
-- Depende só de 0001 (tenants, users).
BEGIN;
SET LOCAL ROLE app_owner;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS job_title text CHECK (job_title IS NULL OR char_length(job_title) <= 80),
  ADD COLUMN IF NOT EXISTS phone     text CHECK (phone IS NULL OR char_length(phone) <= 30),
  ADD COLUMN IF NOT EXISTS bio       text CHECK (bio IS NULL OR char_length(bio) <= 300);

CREATE TABLE IF NOT EXISTS chat_rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  kind            text NOT NULL CHECK (kind IN ('dm', 'group')),
  name            text CHECK (name IS NULL OR char_length(btrim(name)) BETWEEN 1 AND 80),
  -- conversa direta: ids ordenados "a:b" (uma só sala por par de pessoas)
  dm_key          text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  last_body       text,
  last_author_id  uuid,
  UNIQUE (id, tenant_id),
  CHECK ((kind = 'dm') = (dm_key IS NOT NULL)),
  CHECK (kind = 'dm' OR name IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_dm_uq ON chat_rooms (tenant_id, dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_members (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  room_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id),
  FOREIGN KEY (room_id, tenant_id) REFERENCES chat_rooms (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user_ix ON chat_members (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  room_id    uuid NOT NULL,
  author_id  uuid NOT NULL,
  body       text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (room_id, tenant_id)   REFERENCES chat_rooms (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (author_id, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS chat_messages_room_ix ON chat_messages (tenant_id, room_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_rooms', 'chat_members', 'chat_messages'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON chat_rooms, chat_members TO app_user; -- sala: última mensagem; membro: marca de leitura
GRANT SELECT, INSERT ON chat_messages TO app_user;                    -- histórico: sem editar nem apagar

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON chat_rooms, chat_members, chat_messages FROM %I', r);
    END IF;
  END LOOP;
END $$;

RESET ROLE;
COMMIT;
