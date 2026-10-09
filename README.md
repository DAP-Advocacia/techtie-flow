# TechTie Flow

CRM + Contact Center white-label, com WhatsApp como canal nativo de
atendimento. Produto comercial (SaaS multi-tenant) — não confundir com o
DapZap, que é o produto interno usado hoje pelo escritório de advocacia e
roda só integrado ao Bitrix24.

Este repositório nasceu como fork de `whatsapp-crm-gatway` (DapZap),
aproveitando a base madura de conexão WhatsApp via Baileys (ver
[docs/whatsapp-gateway-licoes-herdadas.md](docs/whatsapp-gateway-licoes-herdadas.md)
para o que já foi testado/corrigido em produção). A partir daqui os dois
projetos evoluem de forma independente — nenhuma correção em um se propaga
automaticamente para o outro.

## Status

Fase de **protótipo navegável**. As 9 telas do handoff de design existem como
SPA sem build (`public/`), rodando 100% com dados fictícios em memória — ainda
não há backend do CRM, auth nem integração real com WhatsApp/Supabase. O núcleo
herdado de conexão WhatsApp (`src/sessions.js`, `src/whatsapp.js`) segue
intocado e ainda não está ligado ao servidor.

## Rodando o protótipo

```bash
npm start        # http://localhost:3333  (PORT para mudar)
npm run dev      # idem, reinicia ao editar src/
```

Sem dependências para o protótipo (o `src/server.js` só serve `public/`).
Rotas por hash: `#/login`, `#/onboarding`, `#/inbox`, `#/pipeline`, `#/agent`,
`#/automations`, `#/dashboard`, `#/instances`, `#/settings`.

### Estrutura do front-end

- `public/js/app.js` — shell (sidebar) + roteador por hash. Cada tela é um
  módulo `public/js/screens/<id>.js` com `export default { mount(el, ctx) }`
  (devolve uma função de limpeza) e CSS opcional em `public/css/screens/<id>.css`.
- `public/js/store.js` — estado único + `subscribe`. Quando existir backend,
  só este módulo (e `mock/data.js`) troca de implementação.
- `public/js/mock/data.js` — dados fictícios, fonte única para todas as telas.
- `public/js/ui.js` — helpers (`h()`, ícones, formatadores). Sem `innerHTML`.
- `public/css/tokens.css` — tokens do handoff (tema escuro padrão, claro via
  `data-theme="light"`); `base.css` — componentes compartilhados.

## Decisões de produto já fechadas

- **Multi-tenant com código único** (não um deploy/domínio por cliente).
  Isolamento por `tenant_id` nas tabelas (Postgres/Supabase, com RLS),
  whitelabel via subdomínio ou domínio customizado (CNAME) — não via
  instância física separada.
- **Canal de WhatsApp: Baileys e Cloud API oficial lado a lado**, não um só.
  - Baileys: gratuito, setup via QR Code, risco de ban real (número do
    cliente, não da TechTie — precisa estar claro em contrato/ToS).
  - WhatsApp Cloud API (Meta): sem risco de ban, setup via Embedded Signup
    (login com a conta Meta Business do cliente), custo por mensagem
    entregue, exige a TechTie virar Tech Provider/Solution Partner da Meta.
  - Implicação de arquitetura: `whatsapp.js` deve virar uma interface de
    canal (`WhatsAppChannel`) com dois backends (`BaileysChannel`,
    `CloudApiChannel`), não uma classe única acoplada ao Baileys.
- **Fork independente do gateway** (não pacote compartilhado com o DapZap,
  por ora) — reavaliar quando o código estabilizar.

## Docs

- [docs/design-handoff/README.md](docs/design-handoff/README.md) — handoff
  de design (telas, tokens visuais, entidades sugeridas, 8-9 telas do
  protótipo).
- [docs/permissoes.md](docs/permissoes.md) — modelo de permissões (motor em
  `shared/permissions/`, testes em `test/`), decisões e revisão de segurança;
  [docs/permissoes-banco.md](docs/permissoes-banco.md) — camada Postgres (RLS).
- [docs/roadmap-recursos.md](docs/roadmap-recursos.md) — recursos a
  adicionar (permissões, pipelines, automações, telefonia VoIP, etc.), com o
  Bitrix24 como referência, e as pesquisas pendentes (ligação por WhatsApp
  via Baileys / Cloud API).
- [docs/whatsapp-gateway-licoes-herdadas.md](docs/whatsapp-gateway-licoes-herdadas.md) —
  lições de produção herdadas do DapZap sobre o gateway Baileys (risco de
  ban, fila de pareamento, reconexão).

## Licença

Ver [LICENSE](LICENSE) — herdada do projeto de origem, revisar antes de
qualquer distribuição/venda comercial.
