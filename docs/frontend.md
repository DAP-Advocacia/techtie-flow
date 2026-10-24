# Front-end

SPA **sem build e sem framework**: módulos ES nativos servidos como estão por `src/server.js` (ou copiados por
`scripts/build-static.mjs` para o site estático). Vanilla JS, `h()` para criar elementos, **nenhum `innerHTML`** (texto vira nó de
texto: dado de usuário nunca vira HTML). Telas em português do Brasil.

## Peças centrais (`public/js/`)

| Arquivo | Papel |
|---|---|
| `app.js` | shell (menu lateral, barra superior, abas do celular) + roteador por hash + tabela de rotas (`ROUTES`: id, rótulo, `require: [entidade, ação]`, `admin`, `desktopOnly`) |
| `router.js` | `hashParts()`, `hashParam()`, `linkTo(id, params)` — rotas `#/id?param=…` (mudar o hash remonta a tela) |
| `store.js` | estado único em memória + `subscribe`. Telas **leem** `store.state`, **escrevem** só por `store.update(fn)` |
| `access.js` | ponte store → motor de permissões (`canAccess`, `visible(entidade, lista)`, `decide…`, `audit`), com cache descartado a cada mudança do store |
| `live.js` | **modo operação**: `enabled` (vem de `window.__TTF__.live`), `request()` (API com token), `hydrate()` (bootstrap), funções de escrita com otimismo + sincronização, WebSocket com reconexão |
| `live-state.js` | funções **puras** que aplicam respostas da API ao estado (`applyBootstrap`, `mergeConversation`, `dropDemoData`…) — testadas em Node |
| `mock/data.js` | dados fictícios do modo demonstração (fonte única das telas no protótipo) |
| `ui.js` | `h()`, `icon()`, `replaceChildren()`, `toast()`, `toggle()`, formatadores (`fmtBRL`, `fmtInt`…), `avatar()` |
| `css.js` | `ensureScreenCss(id)`: CSS de tela sob demanda (painéis que abrem em outras telas pedem o CSS aqui) |
| `viewport.js` | grava `--vvh`/`--vvt` (área REAL visível; teclado e barras do celular) para modais e gavetas |
| `fx.js` | detalhes de movimento (ver abaixo) |
| `mobile.js`, `pwa.js` | ponto de corte do celular (820 px) e instalação do app (service worker em `public/sw.js`, rede primeiro, nunca guarda API/WS/mídia) |

### Modo demonstração × operação
Com `window.__TTF__.live === false` tudo roda sobre `mock/data.js` e `store.update`. Com `live === true` o login é real, o `hydrate()`
carrega o bootstrap e as ações chamam a API (otimista na tela, com desfazer se o servidor recusar). Em operação,
`dropDemoData` (em `live-state.js`) **zera no primeiro carregamento** o que o mock traria e o servidor ainda não guarda (marca/domínio,
conversa de teste da IA, fluxos de automação, auditoria local), para não aparecer dado inventado como se fosse da empresa.

## Telas (`public/js/screens/`)

Cada tela é um módulo `export default { mount(el, ctx) }` que devolve uma função de limpeza, com CSS opcional em
`public/css/screens/<id>.css` carregado pela rota. Telas grandes viram pasta (`pipeline/`, `contacts/`, `inbox/`, `permissions/`…) com
módulos pequenos: **modelo puro** (`model.js`, sem DOM, testável em Node), **ações** (`actions.js`, protótipo × operação) e a tela.

| Rota | Tela | Observações |
|---|---|---|
| `#/home` | Início | "Para hoje", "Fechando este mês" (ponderado), meta de receita, respostas pendentes |
| `#/inbox` | Inbox | alterna **Atendimento** (WhatsApp) e **Chat interno** (`?view=chat`) |
| `#/pipeline` | Negócios | seletor de funil (lista suspensa), **Quadro** (painel da proposta recolhível) e **Lista** (tabela); `?view=` abre numa visão |
| `#/deal?id=` | Negócio | destaque, Path de etapas, abas Detalhes/Proposta/Relacionados, atividade |
| `#/contacts` | Contatos | lista + ficha ou tabela; importar/exportar CSV |
| `#/tasks` | Tarefas | grupos por prazo, quadro, painel lateral, criação rápida |
| `#/agent` | Agente de IA | personalidade, regras, base de conhecimento, teste |
| `#/automations` | Automações | editor visual (em operação: aviso de que o motor de execução ainda não existe) |
| `#/dashboard` | Dashboard | KPIs com definição, barras, funil, equipe |
| `#/instances` | Instâncias | números de WhatsApp, QR, explicação do tipo de conexão |
| `#/funnels` | Funis | etapas, probabilidade, motivos de perda |
| `#/users`, `#/permissions`, `#/settings` | Administração | usuários e convites, perfis/matriz/simulador/auditoria, marca/equipes/perfis |
| `#/profile` | Meu perfil | nome, cargo, telefone, sobre |
| `#/login`, `#/accept`, `#/onboarding` | Entrada | login, convite, onboarding |

Telas densas marcadas `desktopOnly` (Automações, Funis, Usuários, Configurações, Permissões) mostram um aviso no celular.

## Componentes compartilhados

- **Listas em tabela** (`lists/`): `model.js` (filtros, ordenação, visões salvas — puro), `table.js` (`createTable`: colunas, filtros,
  visões, ações em massa, exportar CSV, lembrança de estado por sessão), `csv.js` (ler/escrever CSV, decodificar Windows-1252).
- **Campos pt-BR** (`fields/`): `dateField` (dd/mm/aaaa com máscara e calendário; valor ISO), `timeField` (24 h), `contactField`
  (busca por nome/empresa/telefone/e-mail, 40 por vez, teclado). São elementos com `.value`, `.disabled` e evento `change`, no lugar
  de `<input type=date|time>` (que seguem o idioma do **navegador**) e de `<select>` com centenas de contatos. Lógica pura em
  `fields/model.js`.
- **Importação CSV** (`screens/import/`): `wizard.js` (4 passos), `actions.js` (permissões, chamadas), regras em `shared/import/rules.js`.
- **Busca global** (`search/`, Ctrl+K), **menu/topbar/Novo** (`shell/`).
- **Permissões na tela** (`screens/_ops/perm.js`, `screens/*/perm.js`): `check`, `blocked`, `createHints` — controles desabilitados com o
  motivo ("por que não posso?").

## CSS

- `css/tokens.css`: tokens (tema escuro padrão, claro por `data-theme="light"`): `--bg --card --side --line --text --mute --dim
  --acc --acc2 --red --green --radius-*`. `css/base.css`: componentes comuns (`.btn`, `.input`, `.select`, `.field`, `.card`,
  campos pt-BR, esqueleto, toast, overlays). `css/shell.css`: casca. `css/screens/<tela>.css`: o que é específico.
- **Celular:** ponto de corte único **820 px** (`@media (max-width: 820px)`), idêntico a `MOBILE_QUERY`. Modais viram **folha de baixo**
  (`place-items: end stretch`, `width: 100%`) e medem por `--vvh/--vvt` (nunca `100vh`), com linha de ações fixa embaixo
  (botões nunca ficam atrás do teclado). Largura de modal vai por variável (`--modal-w`), **nunca `width` inline**, senão vence o CSS do celular.
- Animações: `@keyframes ov-fade/ov-pop/ov-sheet/ov-drawer` (modais, gavetas), `.fx-in` (entrada escalonada de tela por ~900 ms),
  esqueleto com brilho, anel de carregamento, toast com estrela. **Tudo some com `prefers-reduced-motion`.**
- Visual: preto e dourado da marca, sóbrio; evitar "cara de IA genérica". Notas de design em [visual-salesforce.md](visual-salesforce.md).

## Efeitos (`fx.js`)

Ondinha dourada no `pointerdown` de `.btn, .pill, .contacts-chip, .stage-chip, .home-tile, .home-stat, .picker__btn`; `burst` e
`burstOnce` (chuva curta de estrelinhas em conquistas: negócio ganho, tarefa concluída, meta batida, criar negócio/contato); `busy`
(anel de carregamento em botões); `sparkles` (login). Só decora: nada depende disso.

## Convenções para mexer

1. Telas leem `store.state` e escrevem por `store.update`; em operação, ações vão por `live.js` (protótipo e operação usam a mesma tela).
2. Regra de negócio **pura** vai em `model.js` e ganha teste em Node; a tela só monta DOM.
3. Nada de `innerHTML`. Strings viram texto.
4. Permissão: esconda/desabilite **com o motivo**, mas lembre que o servidor decide de verdade.
5. Novo CSS de tela em `css/screens/<id>.css` e `ensureScreenCss` se abrir em outra tela.
6. Mobile: teste a 820 px; modais e painéis seguem o padrão de folha de baixo; use `--vvh`.
7. Campo de data/hora/contato: use `fields/`, não o nativo.
8. Testes de tela rodam num DOM simulado (ver [testes.md](testes.md)); eles **não medem layout** — olhe no navegador.
