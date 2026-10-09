# Handoff: TechTie Flow (CRM + Contact Center)

## Overview
Protótipo de layout do **TechTie Flow**, versão white-label (fora do Bitrix24) do DapZap, expandida para um CRM completo. Serve como direção visual e de produto para o backend: 8 telas, entidades (contatos, negócios, pipelines, produtos/propostas) e fluxos.

## About the Design Files
`TechTie Flow.dc.html` é uma **referência de design em HTML** (protótipo com dados fictícios), não código de produção. Recrie no ambiente do projeto (`whatsapp-crm-gatway/public/*.html` + CSS compartilhado, ou o framework que você escolher para a nova arquitetura), usando os padrões do repo. Não publique o HTML direto.

## Fidelity
**Hi-fi** em cores, tipografia e layout. Textos e números são exemplos.

## Design Tokens
Dois temas via CSS variables (nomes sugeridos; o protótipo usa exatamente estes):

| Var | Escuro | Claro | Uso |
|---|---|---|---|
| --bg | #1b1d21 | #f1efeb | fundo da página |
| --side | #141619 | #e9e6e0 | sidebar |
| --card | #24272c | #fbfaf8 | cartões/painéis |
| --card2 | #2c3036 | #f4f2ee | superfície secundária |
| --bub | #2f333a | #e9e6e0 | bolha recebida |
| --line | #3a3e46 | #dcd8cf | bordas, aba ativa |
| --glow | #2d3036 | #e8e2d3 | gradientes (login, KPI) |
| --out / --outline | #3b4048 / #5a5f69 | #e8dfc8 / #cdbf9c | bolha enviada |
| --acc | #d6c093 | #8a6d2f | dourado champagne: rótulos, títulos, bordas finas |
| --acc2 | #ead9b0 | #6f5622 | dourado hover/ênfase |
| --dim | #8b7a55 | #b9a572 | bordas douradas discretas |
| --bar | #6f6850 | #c4ad74 | barras de gráfico |
| --mute | #a3a8b0 | #6a6f77 | texto secundário |
| --text | #f3ede2 | #25272b | texto principal |
| --fill / --fillh / --ink | #e4d6b8 / #f0e4c8 / #1b1d21 | #2a2c30 / #3d4045 / #f6f1e4 | botão primário (fundo/hover/texto) |
| --green / --red / --ins | #6fbf8b / #e08a82 / #8bb4dd | #2f8f58 / #c0504a / #3f78b0 | sucesso / erro / sugestão de IA |
| --sh / --hi | rgba(0,0,0,.28) / rgba(255,255,255,.05) | rgba(40,30,10,.10) / rgba(255,255,255,.7) | sombra / brilho de topo dos cartões |

**Regra de uso:** dourado só em detalhes (rótulos em caixa-alta, títulos de seção, bordas finas, valores-chave). Nada de grandes áreas douradas. Botão primário é o único preenchimento.
**Semântica de cor (herdada do DapZap):** champagne = nota interna humana; azul (--ins) = sugestão de IA; verde/vermelho = métrica positiva/negativa.
- Tipografia: **Plus Jakarta Sans** 300–700. Títulos de página 27px/600 caixa-alta, letter-spacing .04em; rótulos 11px, letter-spacing .2em, caixa-alta; corpo 14px.
- Raios: cartões 14px, botões/abas em pílula (999px), inputs 10px, bolhas 14px (canto 4px do lado do autor). KPIs com cantos chanfrados de 16px (clip-path).
- Sombra de cartão: `0 10px 28px var(--sh), inset 0 1px 0 var(--hi)`.
- Sidebar 232px; item ativo = pílula --line com texto --acc2.

## Screens / Views
Shell: sidebar (marca, 7 itens, alternar tema, usuário) + área principal.
1. **Login** — 2 colunas: hero (marca, "ATENDA, VENDA E AUTOMATIZE TUDO NO MESMO LUGAR.") + formulário (e-mail, senha, Entrar, Criar conta da empresa).
2. **Onboarding** — 3 passos (Empresa, WhatsApp, Pipeline); passo 2: nome da instância + QR Code (pareamento Baileys).
3. **Inbox** — 3 colunas: lista (300px; abas Meus/Fila/Todos; avatar, última msg, não lidas, etapa do negócio) · thread (cabeçalho com instância, Transferir, Resolver; bolhas recebida/enviada, nota interna tracejada, sugestão de IA com "Usar resposta"/"Virar follow-up"; composer com abas Responder/Nota interna/Modelos) · painel do contato (dados, tags, negócio, linha do tempo). Largura mínima ~1020px (rola na horizontal abaixo disso).
4. **Negócios (Pipelines)** — seletor de pipeline por equipe (Vendas·SDR, Comercial, Pós-venda); colunas de 268px com total por etapa; cartão com título, empresa, valor, responsável, idade, última msg do WhatsApp; drag-and-drop a implementar. Painel direito 340px: **proposta** do negócio selecionado (itens, qtd, preço, total, "Enviar proposta (WhatsApp)").
5. **Agente de IA** — toggle por instância, prompt/personalidade, base de conhecimento (docs com status), regras de transbordo, chat de teste.
6. **Dashboard** — filtro de período; 4 KPIs; conversas por dia; funil; tabela de desempenho da equipe (inclui o Agente de IA como linha).
7. **Instâncias** — cartões por número (status, conversas, msgs hoje, IA ativa, Gerenciar/Reconectar) + "Conectar novo número".
8. **Automações** — lista de fluxos + canvas (Gatilho → Condição → Ação → Ação) com nós de 220px e conectores.
9. **Configurações (white-label)** — nome do produto, domínio, cor de destaque, logo, equipes↔pipelines, perfis de acesso (Admin/Gestor/Atendente).

## Interactions & Behavior
- Sidebar troca de tela; "Ver login / onboarding" volta ao fluxo de entrada.
- Inbox: clicar numa conversa troca thread e painel. Pipeline: abas trocam de pipeline; clicar num cartão seleciona e mostra a proposta (só os negócios d1 e d3 têm itens no mock).
- Alternar tema: aplica as variáveis do tema claro em `:root` (remove para voltar ao escuro). Persistir a escolha por usuário.
- Estados de loading/erro e validação de formulário **não** foram desenhados.

## State Management (sugestão para o backend)
Entidades: `contacts`, `companies?`, `deals` (pipeline_id, stage_id, owner, value, contact_id), `pipelines` → `stages`, `teams` (↔ pipelines), `products`, `deal_items` (proposta), `conversations`/`messages` (tipos: in, out, note, ai_insight), `instances`, `agent_config` + `knowledge_docs`, `automations` (trigger/conditions/actions), `brand_settings` por tenant (nome, domínio, cor, logo), `roles`. Multi-tenant desde o início (substitui o `ownerId` do Bitrix). Tempo real via WebSocket (já existe no gateway).

## Assets
Sem imagens. Ícones: SVGs de traço simples inline (24px, stroke 1.7). Logo é o placeholder "T"; **substituir pelo logo real da TechTie** (gravata dourada do site institucional).

## Files
- `TechTie Flow.dc.html` — protótipo completo (template + estado + dados de exemplo no final do arquivo, em `renderVals`).
