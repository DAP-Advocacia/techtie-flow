# Histórico e contexto do projeto

Como o TechTie Flow chegou até aqui: fases, decisões, incidentes e lições. A lista por commit está em [../CHANGELOG.md](../CHANGELOG.md).

## Contexto

A TechTie quer um **CRM + contact center white-label** com WhatsApp como canal nativo, vendido como SaaS multi-tenant. A origem técnica é
o **DapZap** (gateway WhatsApp/Baileys interno do escritório de advocacia, integrado ao Bitrix24 e rodando em produção). O TechTie Flow é um
**fork independente**: herda o gateway e as lições de produção (ban, fila de pareamento, reconexão), mas tem produto, banco e telas próprios.
A referência funcional é o **Bitrix24** (pipelines, automações, permissões, telefonia) e, no visual, o **Salesforce** (barra superior,
página do registro, listas em tabela), sempre com a identidade preto e dourado da TechTie.

## Fases

### 1. Protótipo e fundação (9–13/10)
- Protótipo navegável com as 9 telas do handoff de design (SPA sem build, dados fictícios).
- **Motor de permissões** isomórfico (`shared/permissions`), com suíte extensa (propriedades, matriz dourada, revisão adversarial) e
  **camada Postgres** com RLS em três camadas (migração 0001).
- Planejamento de hospedagem para 800–1.200 sockets de WhatsApp (workers, credenciais no banco, Redis) — ainda **não** implementado.

### 2. Piloto operando (14–19/10)
- **Modo operação**: banco real, login (scrypt + token), convite, API, WebSocket e WhatsApp pela Baileys, tudo no mesmo processo (0002).
- Números individuais × da empresa (0003); remoção real de número.
- Logo oficial, novo login (composição da prancha), versão para celular e **PWA**.
- **Deploy na VPS** (Hostinger + Coolify, Dockerfile único) e publicação em `crm.techtie.digital`.
- **CRM grava de verdade**, **Dashboard real** e **Agente de IA** com OpenAI (0004).

### 3. Redesenho "Salesforce" e produtividade (21–22/10)
- **Tarefas** (0005), barra superior com busca global (Ctrl+K), página do negócio com Path e atividade real (0006), **listas em tabela**
  com visões salvas e ações em massa, Início com "Fechando este mês" e meta de receita. Notas em [visual-salesforce.md](visual-salesforce.md).
- **Funis configuráveis** com probabilidade e motivos de perda (0007/0008).
- Modais com animação e sem botões escondidos no celular; brilhos e animações de clique sóbrios ("magia sem exagero").
- **Chat interno** e **Meu perfil** (0009).

### 4. Dados, qualidade e celular (23/10)
- **Importar/exportar CSV** com regras compartilhadas entre tela e servidor.
- **Auditoria de UX** (nota externa 6,5/10): corrigidos os pontos reais, descobertos três casos de **dado de demonstração vazando para
  a operação real** e unificados os campos de data/hora/contato. Ver [auditoria-ux-23-10.md](auditoria-ux-23-10.md).
- Correções visuais no celular (modal, etapas do negócio, botões).
- **Mascote de IA** registrado como objetivo (ainda sem desenho).

## Sequência de objetivos combinada (23/10)

| # | Objetivo | Situação |
|---|---|---|
| 1 | Funis configuráveis | feito |
| 2 | Importar e exportar CSV | feito |
| 3 | **Automações de verdade** (motor no servidor; robôs por etapa primeiro) | próximo |
| 4 | **Campos personalizados** (negócio e contato) | pendente |
| 5 | **Mascote de IA** (assistente dentro do produto; [roadmap §10](roadmap-recursos.md)) | a desenhar; faltam decisões de nome, personalidade, onde mora e fase inicial |

## Decisões que valem lembrar

- **Permissão no servidor e no banco**, nunca só na tela. O front só reflete (e explica o "por que não posso").
- **Um motor, dois lugares:** o mesmo código decide no navegador e no servidor; o filtro de lista e a decisão sobre um objeto nunca divergem.
- **Sem framework e sem build no front:** menos peças, deploy trivial, e dado de usuário nunca vira HTML (`h()`, sem `innerHTML`).
- **Contêiner único** no piloto; escalar é projeto separado (workers, credenciais no banco).
- **Baileys e Cloud API oficial lado a lado** (a oficial ainda não existe); risco de ban explicado ao cliente na própria tela.
- **Honestidade na interface:** o que ainda não funciona avisa (Automações) em vez de fingir; dado de demonstração não aparece em operação.
- **Visual sóbrio e fiel à marca**; animações discretas que respeitam "reduzir movimento".
- **Push não publica:** a produção só muda com *Redeploy* no Coolify. Migração nova é aplicada à parte com `node db/migrate.mjs`.

## Incidentes e lições

| Quando | O que aconteceu | Lição |
|---|---|---|
| 22/10 | Depois da migração 0007 todas as probabilidades de etapa ficaram em 0% | **RLS FORCE sem `app.tenant_id` esconde todas as linhas**: o `UPDATE` afetou 0. A 0008 refaz o backfill empresa por empresa (e há teste) |
| 22/10 | Filtro rápido "Meus" em Contatos retornava 0 | o contexto da tabela não tinha o usuário atual; `contactCtx()` passou a incluir `me` |
| 22/10 | Botões de criar tarefa sumiam atrás do teclado no celular | `100vh` não encolhe com o teclado; modais passaram a usar `--vvh/--vvt` (visualViewport) e linha de ações fixa |
| 22/10 | Teste de tela estourava a memória ao falhar | `assert.equal(elementoDom, null)` serializa o DOM; usar `assert.ok(!el)` |
| 23/10 | Telefone exportado como `'+55…` | a proteção contra fórmula em planilha prefixava qualquer `+`; passou a poupar número e telefone |
| 23/10 | "Domínio verificado" e "fluxos com 1,2 mil execuções" em produção | o estado inicial do navegador é o mock; `dropDemoData` zera o que o servidor não guarda |
| 23/10 | Modal de criação com vão à direita no celular | `width` inline vencia o CSS da folha de baixo; largura virou variável (`--modal-w`) |
| 23/10 | Etapas do negócio cortadas na altura no celular | cartão flexível encolhia dentro de coluna; `flex: none` |

## Ambiente e hábitos de trabalho

- Desenvolvimento em Windows; scripts de edição com muitas aspas ou barras funcionam melhor como arquivos (Python em `.claude/tmp/`) do que
  em *heredoc* no shell.
- A pasta local `imagens 8-10/` (capturas) **não é versionada**; não adicione ao Git.
- Há um relatório diário de TI (servidor local em `localhost:4477`) que recebe um resumo detalhado após cada commit/deploy — fora do repositório.
- Verificação por linha de comando e testes de DOM simulado; conferência visual no navegador fica para depois do Redeploy.
