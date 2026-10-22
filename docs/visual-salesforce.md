# Visual inspirado no Salesforce (ondas 1 a 4)

Objetivo: o CRM ficar **amplo e navegável** como os bons CRMs (busca em tudo, registro com página própria, listas com
filtros, Início com o que importa) sem perder a cara da marca (preto e dourado, sóbrio). Nada aqui amplia acesso: tudo
passa pelo motor de permissões (`shared/permissions`) como o resto do sistema.

## Onda 1 — barra superior, busca global e "+ Novo"
- **Busca global** (`Ctrl+K`, `⌘K` ou `/` fora de campos): contatos, negócios, tarefas e telas, sem acento e sem
  diferenciar maiúscula; número digitado vira busca por telefone. Só aparece o que o usuário pode ler (telefone/e-mail
  ocultos no perfil não entram no índice). Recentes ficam no navegador.
- **+ Novo** (contato, negócio, tarefa): só as ações que o perfil pode fazer.
- Avisos (conversas na fila, tarefas atrasadas) e menu lateral que **recolhe** (lembra a escolha).
- Código: `public/js/shell/*`, `public/js/search/*` (modelo puro testado em `test/api/search-model.test.mjs`).

## Onda 2 — página do negócio
- `#/deal?id=…`: destaque (valor, etapa, responsável, previsão de fechamento), **Path** (etapas em seta; clicar move,
  etapa final pede confirmação), abas **Detalhes · Atividade · Proposta · Relacionados**.
- **Atividade real**: junta a auditoria do negócio (criou, alterou, moveu, passou, compartilhou, enviou proposta) com as
  tarefas ligadas — cada pessoa vê só o que pode ler (a tarefa de outro não vaza pelo feed).
- **Previsão de fechamento** (`deals.expected_close`, migração 0006).
- As ações (mover, editar, proposta, excluir, compartilhar) são as **mesmas** do quadro (`pipeline/controller.js`).

## Onda 3 — listas em tabela (computador)
Contatos (**Lista | Tabela**) e Negócios (**Quadro | Lista**). No celular só existe a lista/quadro de antes.
- **Colunas** escolhíveis (a primeira fica sempre), **ordenação** (clique no cabeçalho: crescente → decrescente → sem
  ordem; vazios por último; números naturais), **busca** sem acento, **filtros** por coluna (texto, número, dinheiro,
  data, lista, sim/não) que viram *chips* e se somam, **Mostrar mais** (50 por vez).
- **Visões** por lista, neste navegador: de fábrica (não se apagam) + as suas ("Salvar visão"; mesmo nome atualiza).
  Ao voltar para a tela a lista continua como estava, inclusive com filtros ainda não salvos.
  - Contatos: Todos · Meus · Sem responsável · Com negócio aberto · Sem negócio · Criados nos últimos 30 dias.
  - Negócios (por funil): **Em aberto** (padrão) · Todos · Meus em aberto · Fechando este mês · Parados há 7+ dias ·
    Sem tarefa em aberto · Ganhos · Perdidos.
- **Ações em massa nos Negócios** (marque as linhas): *Mover para etapa…* (etapa final pede confirmação; "Perdido"
  aceita motivo), *Mudar responsável…*, *Excluir* (confirmação). Cada negócio passa pelo motor: quem não pode algo fica
  de fora e o aviso conta "N movidos, M não puderam ser alterados".
- **Permissão**: campo oculto no perfil (telefone, e-mail, valor) **não vira coluna, filtro nem ordenação** — senão
  ordenar por valor revelaria a ordem dos números escondidos. Contato só aparece no negócio se o usuário o lê.
- Código: `public/js/lists/model.js` (puro, testado), `lists/table.js` (componente), `screens/contacts/table.js`,
  `screens/pipeline/list.js` + `bulk.js`.

## Onda 4 — Início
- **Fechando este mês**: negócios **em aberto** com previsão de fechamento no mês, do mais próximo ao mais distante, com
  total (se o perfil vê valores), contagem de vencidos e "Ver todos" (abre `#/pipeline?view=closing`: Negócios em lista
  já na visão certa, sem mudar a preferência salva).
- **Meta do mês** (receita): soma dos negócios **ganhos no mês** (data em que foram movidos para uma etapa de ganho)
  contra a meta, com %, quanto falta, dias restantes e se está **no ritmo** (ritmo linear do mês).
  - É a meta **da empresa**: só aparece para quem lê os negócios de **todo** o tenant e vê valores (Admin, Somente
    leitura…). Gestor/Atendente/SDR veem o "Fechando este mês" do que leem, mas não a meta.
  - **Quem define**: quem pode alterar as configurações da empresa (`tenant_settings.update`, o Admin). Valor em branco ou 0
    remove a meta. Fica em `tenants.settings.goals.monthlyRevenue`; `PATCH /api/tenant/goals`; entra na auditoria
    (`tenant.goals`). O bootstrap lê direto do banco, então a meta nova aparece na hora para todos.
- Espaço: telas largas ganham mais respiro e largura (Início em duas colunas a partir de 1080px).

## Testes
`test/api/lists-model.test.mjs`, `home-goals.test.mjs`, `search-model.test.mjs` (modelos puros) ·
`test/ui/lists-ui.test.mjs`, `lists-deals-ui.test.mjs`, `home-ui.test.mjs`, `deal-ui.test.mjs`, `shell-ui.test.mjs`
(telas em DOM simulado, com os perfis Admin, Gestor, SDR, Financeiro, Somente leitura e o de valor oculto) ·
`test/api/api.test.mjs` (meta do mês e atividade do negócio contra Postgres real).
