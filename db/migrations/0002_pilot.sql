-- 0002_pilot.sql — o que o PILOTO precisa além do núcleo de permissões (0001):
--   * mensagens (com dedupe por id do WhatsApp) e vínculos conversa↔contato↔negócio;
--   * estado das instâncias de WhatsApp (canal, status, telefone);
--   * identidade de LOGIN, guardada fora do alcance direto do papel da aplicação.
-- Aplique depois de 0001, com o mesmo administrador (db/migrate.mjs faz isso).
BEGIN;
SET LOCAL ROLE app_owner;

-- -----------------------------------------------------------------------------
-- Identidade de login
-- -----------------------------------------------------------------------------
-- O login acontece ANTES de existir tenant no contexto: não dá para consultar
-- `users` (RLS). Em vez de abrir uma exceção na RLS, a senha mora numa tabela SEM
-- acesso para app_user e é lida/gravada só por funções SECURITY DEFINER que
-- expõem o mínimo (uma linha, por e-mail exato). E-mail é único no sistema inteiro
-- (case-insensitive) porque o usuário não informa o tenant ao entrar.
CREATE TABLE IF NOT EXISTS auth_identities (
  user_id            uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  email_lower        text NOT NULL UNIQUE,
  password_hash      text,
  invite_token_hash  text UNIQUE,
  invite_expires_at  timestamptz,
  failed_attempts    integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE
);
REVOKE ALL ON auth_identities FROM PUBLIC;

-- Lê uma identidade pelo e-mail exato. Devolve só o necessário para validar a senha.
CREATE OR REPLACE FUNCTION auth_lookup(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT i.user_id, i.tenant_id, i.password_hash, i.locked_until
    FROM auth_identities i
   WHERE i.email_lower = lower(btrim(p_email)) AND i.password_hash IS NOT NULL
   LIMIT 1;
$$;

-- Registra o resultado de uma tentativa: 5 erros seguidos travam por 15 minutos.
CREATE OR REPLACE FUNCTION auth_login_result(p_user_id uuid, p_ok boolean)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  UPDATE auth_identities
     SET failed_attempts = CASE WHEN p_ok THEN 0 ELSE failed_attempts + 1 END,
         locked_until    = CASE WHEN p_ok THEN NULL
                                WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
                                ELSE locked_until END,
         last_login_at   = CASE WHEN p_ok THEN now() ELSE last_login_at END
   WHERE user_id = p_user_id;
$$;

-- Cria a identidade de um usuário já existente NO tenant do chamador (a RLS de
-- `users`, sob o set_config da transação do chamador, impede registrar usuário de
-- outro tenant). `p_invite_hash` = SHA-256 do token de convite (o token em claro
-- nunca vai ao banco).
CREATE OR REPLACE FUNCTION auth_register(p_user_id uuid, p_email text, p_invite_hash text, p_ttl interval DEFAULT interval '7 days')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT u.tenant_id INTO v_tenant FROM users u WHERE u.id = p_user_id;  -- RLS do chamador
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'usuário inexistente neste tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO auth_identities (user_id, tenant_id, email_lower, invite_token_hash, invite_expires_at)
  VALUES (p_user_id, v_tenant, lower(btrim(p_email)), p_invite_hash, now() + p_ttl)
  ON CONFLICT (user_id) DO UPDATE
     SET email_lower = EXCLUDED.email_lower,
         invite_token_hash = EXCLUDED.invite_token_hash,
         invite_expires_at = EXCLUDED.invite_expires_at;
END;
$$;

-- Aceita o convite: define a senha, consome o token e ativa o usuário.
-- Devolve false se o token for inválido/expirado (sem dizer qual: não vaza nada).
CREATE OR REPLACE FUNCTION auth_accept_invite(p_token_hash text, p_password_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v record;
BEGIN
  SELECT i.user_id, i.tenant_id INTO v
    FROM auth_identities i
   WHERE i.invite_token_hash = p_token_hash AND i.invite_expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.tenant_id', v.tenant_id::text, true);  -- só nesta transação
  UPDATE auth_identities
     SET password_hash = p_password_hash, invite_token_hash = NULL, invite_expires_at = NULL,
         failed_attempts = 0, locked_until = NULL
   WHERE user_id = v.user_id;
  UPDATE users SET status = 'active' WHERE id = v.user_id AND status = 'invited';
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION auth_lookup(text), auth_login_result(uuid, boolean),
                       auth_register(uuid, text, text, interval), auth_accept_invite(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup(text), auth_login_result(uuid, boolean),
                          auth_register(uuid, text, text, interval), auth_accept_invite(text, text) TO app_user;

-- -----------------------------------------------------------------------------
-- Instâncias (números de WhatsApp)
-- -----------------------------------------------------------------------------
ALTER TABLE instances
  ADD COLUMN IF NOT EXISTS channel          text NOT NULL DEFAULT 'baileys' CHECK (channel IN ('baileys', 'cloud_api')),
  ADD COLUMN IF NOT EXISTS status           text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'queued', 'connecting', 'qr', 'connected', 'attention')),
  ADD COLUMN IF NOT EXISTS phone            text CHECK (phone IS NULL OR phone ~ '^[0-9]{8,15}$'),
  ADD COLUMN IF NOT EXISTS attention_reason text CHECK (attention_reason IS NULL OR char_length(attention_reason) <= 80),
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- -----------------------------------------------------------------------------
-- Contatos, negócios e conversas: vínculos
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_phone_ux ON contacts (tenant_id, phone) WHERE phone IS NOT NULL;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS contact_id uuid,
  ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_contact_fk;
ALTER TABLE deals ADD CONSTRAINT deals_contact_fk FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE SET NULL (contact_id);
CREATE INDEX IF NOT EXISTS deals_tenant_contact_ix ON deals (tenant_id, contact_id);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS contact_id       uuid,
  ADD COLUMN IF NOT EXISTS last_message_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_message     text CHECK (last_message IS NULL OR char_length(last_message) <= 300),
  ADD COLUMN IF NOT EXISTS unread_count     integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0);
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_contact_fk;
ALTER TABLE conversations ADD CONSTRAINT conversations_contact_fk FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE SET NULL (contact_id);
-- uma conversa por (número, contato): chegar mensagem do mesmo contato reusa a conversa
CREATE UNIQUE INDEX IF NOT EXISTS conversations_instance_contact_ux ON conversations (tenant_id, instance_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_tenant_lastmsg_ix ON conversations (tenant_id, last_message_at DESC);

-- -----------------------------------------------------------------------------
-- Mensagens
-- -----------------------------------------------------------------------------
-- Quem pode ler uma mensagem é decidido pela aplicação (motor) sobre a CONVERSA;
-- aqui o banco garante o isolamento de tenant (RLS) e a integridade referencial.
-- Mensagens não se apagam (só o status muda): por isso app_user não recebe DELETE.
CREATE TABLE IF NOT EXISTS messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  conversation_id  uuid NOT NULL,
  wa_message_id    text CHECK (wa_message_id IS NULL OR char_length(wa_message_id) <= 128),
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  kind             text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'audio', 'video', 'document', 'sticker', 'note', 'system')),
  body             text CHECK (body IS NULL OR char_length(body) <= 20000),
  media_url        text CHECK (media_url IS NULL OR char_length(media_url) <= 1000),
  media_mime       text CHECK (media_mime IS NULL OR char_length(media_mime) <= 120),
  author_id        uuid,
  status           text NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (author_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE SET NULL (author_id)
);
-- a mesma mensagem pode chegar 2x (ao vivo e no backfill de histórico): grava uma só
CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_dedupe_ux ON messages (tenant_id, conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conv_created_ix ON messages (tenant_id, conversation_id, created_at);

-- RLS de tenant (mesmo padrão do 0001: restritiva + permissiva "true" + FORCE) e tenant_id imutável
DO $$
BEGIN
  ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE messages FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON messages;
  CREATE POLICY tenant_isolation ON messages AS RESTRICTIVE FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
  DROP POLICY IF EXISTS app_allow ON messages;
  CREATE POLICY app_allow ON messages AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
  DROP TRIGGER IF EXISTS messages_forbid_tenant_change ON messages;
  CREATE TRIGGER messages_forbid_tenant_change BEFORE UPDATE OF tenant_id ON messages FOR EACH ROW EXECUTE FUNCTION forbid_tenant_change();
END $$;

REVOKE ALL ON messages FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON messages TO app_user;

-- Supabase: papéis do PostgREST nunca enxergam estas tabelas (service_role tem BYPASSRLS)
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON messages, auth_identities FROM %I', r);
    END IF;
  END LOOP;
END $$;

RESET ROLE;
COMMIT;
