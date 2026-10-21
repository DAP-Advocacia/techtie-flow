# Tarefas

Módulo de tarefas **individual**, **compartilhável** e **delegável**, avulsa ou ligada a negócio e/ou contato. Desenhado
para ser mais leve que o do Bitrix (um responsável, poucos campos) e responder "o que eu faço hoje?".

## Modelo
- **Responsável** (uma pessoa). **Delegar** = trocar o responsável (`task.transfer`); fica registrado quem passou para quem.
  Quem **criou/delegou** continua **vendo** a tarefa (só leitura) — regra de fábrica por `createdBy`.
- **Compartilhar** = dar acesso a uma pessoa ou equipe: *Só ver* ou *Pode editar* (`resource_shares`, igual aos negócios).
- Campos: título, descrição, prazo (data e hora opcional), prioridade (Normal/Alta/Urgente), status
  (A fazer · Em andamento · **Aguardando** · Feita), checklist, negócio e contato vinculados.
- Prazo só com data é guardado ao **meio-dia local** (nenhum fuso empurra para o dia vizinho); só é "atrasada" quando o dia termina.
- Apagar o negócio/contato **não apaga** a tarefa (só desfaz o vínculo). Vínculo só com registro que a própria pessoa pode ler.
- Histórico (delegou, concluiu, reabriu, compartilhou) e comentários em `task_comments` (só inserção).

## Onde aparece
- **Tarefas** (menu; aba no celular): "Minhas" agrupadas em Atrasadas · Hoje · Próximos 7 dias · Depois · Sem prazo ·
  Concluídas; visões *Delegadas por mim*, *Compartilhadas comigo*, *Equipe*, *Todas* (só aparecem se houver tarefa);
  **quadro** por status (arrastar muda o status; só no computador); filtro por título.
- **Criar rápido**: "ligar para a Carla amanhã 10h !alta" → título, prazo e prioridade entendidos
  (hoje, amanhã, depois de amanhã, em/daqui a N dias, semana que vem, segunda…domingo, dia 25, 25/10, 25/10/2026, 10h, 10h30, 14:30, às 9, !alta, !urgente).
- **Painel** (gaveta; tela cheia no celular): cada campo salva ao sair dele; checklist; delegar; compartilhar; atividade.
- **Dentro do negócio** (painel da proposta), **do contato** (ficha), **da conversa** (painel do contato na Inbox) e
  **no Início** ("Para hoje" + indicador de atrasadas), sempre com "+ Tarefa" já vinculado.

## Permissões de fábrica
| Perfil | Tarefas |
|---|---|
| Admin | tudo |
| Gestor | ler/criar/editar/excluir/delegar/compartilhar da equipe e subequipes (+ vê as que delegou) |
| Atendente, SDR | as próprias: ler/criar/editar/excluir/delegar/compartilhar (+ vê as que delegou) |
| Somente leitura | lê todas as tarefas (não cria nem edita) |
| Financeiro | sem tarefas |

## API (tudo decidido pelo motor no servidor)
`POST /api/tasks` · `PATCH /api/tasks/:id` · `POST /api/tasks/:id/delegate` · `POST|DELETE /api/tasks/:id/shares[/:type/:id]` ·
`DELETE /api/tasks/:id` · `GET|POST /api/tasks/:id/comments`. As tarefas vêm no `/api/bootstrap` (feitas há mais de 30 dias ficam de fora)
e o tempo real avisa quem recebeu, perdeu ou ganhou acesso a uma tarefa (`{ type: 'tasks' }`).

## Testes
- Modelo puro (prazo, grupos, visões, criar rápido): `test/api/tasks-model.test.mjs`.
- API de ponta a ponta contra Postgres real: `test/api/api.test.mjs` (tarefas).
- **Telas executadas num DOM simulado** (linkedom, sem navegador): `test/ui/tasks-ui.test.mjs` e `test/ui/screens-smoke.test.mjs`
  (monta todas as telas com vários perfis). Não medem layout/pixels — para isso, olhar no navegador.

## Fora desta versão (de propósito)
Recorrência ("toda segunda"), lembretes por notificação no celular, subtarefas aninhadas, dependências, visão de calendário,
tarefas geradas por automação/IA e KPI de tarefas atrasadas no Dashboard.
