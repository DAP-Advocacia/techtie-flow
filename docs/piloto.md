# Piloto: colocando o TechTie Flow para operar

Guia para o **primeiro ambiente real** (poucos usuários, 1 ou 2 números de WhatsApp). Tudo aqui
foi exercitado por testes automáticos (`npm test`: banco real em Docker, API, WebSocket e o
servidor), **exceto** a conexão com um WhatsApp de verdade e as telas no navegador — ver §6.

## 1. O que já funciona neste modo

- **Login real** (senha com scrypt, bloqueio após 5 erros, token assinado) e **convite de usuários**
  por link de uso único.
- **Dados reais no banco** (Postgres com RLS): contatos, conversas, mensagens, negócios, funis.
- **Permissões do motor no servidor**: cada lista e cada ação passa pelas mesmas regras que o
  protótipo mostra (Atendente só vê o que é dele + a fila; SDR não move para Ganho; etc.).
- **WhatsApp (Baileys)**: parear número por QR real, **receber** mensagens (sem duplicar), **responder**
  pelo Inbox, status de entrega, tempo real por WebSocket entregue **só a quem pode ver**.
- Conversa nova do cliente cai na **fila**; responder a atribui a quem respondeu; transferir e
  resolver gravam no servidor; tudo com trilha de auditoria.

Também é real (desde 16/10): **CRM** (contatos, negócios, produtos e propostas), **funis configuráveis**, **tarefas**, **chat interno**,
**perfil**, **importar/exportar CSV**, **Dashboard** com números do banco e **Agente de IA** com a OpenAI (precisa de `OPENAI_API_KEY`).
Visão completa do que existe: [README](../README.md#status-24102026) e [arquitetura.md](arquitetura.md).

**Ainda é demonstração ou ainda não existe, mesmo em operação:**
- **Automações:** o editor existe, mas o **motor de execução no servidor não** (em operação a tela abre vazia e avisa).
- **Marca e domínio personalizado** (Configurações): só na tela; a verificação de CNAME é simulada.
- Criar/editar **equipes** pela tela e editar dados de outro usuário/redefinir MFA não gravam no servidor. Perfis de acesso, convidar,
  suspender/reativar usuário e atribuir equipes a um usuário **são** reais.
- Cloud API oficial, envio de mídia pelo Inbox, ligações, campos personalizados, `.xlsx`.

## 2. Pré-requisitos

1. **Postgres** (Supabase em São Paulo serve). Duas conexões:
   `DIRECT_URL` (administrador, porta 5432, só para migrar/semear) e `DATABASE_URL`
   (papel `app_user`, pooler, usada pela aplicação).
2. **Um servidor Node 22** com disco persistente (a pasta `AUTH_FOLDER` guarda as credenciais do
   WhatsApp: perdê-la obriga todos a escanear o QR de novo) — ex.: contêiner no EasyPanel com volume.
3. **1 ou 2 chips só de teste.** O Baileys é conexão não oficial: o WhatsApp pode restringir o número.

## 3. Subindo

```bash
cp .env.example .env     # preencha DIRECT_URL, DATABASE_URL, AUTH_TOKEN_SECRET, APP_USER_PASSWORD
npm install
APP_USER_PASSWORD=... node db/migrate.mjs      # cria o schema e define a senha do app_user
SEED_TENANT_NAME="Minha Empresa" SEED_TENANT_SLUG=minha-empresa \
SEED_ADMIN_NAME="Seu Nome" SEED_ADMIN_EMAIL=voce@empresa.com.br SEED_ADMIN_PASSWORD='uma-senha-longa' \
  node db/seed.mjs                              # 1º tenant + administrador + funis
npm start                                       # http://localhost:3333 (front + API + WebSocket)
```

Preencha `DATABASE_URL` com o usuário **`app_user`** (nunca o `postgres`): é o que garante o
isolamento entre empresas por RLS. Não coloque segredos no chat nem em argumentos de comando.

## 4. Front na Vercel falando com a API

O site da Vercel continua em **modo demo** até você apontar a API:

1. Publique a API em um endereço HTTPS (ex.: `https://api.suaempresa.com.br`).
2. Na Vercel, variável de ambiente **`TTF_API_URL=https://api.suaempresa.com.br`** e novo deploy.
   (`scripts/build-static.mjs` grava `config.js`; sem a variável o site fica em demo.)
3. No servidor da API: **`CORS_ORIGIN=https://techtie-flow.vercel.app`** e **`APP_URL=` o mesmo**.

O token de login fica na `sessionStorage` (some ao fechar a aba). Quando front e API estiverem em
subdomínios do mesmo domínio, trocar por cookie `httpOnly` (pendência de segurança abaixo).

## 5. Roteiro de teste (15 minutos)

1. Entre com o admin do seed. Em **Instâncias → Conectar novo número**, nomeie e leia o **QR** com o chip de teste.
2. Mande uma mensagem **de outro celular** para esse número → aparece no Inbox, na **fila**.
3. Convide um **Atendente** (Permissões → Usuários → Convidar), abra o link, defina a senha e entre.
4. Como Atendente: a conversa da fila aparece; responda → a mensagem sai no WhatsApp e a conversa passa a ser dele.
5. Como outro Atendente (ou o admin): confirme que a conversa **do primeiro** não aparece para o segundo.
6. Crie um negócio, mova entre etapas e confira o que cada perfil enxerga.

## 6. O que NÃO foi verificado (faça no primeiro teste)

- **Conexão real com o WhatsApp** (pareamento, recebimento e envio com um número de verdade): o
  código do gateway é o herdado do DapZap, que roda em produção, e a integração com o banco foi
  testada com um canal falso. O primeiro pareamento real é o teste que falta.
- **Telas no navegador:** a lógica de dados e as telas num DOM simulado são testadas (`test/api/live-state.test.mjs`, `test/ui/`), mas o
  **layout** (principalmente no celular) só se confere olhando no navegador após cada Redeploy. Se algo quebrar, mande a mensagem do console.
- **Mídia** (imagem/áudio recebidos) vai para o Supabase Storage quando há `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, senão para disco local
  (`MEDIA_FOLDER`); o envio de mídia pelo Inbox ainda não existe (só texto).

## 7. Antes de ir além do piloto

- Cookie `httpOnly` em vez de token na `sessionStorage`; MFA; recuperação de senha (hoje só o admin convida de novo).
- Credenciais do Baileys no banco e workers por número (docs/arquitetura-hospedagem.md); backup do `AUTH_FOLDER`.
- Backlog de segurança do motor (docs/permissoes.md §11) e persistência real de equipes.
- Cloud API oficial da Meta; envio de mídia; motor de automações no servidor.

## Números individuais (pessoais) e números da empresa

Todo número de WhatsApp (instância) pode ter **responsável** (`instances.owner_id`) e **equipe** (`team_id`):

| | Número da empresa | Número pessoal |
|---|---|---|
| Responsável | nenhum | quem criou |
| Conversas novas | fila de todos que atendem | direto para o responsável |
| Quem cria | quem tem `instance.create` em "Tudo" (envia `companyNumber: true`) | qualquer um com `instance.create` em "Só o dele" |
| Quem enxerga/conecta | quem tem alcance "Tudo" | o dono; a equipe se o alcance for "Equipe"; "Tudo" |

Perfis de fábrica: **Atendente/SDR** → ler, criar, renomear e conectar `own` (só os números dele);
**Gestor** → `team_tree`; **Admin** → tudo. Aplique a migração com `node db/migrate.mjs` (0003).

Pendente: trocar o responsável de um número depois de criado ("Vincular responsável" ainda é só visual em modo operação),
remover/renomear número persistido no servidor, e nome do número na Inbox para quem não lê o número da empresa.
