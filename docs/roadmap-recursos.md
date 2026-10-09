# TechTie Flow — recursos a adicionar e melhorar

Documento de planejamento (2026-10-09). Complementa os 14 passos de
implementação já enviados ao relatório diário: aqui está o **o quê** (recursos
e modelos), lá está o **em que ordem** (backend, canais, produto).

> **Referência Bitrix24.** Os recursos abaixo tomam como referência o que o
> Bitrix24 oferece em CRM, automação, permissões e telefonia, a partir do
> conhecimento geral do produto — **não foi consultada a documentação oficial
> nem o Bitrix do escritório**. Antes de fechar o escopo de cada item, validar
> contra a instância real (o que o time usa de fato, o que sobra, o que falta).
> Onde algo é hipótese, está marcado como **[verificar]**.

---

## 0. Pesquisas pendentes (decidem escopo — fazer antes de planejar o resto)

### 0.1 Baileys e ligações de WhatsApp — **PESQUISAR**

Precisamos pesquisar o que a biblioteca do Baileys (`@whiskeysockets/baileys`,
versão usada hoje: `^7.0.0-rc13`) permite em **chamadas de voz/vídeo do
WhatsApp**. Perguntas a responder, com fonte (código-fonte da lib, issues,
changelog), e não de memória:

1. A lib expõe o **evento de chamada recebida** (oferta, aceite, rejeição,
   timeout)? Qual o formato do payload e quais campos identificam o contato
   (JID/LID)?
2. Dá para **rejeitar** uma chamada programaticamente (ex.: responder
   automaticamente "não atendemos ligações por aqui, mande mensagem")?
3. Dá para **atender** ou **originar** uma chamada com áudio de verdade? Ou a
   lib só sinaliza a chamada e **não implementa o transporte de mídia**
   (WebRTC/SRTP)? Existe fork ou projeto que implemente?
4. Se for possível, qual a **qualidade, estabilidade e o risco de banimento**
   de usar chamadas por protocolo não-oficial? (Já sabemos que o Baileys tem
   risco de ban por si só — ver `docs/whatsapp-gateway-licoes-herdadas.md`;
   chamada automatizada tende a ser um padrão ainda mais monitorado.)
5. **Caminho oficial:** a Meta tem, para a Cloud API, uma API de **ligações do
   WhatsApp Business (Calling API)** **[verificar]** — com sinalização
   SIP/WebRTC, regras de consentimento do usuário para a empresa ligar,
   disponibilidade por país (Brasil?) e preço por minuto. Se existir e cobrir o
   Brasil, é provavelmente o único caminho sustentável para ligação por
   WhatsApp em produto comercial, e entra no `CloudApiChannel`, não no
   `BaileysChannel`.

**Resultado esperado da pesquisa:** uma tabela "o que dá para fazer por canal"
(Baileys × Cloud API × VoIP/SIP) e uma recomendação. Enquanto isso **não
prometer ligação por WhatsApp em material comercial**.

### 0.2 Bitrix24 como referência

Levantar, junto a quem usa o Bitrix hoje, quais recursos são usados no dia a dia
(funis, robôs, papéis de acesso, telefonia, tarefas, relatórios) e quais são
ignorados. Priorizar o que é usado.

---

## 1. Permissões e controle de acesso (prioridade máxima)

Por que primeiro: em SaaS multi-tenant, permissão errada = vazamento de dados de
cliente, e **adicionar permissões depois** exige refazer consultas, RLS e telas.
O modelo abaixo deve entrar já no desenho do banco (Passos 4 e 5 do plano).

### 1.1 Modelo

Uma permissão é a combinação **entidade × ação × escopo**.

| Eixo | Valores |
|---|---|
| **Entidades** | contato, empresa, negócio, conversa, proposta/produto, pipeline (configuração), automação, instância de WhatsApp, agente de IA, telefonia (chamadas e gravações), relatórios, configurações do tenant, usuários e permissões, faturamento, arquivos |
| **Ações** | ler, criar, editar, excluir, exportar, importar, transferir/reatribuir, enviar mensagem, nota interna, aprovar |
| **Escopo** | nenhum · só os próprios · da própria equipe · equipe e subequipes · todos do tenant |

No Bitrix o equivalente são os "papéis de acesso" do CRM, com escopo
próprio/departamento/subordinados/todos **[verificar granularidade exata]**.

### 1.2 Camadas além da matriz básica

- **Por pipeline:** quem enxerga e usa cada funil (ex.: SDR não vê "Comercial").
- **Por etapa:** quem pode **mover para** uma etapa (ex.: só Gestor move para
  "Fechamento"/"Perdido") e quem pode **editar** negócio em cada etapa.
- **Por instância de WhatsApp:** quem vê as conversas de cada número (o número
  do financeiro não deve aparecer para o comercial).
- **Por campo:** ocultar ou mascarar (valor do negócio, telefone, e-mail,
  documento) para certos perfis.
- **Regras com aprovação:** ex.: desconto acima de X% só é aplicado depois da
  aprovação de um Gestor (a tela de Agente de IA já fala em "desconto acima de
  5%" como gatilho de transbordo — mesma regra de negócio).
- **Hierarquia:** organograma de departamentos/equipes; é ele que define
  "subordinados" e "equipe e subequipes".

### 1.3 Perfis

- Padrão de fábrica: **Admin**, **Gestor**, **Atendente** (já na tela de
  Configurações), mais **SDR**, **Financeiro** e **Somente leitura**.
- Perfis **personalizados** por tenant (copiar de um existente e ajustar).
- Um usuário pode ter **mais de um perfil**. **Decisão a tomar:** permissões
  somam (o mais permissivo vence, como no Bitrix **[verificar]**) ou existe
  "negar explícito"? Recomendação: somar, e permitir "negar" só em casos
  críticos (ex.: exportar).
- **Dois níveis de admin separados:** administrador do **tenant** (cliente) e
  administrador da **plataforma** (TechTie). O da plataforma não acessa dados de
  tenant sem registro de acesso.

### 1.4 Segurança e auditoria

- **Aplicação no backend** (motor central de políticas) **e** no Postgres (RLS
  por `tenant_id` + escopo). A UI só esconde botões; nunca é a barreira.
- **Log de auditoria:** quem viu/alterou/exportou o quê e quando; acesso a
  gravações de chamada e a conversas de outros usuários.
- **"Entrar como" usuário** (suporte/gestor) com registro obrigatório.
- 2FA, SSO (Google/Microsoft), política de senha, lista de sessões ativas,
  revogação de sessão, lista de IPs permitidos (opcional).
- **LGPD:** consentimento, exportação e exclusão/anonimização de contato.

### 1.5 Tela (evolução de Configurações → Perfis de acesso)

- Matriz **entidade × ação** com seletor de escopo por perfil.
- **Simulador "ver como usuário X"** (mostra o que ele enxerga/consegue fazer).
- Convite de usuário com perfil e equipe; desativar sem apagar histórico.
- **Testes automatizados da matriz** (cada perfil × cada rota da API).

---

## 2. Pipelines e gestão de negócios

Hoje: kanban com arrastar-e-soltar, proposta com produtos, 3 pipelines fixos.

**Configuração de funil**
- Vários pipelines por tenant, criados e editados na interface (hoje só
  existem os do mock): etapas com nome, cor, ordem, **probabilidade** (para
  previsão de receita) e tipo (aberta / ganha / perdida).
- **Regras de entrada em etapa:** campos obrigatórios para avançar (ex.: valor e
  produto antes de "Proposta"), checklist de atividades, aprovação.
- **Tempo na etapa / SLA:** alerta de negócio parado ("estagnado há N dias"),
  cor do cartão por idade.
- **Motivos de perda** (lista configurável, obrigatório ao perder) e de ganho.
- Regras de movimentação automática (ex.: cliente respondeu → volta para
  "Qualificação").

**Dados do negócio**
- **Campos personalizados** por tenant e por pipeline (texto, número, data,
  lista, moeda, arquivo, usuário) — no Bitrix é um dos recursos mais usados
  **[verificar]**.
- **Contatos e empresas** separados (um negócio com vários contatos; empresa
  com vários negócios), **detecção e mescla de duplicados** (por telefone,
  e-mail, documento).
- **Atividades e tarefas** ligadas ao negócio (ligar, reunião, enviar
  proposta) com prazo e responsável, **calendário** e lembretes.
- **Histórico completo** (linha do tempo): mensagens, chamadas, mudanças de
  etapa, campos alterados, tarefas, arquivos, notas.
- **Produtos/catálogo** com tabela de preços, descontos (com a aprovação da
  seção 1.2), impostos e variações.
- **Propostas e orçamentos em PDF** com modelo da marca do tenant, versões,
  validade, aceite do cliente por link e **assinatura eletrônica**
  (integração) — hoje a proposta é só uma lista de itens.

**Visões**
- Kanban, **lista/tabela**, calendário e **previsão de receita**
  (valor × probabilidade por etapa e por mês).
- **Filtros salvos** e visões compartilhadas por equipe; busca global.
- **Ações em massa:** reatribuir, mover, adicionar tag, exportar.
- Importar/exportar CSV/Excel com mapeamento de campos.

**Distribuição de leads**
- Atribuição automática: rodízio, por carga (quem tem menos abertos), por
  habilidade/produto, por horário de trabalho e por origem.
- Regras de redistribuição se ninguém responder em N minutos.

---

## 3. Automações

Hoje: um canvas de nós (gatilho → condição → ação) editável, sem motor por trás.

**Dois modelos, como no Bitrix** **[verificar]**
- **Robôs por etapa** (simples, cobre a maioria): "ao entrar em Proposta, após
  2 dias sem resposta, enviar modelo X". Configurados dentro do próprio pipeline.
- **Fluxos no canvas** (complexos): ramificações, esperas, loops limitados,
  subfluxos. O canvas atual evolui para isso.

**Gatilhos:** mensagem recebida (por instância/palavra-chave), sem resposta em
N horas, negócio criado/movido/ganho/perdido, campo alterado, tarefa vencida,
formulário/webhook recebido, chamada recebida/perdida, horário agendado, data de
campo (aniversário, renovação).

**Ações:** enviar mensagem/modelo/mídia, aguardar (tempo ou evento), alterar
campo, mover etapa, criar tarefa/atividade, atribuir (com as regras de
distribuição), adicionar tag, notificar usuário, **chamar webhook/API externa**,
**IA** (classificar intenção, resumir conversa, sugerir resposta, extrair dados
para campos), criar proposta a partir de um modelo, **iniciar ligação**
(seção 5).

**Motor de execução (parte que o protótipo não tem)**
- Fila, **idempotência**, tentativas com recuo, tempo limite, execução por
  tenant isolada.
- **Limite de envio e variação de intervalo por instância** — obrigatório no
  Baileys por causa do risco de ban (`docs/whatsapp-gateway-licoes-herdadas.md`);
  no Cloud API, respeitar modelos aprovados e a janela de 24h.
- **Horário comercial e fuso** por tenant, feriados.
- **Log de execuções** por negócio (o que disparou, o que fez, erro),
  **modo de teste** sem enviar de verdade, **versionamento** e rascunho, pausar
  tudo com um botão, **limites anti-loop**.
- **Biblioteca de modelos** de automação prontos (boas-vindas, follow-up,
  reativação, cobrança, pesquisa de satisfação).
- Permissões próprias: quem cria, edita, publica e vê o log (seção 1).

---

## 4. Atendimento / contact center (Inbox)

- **Mais canais** (no Bitrix: Canais abertos): Instagram, Messenger, Telegram,
  e-mail, chat para site (widget), formulário. A interface `WhatsAppChannel`
  deve virar **`Channel`** genérico.
- **Filas e roteamento por equipe/horário**, fila de espera com ordem, **SLA**
  (primeira resposta, tempo de resolução) com alertas.
- **Respostas rápidas** com atalho `/` e variáveis ({nome}, {empresa}),
  **modelos aprovados da Meta** (Cloud API), anexos, áudio, localização, contato.
- **Chatbot/menu inicial** (triagem antes de cair no humano) ligado ao Agente de
  IA e às automações.
- Colaboração: **@menção** em nota interna, conversa com vários participantes,
  transferência com motivo, **supervisão** (gestor acompanha/entra na conversa).
- **Pesquisa de satisfação** (CSAT/NPS) ao resolver, tags de motivo de contato.
- **Campanhas / disparo em massa** — só com limites e consentimento; no Baileys
  é o maior gatilho de banimento, preferir Cloud API com modelos aprovados.
- **Resumo de conversa por IA**, tradução, detecção de intenção/sentimento.
- Notificações (som, push no navegador, e-mail), **PWA/mobile**.

---

## 5. Telefonia VoIP

Objetivo: atender e fazer ligações dentro do CRM, com a chamada registrada no
contato e no negócio — equivalente ao que o Bitrix chama de Telefonia.

### 5.1 Recursos (por ondas)

**Onda 1 — o essencial**
- **Softphone no navegador (WebRTC)**, sem instalar nada.
- **Clique para ligar** (a partir de contato, negócio, conversa).
- **Chamada recebida com pop-up do contato** (nome, empresa, negócio aberto,
  último atendimento) e criação automática de contato novo.
- **Registro na linha do tempo:** direção, duração, atendente, resultado
  (atendida, perdida, ocupado, não atendeu) e **atividade/tarefa de retorno**
  automática para chamadas perdidas.
- **Ramal por usuário**, histórico e filtros de chamadas.

**Onda 2 — operação**
- **Gravação** das chamadas, com aviso ao interlocutor (consentimento/LGPD) e
  **permissão específica para ouvir** (seção 1).
- **URA** (menu por tecla), **filas** de atendimento e **grupos de toque**
  (simultâneo, sequencial, por menos ocupado), **horário de atendimento** e
  caixa postal, transferência (cega e assistida), conferência, espera/mudo.
- **Métricas:** tempo de espera, de conversa, atendimento por agente, taxa de
  chamadas perdidas, ligações por dia no Dashboard.

**Onda 3 — inteligência e escala**
- **Transcrição + resumo por IA** da chamada, preenchimento automático de
  campos/atividade, detecção de intenção (casa com o Agente de IA).
- **Discador** (lista de contatos, ligação em sequência) para prospecção.
- **Número por equipe/pipeline** e identificador de chamada por campanha.
- Automação por chamada (seção 3): "chamada perdida → criar tarefa e mandar
  WhatsApp".

### 5.2 Arquitetura — decisão a tomar

Criar uma interface **`VoiceChannel`** (espelhando `WhatsAppChannel`) e ligar
provedores por trás dela. Opções:

| Opção | Como é | Prós | Contras |
|---|---|---|---|
| **A. Provedor de telefonia em nuvem** (CPaaS com API e SDK WebRTC) | API do provedor entrega números, SIP e WebRTC | Mais rápido; compra de número por API (encaixa em multi-tenant); sem operar servidor de voz | Custo por minuto; dependência de um fornecedor; cobertura/numeração no Brasil a avaliar |
| **B. Servidor próprio** (Asterisk/FreeSWITCH + troncos SIP) | Nós operamos a central | Custo por minuto menor; controle total | Operação, escala e segurança de VoIP por nossa conta; fraude de tarifação |
| **C. Trazer a própria central do cliente** (conectar PBX/tronco SIP existente) | O Bitrix também faz isso ("PBX própria"/SIP) **[verificar]** | Cliente aproveita o que já paga; zero custo de minuto para nós | Suporte a mil configurações diferentes |

**Recomendação inicial:** começar por **A com C como opção avançada**, sempre
atrás de `VoiceChannel`, e só considerar B se o volume justificar. Cliente
WebRTC no navegador com uma biblioteca SIP (JsSIP/SIP.js) ou o SDK do provedor.

**A avaliar nos provedores candidatos** (nenhum escolhido ainda): preço por
minuto e por número no Brasil, cobertura de numeração local/0800, portabilidade,
qualidade/latência a partir do Brasil, gravação e transcrição nativas, API
multi-tenant (subcontas), exigências regulatórias (Anatel) e de privacidade
(LGPD) para gravação.

### 5.3 Ligação por WhatsApp

Separada de VoIP: depende da **pesquisa 0.1**. Se existir caminho oficial (Calling
API da Meta no `CloudApiChannel`), ela entra no mesmo softphone e no mesmo
registro de chamadas, com um selo de canal "WhatsApp" × "Telefone".

---

## 6. Dashboard, relatórios e metas

- Relatórios por período, funil, origem do lead, motivo de perda, ciclo de
  venda, **tempo médio de primeira resposta**, ranking de atendentes, produtos
  mais vendidos, chamadas.
- **Construtor de relatórios** (escolher métrica, agrupamento e filtro) e
  exportação; **painéis por perfil** (gestor × atendente) — respeitando as
  permissões.
- **Metas** por vendedor/equipe/período e acompanhamento; **previsão** (seção 2).
- Relatório agendado por e-mail.

## 7. Plataforma, integrações e administração

- **API pública + chaves de API + webhooks de saída**, documentação; no Bitrix
  é o "REST" e o marketplace **[verificar]**. Base para integrações de clientes.
- **Integrações:** e-mail (Gmail/Outlook), Google Calendar, Omie (já citado no
  mock), pagamentos/boleto/Pix, assinatura eletrônica, importação de planilhas.
- **Tarefas e calendário** unificados (seção 2).
- **Arquivos e modelos de documento** com variáveis.
- **Multi-tenant e white-label:** domínio próprio (CNAME), marca, e-mails
  transacionais com a marca do tenant, **planos, limites de uso e cobrança**
  (usuários, instâncias, minutos de telefonia, mensagens da Cloud API, uso de IA).
- **Painel da plataforma (TechTie):** tenants, uso, suporte com "entrar como"
  auditado, status das instâncias de WhatsApp.
- **Observabilidade:** logs, métricas, alertas de instância caída/banida.
- **Internacionalização** (pt-BR primeiro, estrutura para outros idiomas),
  **acessibilidade**, atalhos de teclado, busca global (Ctrl+K).

---

## 8. Melhorias no protótipo atual

Pendências deixadas pela revisão (ver relatório do workflow):

- Promover para `base.css` os componentes **modal, popover e menu** (hoje cada
  tela tem o seu local), com `role="dialog"`, Esc e foco preso.
- Telas devem tolerar pipeline sem equipe, instância sem conversas e instância
  em estado `attention`/`queued`/`connecting` de forma uniforme.
- Dados do dashboard por período como séries próprias (hoje derivados de uma só).
- Rotas com parâmetros (`#/pipeline/d1`) para abrir direto num negócio.
- Teste de fumaça do front-end versionado (as 9 rotas × 2 temas).

---

## 9. Priorização sugerida

| Onda | Foco | Por quê |
|---|---|---|
| **1** | Modelo de **permissões** no banco e na API + pipelines configuráveis + campos personalizados + atividades/tarefas | É a base; refazer depois custa caro e é onde o risco de vazamento mora |
| **2** | **Motor de automações** (robôs por etapa primeiro) + distribuição de leads + filas/SLA + propostas em PDF | Dá o valor "CRM de verdade" e reduz trabalho manual |
| **3** | **Telefonia VoIP** onda 1 e 2 + relatórios/metas | Diferencial de contact center; depende da decisão A/B/C |
| **4** | Ligação por WhatsApp (conforme pesquisa), canais extras, API pública/marketplace, IA em chamadas | Depende de pesquisa e de aprovação externa (Meta) |

**Impacto no plano de 14 passos:** o **modelo de permissões (seção 1)** deve ser
desenhado dentro dos **Passos 4 e 5** (banco e autenticação), e não como passo
isolado no fim; telefonia vira um passo novo ("`VoiceChannel` + softphone") depois
do Passo 7; a **pesquisa 0.1** deve rodar já, em paralelo ao Passo 3, porque muda o
escopo do `CloudApiChannel` (Passo 8).
