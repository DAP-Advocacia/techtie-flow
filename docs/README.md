# Documentação do TechTie Flow

Índice de tudo que está em `docs/`. Comece pelo [README da raiz](../README.md) (visão e status) e pelo
[CHANGELOG](../CHANGELOG.md).

## Para entender o projeto

| Documento | O que tem |
|---|---|
| [historico.md](historico.md) | contexto, fases, sequência de objetivos, decisões, incidentes e lições |
| [arquitetura.md](arquitetura.md) | como as peças se encaixam hoje: modos, processo, multi-tenant, permissões, tempo real, WhatsApp, IA |
| [frontend.md](frontend.md) | SPA sem build: roteador, store, modo operação, componentes, CSS, celular, efeitos, convenções |
| [banco.md](banco.md) | papéis, migrações 0001–0009, isolamento por RLS, armadilhas, como adicionar tabela |
| [api.md](api.md) | rotas, permissões, erros, auditoria e eventos de tempo real |
| [configuracao.md](configuracao.md) | todas as variáveis de ambiente |
| [testes.md](testes.md) | estratégia, o que cada pasta cobre, Docker, DOM simulado, CI |

## Permissões

| Documento | O que tem |
|---|---|
| [permissoes.md](permissoes.md) | contrato do motor (entidade × ação × alcance), decisões, perfis de fábrica, revisão de segurança |
| [permissoes-banco.md](permissoes-banco.md) | camada Postgres: RLS em três camadas, papéis, testes diferenciais |

## Funcionalidades

| Documento | O que tem |
|---|---|
| [funis.md](funis.md) | funis configuráveis, probabilidade, motivos de perda, previsão ponderada |
| [csv.md](csv.md) | exportar e importar CSV (regras, limites, segurança) |
| [tarefas.md](tarefas.md) | tarefas individuais, compartilháveis e delegáveis |
| [chat-e-perfil.md](chat-e-perfil.md) | chat interno e Meu perfil |
| [ia.md](ia.md) | Agente de IA: quando responde, base de conhecimento, custo |
| [visual-salesforce.md](visual-salesforce.md) | ondas de redesenho visual e ajustes de uso |
| [auditoria-ux-23-10.md](auditoria-ux-23-10.md) | auditoria externa de UX: o que era real, o que foi feito, o que falta |

## Operação e infraestrutura

| Documento | O que tem |
|---|---|
| [piloto.md](piloto.md) | colocar para operar (banco, login, WhatsApp), roteiro de teste, números pessoais × da empresa |
| [deploy-vps.md](deploy-vps.md) | publicar na VPS (Hostinger + Coolify), checklist, operação |
| [arquitetura-hospedagem.md](arquitetura-hospedagem.md) | planejamento para 800–1.200 WhatsApps (workers, banco, Redis) — **ainda não implementado** |
| [whatsapp-gateway-licoes-herdadas.md](whatsapp-gateway-licoes-herdadas.md) | lições do DapZap: risco de ban, fila de pareamento, reconexão |

## Planejamento

| Documento | O que tem |
|---|---|
| [roadmap-recursos.md](roadmap-recursos.md) | recursos a construir (referência Bitrix24), pesquisas pendentes, priorização, **mascote de IA (§10)** |
| [design-handoff/](design-handoff/README.md) | handoff de design original (telas, tokens, entidades) |

## Manter a documentação em dia

- Mudou comportamento de uma funcionalidade? Atualize o documento dela **no mesmo commit**.
- Migração nova: [banco.md](banco.md) (tabela de migrações) e os carregadores de teste ([testes.md](testes.md)).
- Rota nova: [api.md](api.md). Variável nova: [configuracao.md](configuracao.md) e `.env.example`.
- Todo commit relevante entra no [CHANGELOG](../CHANGELOG.md); decisões e incidentes, em [historico.md](historico.md).
- O andamento da sequência de objetivos fica em [roadmap-recursos.md](roadmap-recursos.md) (tabela "Andamento").
