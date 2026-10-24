# Publicar o TechTie Flow na VPS (Hostinger + Coolify)

Primeira versão em operação, **sem Vercel**: um único contêiner serve o site, a API, o tempo real (WebSocket)
e o WhatsApp (Baileys). O banco continua no **Supabase** (São Paulo) e a mídia, no Storage do Supabase.

```
navegador ──HTTPS──► Coolify (Traefik, certificado automático) ──► contêiner techtie-flow :3333
                                                                     ├─ site + API + WebSocket
                                                                     ├─ WhatsApp (Baileys)  ◄── volume /app/auth_session
                                                                     └─► Supabase (Postgres + Storage)
```

Validado: a imagem (`Dockerfile` da raiz) compila (≈ 200 MB), sobe e serve o site e os arquivos de `public/assets`.

## Antes de começar (uma vez só)

1. **Pare o servidor local** (`npm start` no seu computador) antes de conectar números na VPS. O mesmo número
   de WhatsApp **não pode** estar conectado em dois lugares ao mesmo tempo: o WhatsApp derruba um deles.
2. As sessões de WhatsApp que existem hoje no seu computador (`auth_session/`) **não vão para a VPS**.
   Os números já criados aparecem na lista, mas "desconectados": clique em **Reconectar** e leia o QR Code de novo.
3. O banco é o mesmo (Supabase), então usuários, perfis, conversas e números continuam lá.

## Passo a passo no Coolify

Painel: botão **Gerenciar painel** na visão geral da VPS (Hostinger → VPS → o seu servidor).

1. **Projeto → Novo recurso → Aplicação → repositório Git**
   - Repositório: `https://github.com/DAP-Advocacia/techtie-flow` (privado: conecte o GitHub ao Coolify
     por *Sources → GitHub App*, ou use uma *Deploy key* em *Keys & Tokens*).
   - Branch: `main`. **Build Pack: Dockerfile**. Porta exposta: **3333**.
2. **Domínio** (aba *General → Domains*):
   - Sem domínio ainda: use o que o Coolify sugere (`http://….187.127.50.240.sslip.io`) e troque `http` por `https`.
     O certificado Let's Encrypt sai sozinho.
   - Com domínio próprio (ex.: `flow.techtie.com.br`): crie um registro **A** apontando para `187.127.50.240`
     e informe `https://flow.techtie.com.br` no campo de domínio.
3. **Variáveis de ambiente** (aba *Environment Variables*; copie os valores do seu `.env` local, **nunca** do Git):

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | a mesma do `.env` (pooler de transação do Supabase) |
   | `AUTH_TOKEN_SECRET` | o mesmo do `.env` (mantém as sessões de login) ou um novo de 32+ caracteres |
   | `SUPABASE_URL` | a mesma do `.env` |
   | `SUPABASE_SERVICE_ROLE_KEY` | a mesma do `.env` (marque como *secret*) |
   | `APP_URL` | a URL pública, ex.: `https://flow.techtie.com.br` (vira o link dos convites) |
   | `TRUST_PROXY` | `true` (há proxy na frente; sem isso o limite de tentativas de login enxerga o IP errado) |
   | `AUTH_FOLDER` | `/app/auth_session` |
   | `MAX_CONCURRENT_PAIRINGS` | `4` |
   | `OPENAI_API_KEY` | chave da OpenAI (marque como *secret*) — liga o Agente de IA; sem ela a IA não responde |
   | `OPENAI_MODEL`, `AI_DAILY_TOKEN_CAP` | opcionais (padrão `gpt-4o-mini` e 300000 tokens/dia por empresa) |

   Lista completa com padrões: [configuracao.md](configuracao.md).

   Não defina `CORS_ORIGIN`: o site e a API estão na mesma origem.
   **Não** coloque `APP_USER_PASSWORD` nem `DIRECT_URL`: servem só para migrar o banco e isso já está feito.
4. **Armazenamento persistente** (aba *Persistent Storage*): volume com destino **`/app/auth_session`**.
   Sem isso, cada deploy apaga as sessões do WhatsApp e todos os números pedem QR de novo.
5. **Health check** (aba *Health Checks*): caminho `/api/health`, porta `3333`
   (a imagem já traz um healthcheck próprio).
6. **Deploy**. O primeiro build leva alguns minutos. Quando estiver verde, abra a URL: a tela de login deve aparecer
   com a logo, e o log mostra `operação (API + WebSocket + WhatsApp)`.
7. Entre com o seu usuário, vá em **Instâncias → Reconectar** e leia o QR Code.

## Teste do fluxo completo (checklist)

- [ ] Login com o admin; logout e login de novo.
- [ ] Convite de um atendente (o link usa `APP_URL`) e primeiro acesso dele.
- [ ] Número conectado por QR; mandar e receber uma mensagem.
- [ ] Atendente com número próprio: vê só o dele e recebe as conversas dele.
- [ ] Reiniciar o contêiner no Coolify: o número volta sozinho, **sem** novo QR (prova que o volume funciona).

## Operação

- **Atualizar:** `git push` na `main` e clicar em *Redeploy* (ou ligar *Auto Deploy* por webhook).
  **Push não publica sozinho:** a produção só muda depois do *Redeploy*. Se o commit trouxe **migração nova** (`db/migrations/`),
  aplique-a **antes**, do seu computador: `node db/migrate.mjs` (precisa de `DIRECT_URL` e é idempotente). Migrações aplicadas até hoje: 0001–0009.
  Mantenha `APP_URL=https://crm.techtie.digital` (um valor velho quebraria os links de convite).
  Cada redeploy reinicia o servidor e religa os números em fila (alguns minutos até voltarem todos).
- **Logs:** aba *Logs* do Coolify. O servidor já esconde chaves e ruído de criptografia do WhatsApp.
- **Backup:** o banco é do Supabase (backups do próprio plano). O que a VPS guarda de insubstituível é o volume
  `/app/auth_session`; os snapshots da VPS (Hostinger) cobrem isso, e perdê-lo só exige ler os QR Codes de novo.
- **Segurança:** a chave de serviço do Supabase e o `AUTH_TOKEN_SECRET` ficam só no painel do Coolify.
  Mantenha o firewall da VPS liberando apenas 22 (SSH), 80 e 443; a porta 3333 não precisa ficar exposta
  (o Traefik fala com o contêiner por dentro). Troque a senha root padrão e prefira chave SSH.

## Limites desta primeira versão

- **Um único contêiner** com todos os números: serve para o piloto (dezenas de números). Para centenas de
  números por empresa, o plano de workers está em `docs/arquitetura-hospedagem.md`.
- O front hospedado na Vercel continua em **modo demonstração** (dados fictícios); o modo operação roda só aqui.
EOF
