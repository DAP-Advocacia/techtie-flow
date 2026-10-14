# Arquitetura e hospedagem do TechTie Flow

Planejamento (2026-10-13) para o cenário-alvo inicial: **4 tenants com 200 a 300
WhatsApps cada, ou seja, 800 a 1.200 sockets permanentes**. Os números de capacidade
são **hipóteses a medir** (marcadas como tal); preços e limites de provedores **não**
foram consultados e precisam ser cotados antes de decidir.

## 1. Quatro tipos de carga, quatro tipos de hospedagem

| Carga | Natureza | Hospedagem |
|---|---|---|
| Front-end (SPA) | arquivos estáticos | CDN: Vercel (hoje) ou Cloudflare Pages |
| API + tempo real | Node sem estado + WebSocket | contêineres atrás de balanceador (a Vercel não roda servidor WebSocket) |
| Gateway Baileys | sockets longos na memória, credenciais por sessão | contêineres de processo permanente; **não pode ser serverless** |
| Banco, mídia, fila | Postgres, objetos, Redis | serviços gerenciados |

O canal oficial (Cloud API da Meta) é só webhook + HTTP: não exige socket nem worker
dedicado, e cada número migrado para ele **sai da frota** do Baileys.

## 2. Dimensionamento (hipóteses)

- Gargalo: CPU de **um núcleo por processo Node** (event loop). Ponto de partida:
  **100 a 150 sessões por worker** ⇒ **8 a 12 workers** de 1 vCPU / 2 a 4 GB.
  *Como medir:* conectar ~20 contas reais, medir memória e CPU por sessão (ocioso,
  com tráfego e durante sync de histórico) e extrapolar com folga de 30%.
- Boot: o `SESSION_STAGGER_MS` herdado do DapZap é 15 s entre reconexões. Com 100 sessões
  por worker, **reiniciar um worker leva ~25 min** para voltar tudo. Consequência de
  projeto: deploy **um worker por vez, com drenagem**; nunca reiniciar a frota toda.
  Reavaliar o intervalo por tipo de reconexão (sessão já registrada × pareamento novo).
- Mensagens: 1.000 números × centenas de mensagens/dia ⇒ dezenas de milhões de linhas
  por ano. **Particionar `messages` por mês** (e índices começando por `tenant_id`).
- Mídia tende a ser o maior custo de armazenamento: política de retenção desde o início.

## 3. Arquitetura recomendada

```
            Cloudflare / Vercel (CDN, SPA, domínios de tenants via CNAME)
                              │
                     Balanceador (TLS)
                    ┌─────────┴─────────┐
              API (2+ instâncias)   WebSocket  ←── Redis (pub/sub, filas, limites)
                    │                                   │
                    └──────────────┬────────────────────┘
                                   │
        Workers WhatsApp (N shards)  ─── cada um dono de um conjunto de números
        (Baileys; Cloud API entra como outro canal, sem worker)
                                   │
        Postgres gerenciado (São Paulo, backup pontual, RLS)   Storage de objetos
```

- **Concessão de sessão:** tabela `session_leases` (sessão → worker, validade). O worker
  renova por batimento; se parar, outro assume, **escalonado**, respeitando a fila de
  pareamento e o teto de reconexão já documentados em
  `whatsapp-gateway-licoes-herdadas.md`.
- **Credenciais do Baileys no banco** (criptografadas com chave da aplicação, cache em
  memória), em vez de `AUTH_FOLDER` em disco. Sem isso, perder um servidor significa
  centenas de pessoas escaneando QR de novo, e uma sessão não pode mudar de worker.
- **Redis**: fila de pareamento (`MAX_CONCURRENT_PAIRINGS`), limite de envio das
  automações por número, pub/sub do WebSocket.
- Isolamento de tenant continua no Postgres (RLS, ver `permissoes-banco.md`); o worker
  abre cada transação com `set_config('app.tenant_id', …, true)`.

## 4. Onde hospedar

**Recomendação inicial:** workers em **3 servidores de ~8 vCPU / 16 GB no Brasil**, 3 a 4
contêineres de worker por servidor (Docker + Coolify/EasyPanel, ou ECS na AWS
`sa-east-1`). API em 2 contêineres pequenos. Banco gerenciado em São Paulo. Sem
Kubernetes nesta escala.

| Camada | Opção barata (você opera) | Opção robusta (mais cara) |
|---|---|---|
| Workers e API | VPS/servidores no Brasil + Coolify/EasyPanel | AWS `sa-east-1` (ECS) ou GCP `southamerica-east1` |
| Postgres | Supabase (São Paulo) com computador maior que o básico | RDS Multi-AZ / Cloud SQL |
| Redis | Upstash ou contêiner com persistência | ElastiCache / Memorystore |
| Mídia | Supabase Storage ou Cloudflare R2 | S3 + CloudFront |
| Domínio de cliente | Cloudflare for SaaS ou API de domínios da Vercel | idem |

**Decidir com cotações reais:** o computador do banco (o plano básico não aguenta este
volume), servidores no Brasil × AWS, e o custo de saída (egress) de mídia.

## 5. Riscos que mandam no projeto

1. **IP único:** 800 a 1.200 números saindo do mesmo IP de datacenter pode virar sinal
   de abuso para o WhatsApp. **Pesquisar** proxy por grupo de números ou por tenant (não
   verificado: comportamento real, custo e compatibilidade com o Baileys).
2. **Banimento em onda:** alerta imediato quando a taxa de desconexão passar de um
   limite; pausa automática de reconexão (já é regra: códigos permanentes não insistem).
3. **Deploy:** reinício em massa derruba a frota por horas; só rolling por worker.
4. **Residência de dados (LGPD):** banco, mídia e workers no Brasil; confirmar com cada
   tenant se exigem ISO 27001/SOC 2 e em que prazo.
5. **Perda de credenciais:** backup e restauração testados antes do primeiro cliente real.
6. **Observabilidade:** métricas por worker (sessões, memória, atraso do event loop),
   alerta de sessão caída e de fila de pareamento parada; logs sem dado de conversa.

## 6. Alavanca de custo e risco: Cloud API

Para tenants grandes, oferecer **migração gradual de números para a Cloud API oficial**:
tira sockets da frota (menos servidor, menos risco de ban), em troca de custo por
mensagem entregue e do processo de Tech Provider da Meta (ver `roadmap-recursos.md`).

## 7. Próximos passos (baratos, nesta ordem)

1. **Medir** memória e CPU por sessão com ~20 contas reais e extrapolar.
2. **Desenhar** `session_leases` e o armazenamento de credenciais no banco (ADR curto).
3. **Cotar** banco gerenciado e servidores nas duas opções da tabela.
4. **Pesquisar** proxy por grupo de números e o impacto no risco de ban.
5. Só então contratar infraestrutura e montar o primeiro worker de verdade.
