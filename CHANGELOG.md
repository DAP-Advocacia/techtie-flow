# Histórico de mudanças

Formato: por data, do mais novo ao mais antigo; o hash é o commit na `main`. Contexto e decisões por trás de cada fase em
[docs/historico.md](docs/historico.md). Migrações de banco aparecem com o número (aplicadas em `db/migrations/`).

## 2026-10-23

- `496a03f` **Celular:** modal de Negócios com largura total (a largura inline vencia o CSS e deixava vão à direita; agora `--modal-w`);
  cartão das etapas (Path) não encolhe e rola até a etapa atual; botões Ganho/Perdido/Editar/Excluir em grade 2×2; lista de busca de
  contato abre empurrando o formulário.
- `5a24744` **Auditoria de UX:** tempo de 1ª resposta com **mediana** e duração legível (`2h 05min`, `6d 19h`); dados de demonstração
  (domínio "verificado", conversa de teste da IA, fluxos, auditoria) não aparecem mais em operação real (`dropDemoData`); campos de data
  `dd/mm/aaaa` e hora de 24 h; **busca de contato** em Novo negócio e tarefa; explicação do tipo de conexão do WhatsApp; painel do Kanban
  recolhível; definição dos indicadores do Dashboard; aviso honesto nas Automações. Ver [docs/auditoria-ux-23-10.md](docs/auditoria-ux-23-10.md).
- `260a1ef` **CSV:** exportar a lista filtrada (Contatos e Negócios) e importar contatos e negócios com assistente em 4 passos; regras
  compartilhadas tela/servidor (`shared/import/rules.js`); **mascote de IA** registrado como objetivo 5 no roadmap. [docs/csv.md](docs/csv.md).

## 2026-10-22

- `57309e5` Mais magia sem exagero: entrada de tela escalonada, esqueletos com brilho, anel de carregamento, avisos e estrelinhas.
- `e140139` **Chat interno** na aba Inbox (alterna com o Atendimento) e **Meu perfil** — migração **0009**. [docs/chat-e-perfil.md](docs/chat-e-perfil.md).
- `29444e1` Brilhos e animações de clique: ondinha dourada, brilho no botão principal, IA piscando, chuva de brilhos nas conquistas.
- `36c6ceb` Funil em **lista suspensa**, Contatos melhor e modais com animação e sem botões escondidos atrás do teclado no celular.
- `f062c43` Migração **0008**: preenche a probabilidade dos funis antigos (a RLS FORCE escondia as linhas na 0007).
- `472982d` **Funis configuráveis pela tela:** etapas, probabilidade, motivos de perda e previsão ponderada — migração **0007**. [docs/funis.md](docs/funis.md).
- `b52f78b` Visual onda 4: Início com "Fechando este mês" e meta de receita do mês; mais respiro nas telas largas.
- `edca8ce` Visual onda 3: **listas em tabela** (Contatos e Negócios) com colunas, filtros, visões salvas e ações em massa.
- `475837f` Visual onda 2: **página do negócio** (Path, destaque, abas), atividade real e previsão de fechamento — migração **0006**.

## 2026-10-21

- `d19d087` Testes de tela esperam a condição (não tempo fixo): sem falha intermitente com a máquina carregada.
- `9ff916f` Visual onda 1: barra superior, **busca global** (Ctrl+K), "+ Novo", avisos e menu recolhível.
- `7d4a0a4` **Tarefas** (individual, compartilhável e delegável) + testes de tela em DOM simulado — migração **0005**. [docs/tarefas.md](docs/tarefas.md).

## 2026-10-19

- `6703175` Convite: o link usa o endereço do próprio site (um `APP_URL` velho não gera mais link quebrado).

## 2026-10-16

- `7db5ebc` **CRM grava de verdade + Dashboard real + Agente de IA com OpenAI** — migração **0004**. [docs/ia.md](docs/ia.md).
- `8029681` Login: composição da prancha (logo grande + fio dourado + formulário), preto limpo e correção do autofill.
- `b6d6bce` Mobile focado (Início, Inbox, Negócios, Contatos, Dashboard, IA) + novo login.
- `5b2db4e` Versão para celular + app instalável (**PWA**).
- `5fd3603` **Deploy na VPS (Coolify):** healthcheck, `.dockerignore` enxuto e guia passo a passo. [docs/deploy-vps.md](docs/deploy-vps.md).

## 2026-10-14

- `53f1978` Logo oficial TechTie no login, barra lateral e favicon.
- `7e2a1e7` **Números individuais**, remoção real de número, permissões simples e novo login — migração **0003**.
- `f9adb87` **Modo operação do piloto:** banco real, login, API, WhatsApp (Baileys) e front conectado — migração **0002**. [docs/piloto.md](docs/piloto.md).

## 2026-10-09

- `c2216e4` **Protótipo navegável** do TechTie Flow (9 telas, dados fictícios), **motor de permissões** e camada de banco com RLS — migração **0001**.

## Marcos fora do código

- 2026-10-13: planejamento de hospedagem e dimensionamento para 800–1.200 WhatsApps ([docs/arquitetura-hospedagem.md](docs/arquitetura-hospedagem.md)).
- 2026-10-16: primeira publicação em `https://crm.techtie.digital` (Coolify + Supabase).
- 2026-10-22: migrações 0007, 0008 e 0009 aplicadas no Supabase do piloto.
- 2026-10-24: documentação do projeto reescrita por completo (esta revisão) e CI passa a rodar a suíte de testes.
