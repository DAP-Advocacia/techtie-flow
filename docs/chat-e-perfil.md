# Chat interno e perfil

## Chat interno (aba Inbox → "Chat interno")
A Inbox tem agora **dois inboxes** e a pessoa alterna entre eles no topo: **Atendimento** (conversas de WhatsApp com clientes —
só para quem pode ler conversas) e **Chat interno** (conversa entre as pessoas da empresa — aberto a todos). Quem não atende
clientes abre direto no chat, sem a alternância. `#/inbox?view=chat` abre no chat; a busca global (Ctrl+K) tem "Chat interno".
- **Conversa direta**: uma sala por par de pessoas (abrir de novo reaproveita a mesma, de qualquer um dos lados).
- **Grupos**: nome + pessoas (até 50); quem está no grupo pode **adicionar** mais gente (quem entra lê o histórico do grupo).
  Conversa direta não aceita terceiros.
- Só pessoas **ativas** da empresa (nada de robô, convidado que não entrou ou suspenso; nada de outra empresa).
- **Não lidas** por sala, com contador na aba, no menu Inbox, no celular e no sino da barra superior. Abrir a sala marca como lida.
- Mensagens: até 4000 caracteres, Enter envia, Shift+Enter quebra a linha; **não se editam nem se apagam** (histórico). Separador
  de dia e blocos por pessoa.
- **Privacidade**: só quem participa da sala a vê. Nem o Admin lê conversa alheia. A API confere a participação em toda rota,
  o tempo real vai **só aos participantes** e a RLS isola por empresa. Criar grupo e adicionar pessoas ficam na auditoria.
- Não passa pelo motor de permissões (é entre pessoas, não é dado de negócio).

## Meu perfil (`#/profile`)
Abre pelo nome no menu lateral ou pelo avatar da barra superior (e "Meu perfil" na busca). Cada pessoa vê os próprios dados e
edita **nome, cargo, telefone e "sobre você"** (até 300 caracteres). **E-mail, perfil de acesso, equipes e verificação em duas
etapas** são só leitura. Só mexe no **próprio** perfil (`PATCH /api/me`, que ignora qualquer outro campo). O **telefone** só é
visto pela própria pessoa e por quem administra usuários; cargo e "sobre" os colegas veem. Os colegas recebem o nome novo na hora.
Ainda **não há** troca de senha nem de e-mail pela tela.

## Técnico
- Migração `0009_chat_profile.sql`: `users.job_title/phone/bio` e `chat_rooms`, `chat_members`, `chat_messages` (RLS por empresa).
- API `src/api/routes-chat.js`: `GET/POST /api/chat/rooms`, `POST /api/chat/rooms/:id/members`, `GET/POST /api/chat/rooms/:id/messages`,
  `POST /api/chat/rooms/:id/read`, `PATCH /api/me`. Tempo real: `hub.emitTo` (só os participantes) e evento `directory` para nomes.
- Front: `screens/inbox.js` (alternância), `inbox/chat.js`, `inbox/chat/model.js` (puro), `inbox/chat/actions.js`, `screens/profile.js`.
- Testes: `test/api/chat-model.test.mjs`, `profile-model.test.mjs`, `test/ui/chat-ui.test.mjs`, `profile-ui.test.mjs` e o fluxo completo
  (isolamento, tempo real, não lidas, grupos, perfil) contra Postgres real em `test/api/api.test.mjs`.
