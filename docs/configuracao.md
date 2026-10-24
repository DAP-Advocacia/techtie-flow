# Configuração (variáveis de ambiente)

O servidor lê `.env` (se existir) e o ambiente do processo; no Coolify, tudo vem de *Environment Variables*. O modelo está em
`.env.example`. **Nunca** coloque segredo no Git, no chat ou em argumento de comando; no Coolify marque chaves como *secret*.

## Obrigatórias para o modo operação

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Postgres da aplicação, **usuário `app_user`** (nunca `postgres`), pooler de transação. Sem ela o servidor sobe em demonstração |
| `AUTH_TOKEN_SECRET` | segredo que assina os tokens de login (**32+ caracteres**). `node -p "require('crypto').randomBytes(48).toString('base64url')"`. Trocar derruba todas as sessões |
| `APP_URL` | URL pública (ex.: `https://crm.techtie.digital`); entra nos links de convite. **Em produção mantenha `https://crm.techtie.digital`** |

## Recomendadas em produção

| Variável | Valor / efeito |
|---|---|
| `TRUST_PROXY` | `true` atrás de proxy (Coolify/Traefik): lê o IP real (limite de tentativas de login, auditoria por IP). Sem proxy, deixe desligado (senão qualquer cliente forja o cabeçalho) |
| `AUTH_FOLDER` | onde ficam as credenciais do WhatsApp. No contêiner: `/app/auth_session`, **volume persistente** (sem isso todo deploy pede QR de novo) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Storage de mídia recebida (secret). Sem eles a mídia vai para `MEDIA_FOLDER` |
| `MAX_CONCURRENT_PAIRINGS` | pareamentos de QR simultâneos (padrão 4; picos derrubam tentativas) |
| `OPENAI_API_KEY` | liga o Agente de IA (secret). Sem ela o resto funciona e a IA não responde |
| `OPENAI_MODEL` | padrão `gpt-4o-mini`; use modelos que aceitem `temperature`/`max_tokens` (família gpt-4o / gpt-4.1); os "gpt-5*" e "o*" exigem outros parâmetros |
| `AI_DAILY_TOKEN_CAP` | teto de tokens por dia e por empresa (padrão 300000) |

## Opcionais

| Variável | Padrão | Efeito |
|---|---|---|
| `PORT` | 3333 | porta do servidor |
| `AUTH_TOKEN_TTL_HOURS` | 12 | validade do token de login |
| `CORS_ORIGIN` | vazio | origens do front autorizadas (separadas por vírgula). Só quando o front roda em **outro domínio** (ex.: Vercel). Mesma origem: deixe vazio |
| `WHATSAPP_ENABLED` | ligado | `false` desliga só o canal de WhatsApp (API e login continuam) |
| `MEDIA_FOLDER` | `./media_store` | mídia recebida quando não há Supabase Storage |
| `MAX_RECONNECT_ATTEMPTS` | 20 | reconexões **consecutivas** antes de marcar o número como "precisa de atenção" |
| `SESSION_STAGGER_MS` | 15000 | intervalo entre religações de sessões ao subir |
| `DB_POOL_MAX` | 10 | conexões máximas com o pooler |

## Só para migrar e semear (nunca no Coolify)

| Variável | Uso |
|---|---|
| `DIRECT_URL` | administrador (porta 5432, sessão) para `db/migrate.mjs` |
| `APP_USER_PASSWORD` | define a senha do `app_user` ao migrar |
| `SEED_TENANT_NAME`, `SEED_TENANT_SLUG`, `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | `db/seed.mjs` cria a 1ª empresa, o admin e os funis |

## Só para o site estático (Vercel)

| Variável | Uso |
|---|---|
| `TTF_API_URL` | `https://api.suaempresa.com.br`: `scripts/build-static.mjs` grava `config.js` com `live: true` apontando a API. Sem ela o site fica em **demonstração**. Na API, defina `CORS_ORIGIN` e `APP_URL` com o endereço do site |

## Reservadas (ainda não usadas)

`META_APP_ID`, `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`: Cloud API oficial da Meta (`CloudApiChannel` ainda não implementado).

## Dicas

- Mudou variável no Coolify? É preciso **Redeploy** (reinicia o contêiner; os números religam em fila, alguns minutos).
- O servidor falha cedo com mensagem clara se `AUTH_TOKEN_SECRET` for curto ou `DATABASE_URL` faltar.
- O log de inicialização mostra o modo (`operação (API + WebSocket + WhatsApp)`) e se a OpenAI está configurada.
