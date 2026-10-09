# Modelo de permissões do TechTie Flow

Decisão de arquitetura (ADR) + guia de uso. Código em
[`shared/permissions/`](../shared/permissions/), testes em
[`test/permissions/`](../test/permissions/) e
[`test/permissions-sql/`](../test/permissions-sql/), camada de banco em
[permissoes-banco.md](permissoes-banco.md).

Público-alvo: empresas com CNPJ consolidado (auditoria de segurança, LGPD,
segregação de funções, equipes grandes). Por isso o modelo foi desenhado para
**errar para o lado seguro**, ser **explicável** ("por que não posso?") e
**auditável**, e para **crescer sem reescrita**.

---

## 1. Princípios (o contrato de segurança)

1. **Permissões somam.** O usuário pode o que *qualquer* um dos seus perfis permite.
2. **Restrições vencem.** Uma negação (`deny`) ou campo oculto/travado em *qualquer*
   perfil prevalece sobre qualquer permissão. Não há "permitir mais forte que negar".
3. **Isolamento de tenant é incondicional.** O `tenantId` do registro precisa ser
   o do usuário. Nenhum perfil, negação, compartilhamento ou override desliga isso — e o
   Postgres repete a barreira por RLS (camada independente do código da aplicação).
4. **Falha fechado.** Entidade/ação desconhecida, usuário inativo/suspenso, perfil de
   outro tenant, atributo ausente, contexto ausente → negado. Em condições de
   *permissão* o desconhecido vira falso; em *negações* e *aprovações* vira verdadeiro
   (exige aprovação / nega) — sempre o lado seguro.
5. **Uma regra, dois usos.** A mesma política decide sobre **um objeto** (`decide`) e
   gera o **filtro de lista** (`filterFor` → JS ou `WHERE` no Postgres). Por construção,
   não há como "a lista mostra o que o detalhe nega".
6. **Permissão é dado, não código.** Entidades, ações e escopos vivem num catálogo
   declarativo; perfis são JSON. Adicionar uma entidade não exige mexer no motor.

## 2. Vocabulário

| Termo | Significado |
|---|---|
| **Entidade** | tipo de recurso: `contact`, `company`, `deal`, `conversation`, `proposal`, `task`, `call`, `product`, `pipeline`, `automation`, `instance`, `ai_agent`, `report`, `user`, `role`, `tenant_settings`, `billing`, `audit_log`, `api_key` |
| **Ação** | `read`, `create`, `update`, `delete`, `export`, `import`, `transfer`, `move`, `approve`, `send_message`, `note`, `resolve`, `supervise`, `send`, `publish`, `listen`, `connect`, `assign`, `manage` |
| **Escopo** | "de quem": `none` < `own` < `team` < `team_tree` < `tenant`. Cada um **contém** o anterior (quem vê a equipe vê também o que é seu) |
| **Atributo** | propriedade do registro usável em condições e no filtro SQL (`ownerId`, `teamId`, `stageId`, `value`, `status`…), tipada |
| **Campo** | dado que pode ser ocultado/travado por perfil (`deal.value`, `contact.phone`, `contact.document`…) |
| **Partição** | recorte por configuração: `pipelineId` (quais funis) e `instanceId` (quais números de WhatsApp) |
| **Perfil (role)** | `{ grants, denies, partitions, fields }` — de sistema (imutável) ou do tenant |
| **Grant** | `{ entity, actions, scope, conditions?, approval? }` |
| **Condição** | `{ field, op, value }` ou com `ref` (`$user.id`, `$user.teamIds`); `field` pode ser `ctx.*` (contexto da operação) |
| **Aprovação** | grant com `approval.when`: o ato é permitido **mediante aprovação** quando a condição vale (ex.: desconto > 5%) |
| **Compartilhamento** | acesso explícito a UM registro para usuário/equipe (`read` ou `edit`), sem precisar de perfil |
| **Override** | grants/denies/campos específicos de UM usuário (exceção documentada, também auditada) |

Operadores: `eq ne in nin lt lte gt gte isNull notNull`. Semântica **dois-valorada**:
comparação com `null` nunca é "desconhecido" (`eq/in/lt/…` → falso; `ne/nin` → verdadeiro),
idêntica em JS e em SQL (`COALESCE`/`IS DISTINCT FROM`). É isso que torna `NOT` seguro.

## 3. Como uma decisão é tomada

```
decide(ctx, entidade, ação, registro, contexto?)
  1. subject ativo? (e MFA, se a ação é sensível e a política do tenant exige)
  2. registro.tenantId == subject.tenantId ?                    → senão deny (tenant_mismatch)
  3. alguma NEGAÇÃO de algum perfil/override se aplica?         → deny (denied)
  4. algum RAMO permite? ramo = escopo ∧ partição ∧ condições  (ou compartilhamento)
       nenhum                                                    → deny (no_grant)
  5. há ramo permitido SEM exigir aprovação?                     → allow
     senão                                                       → approval (needs_approval)
```

`filterFor(ctx, entidade, ação)` devolve a expressão `tenant ∧ (ramos) ∧ ¬(negações)`.
Use `toPredicate(expr)` para filtrar arrays no navegador/Node e `toSql(expr, entityDef)`
para o `WHERE` parametrizado (nomes de coluna só do catálogo; valores só como `$n`).

`explain(...)` devolve, ramo a ramo, o que casou e onde falhou (`escopo`, `particao`,
`condicao`) — alimenta o "por que não posso?" da tela e a auditoria.

### Contexto de operação (`ctx.*`)
Algumas ações dependem de **para onde/quanto**: mover negócio (`ctx.toStageKind`),
aprovar/alterar desconto (`ctx.discountPct`), exportar (`ctx.rowCount`). Cada ação declara
no catálogo quais chaves aceita. **O contexto precisa ser derivado pelo servidor** (da
etapa real de destino, do desconto calculado), **nunca copiado do corpo da requisição**.
Chave ausente = desconhecida = lado seguro.

### Campos
`fieldAccess(ctx, entidade)` → `{ campo: 'hidden' | 'readonly' }`. O mais restritivo
entre *todos* os perfis vence (Admin + perfil restritivo = campo oculto). `maskRow`
remove campos ocultos; **toda resposta de API que serializa a entidade deve passar por
ele** (inclusive export, busca, notificações e agregações — ver §7).

## 4. Perfis de fábrica

Admin · Gestor · Atendente · SDR · Financeiro · Somente leitura
(definidos em `roles.js`, travados por uma **matriz dourada** nos testes: alterar um
perfil de sistema sem querer quebra o build). São imutáveis; o tenant **clona** e ajusta.
Exemplos de regras que já existem: Atendente vê o que é seu + a **fila** (conversa sem
responsável); SDR **não** move negócio para Ganho/Perdido; Atendente altera proposta com
desconto > 5% **só com aprovação**; Gestor aprova até 15%; Financeiro não vê telefone.

## 5. Gestão segura das regras

O que impede a tela de permissões de virar vetor de ataque (`validate.js`):

- `validateRole` — perfil malformado (entidade/ação/escopo/atributo/`ctx` inexistentes,
  escopo que não se aplica à entidade) é recusado antes de ser salvo.
- `checkNoEscalation` — **ninguém concede o que não tem**: o ator só cria/atribui perfil
  cujos grants ele mesmo possui (escopo ≥, partições que contêm, sem depender de condição
  que o candidato não tem). Conservador: na dúvida, recusa.
- Perfis de sistema são **imutáveis** (`isImmutableRole`); `createContext` ignora perfil de
  tenant que tente reutilizar id de sistema, se declarar `system:true` ou for de outro tenant.
- `wouldRemoveLastAdmin` — o tenant nunca fica sem administrador ativo.
- `diffRoles` + `auditEvent` — toda mudança gera evento com o que foi adicionado/removido.

A aplicação **também** precisa exigir `role.create/update/assign` via o próprio motor
antes de chamar essas funções — elas validam o *conteúdo*, não a *autoridade*.

## 6. Decisões e alternativas descartadas

| Alternativa | Por que não (agora) |
|---|---|
| **RBAC puro** (perfil → lista de permissões) | Não expressa "só os próprios", equipe/subequipe, pipeline, número de WhatsApp, aprovação nem etapa — que são o dia a dia do CRM. |
| **ABAC genérico / motor de políticas externo** (OPA, Cedar, Casbin) | Poderosos, mas: linguagem própria para o time aprender; **filtrar listas** (partial evaluation → SQL) é o difícil e é o que mais precisamos; mais uma peça para operar. Reavaliar se as regras crescerem além de escopo+condições. |
| **ReBAC estilo Zanzibar** (OpenFGA) | Ótimo para compartilhamento profundo e hierarquias arbitrárias; excesso para o MVP. O compartilhamento por registro e a árvore de equipes cobrem o necessário; há caminho de evolução (§9). |
| **Permissões normalizadas em tabelas** (`role_grants`…) | Duas representações para manter em sincronia com o motor em JS. Perfil como JSON validado (`validateRole`) mantém **uma** fonte de avaliação. |
| **Só RLS no Postgres** (sem motor na aplicação) | Regras como aprovação, `ctx.*`, campos ocultos e "por que não posso?" não cabem em RLS; e RLS por usuário com PgBouncer em modo transação é frágil. RLS fica como **barreira de tenant exata + escopo grosso**. |
| **Só filtro na aplicação** (sem RLS) | Um `SELECT` esquecido vira vazamento entre clientes. O RLS de tenant torna esse erro inofensivo. |

## 7. Requisitos para a camada de API (o motor sozinho não garante)

1. **Toda listagem** aplica `filterFor(...)` no `WHERE` (nunca "carregar tudo e filtrar depois").
2. **Todo acesso por id** passa por `decide(...)` com o registro **lido do banco**, não do corpo da requisição (anti-IDOR).
3. **Contexto (`ctx.*`) e `sharedWith` vêm do servidor**, nunca do cliente.
4. **Respostas passam por `maskRow`**; filtros, ordenação, busca, exportação e agregações **não podem usar campo oculto** (oráculo de dados).
5. **Versão de permissão**: perfil/equipe/status mudou ⇒ incrementa a versão do usuário (e do tenant); sessões e caches comparam a versão e invalidam. Cache da compilação só por `(usuário, versão, entidade, ação)`.
6. **Auditoria** de: mudanças de perfil (`diffRoles`), atribuição de perfil, `listen`/`export`/`supervise`, "entrar como", acessos negados sensíveis.
7. **Admin da plataforma ≠ admin do tenant**: acesso de suporte a dado de tenant só por "entrar como" com motivo, expiração e registro — nunca por perfil comum.
8. **Limites**: tamanho de organograma, número de grants/perfis e profundidade de expressão (proteção contra DoS).
9. **Transação**: `set_config('app.tenant_id', …, true)` por transação (compatível com PgBouncer).

## 8. Escala e manutenção

- Compilação é barata e determinística; faça cache por `(usuário, permVersion, entidade, ação)`.
- `team_tree` expande o organograma **na compilação** para uma lista de ids (a consulta usa `= ANY($n)`); para organogramas muito grandes, trocar por tabela de fechamento (`team_closure`) — ver `permissoes-banco.md`.
- Todo atributo usado em condições/escopo tem índice composto começando por `tenant_id`.
- **Adicionar entidade**: 1) registro em `catalog.js`; 2) tabela com `tenant_id` + RLS na migração; 3) testes da matriz. O motor, a validação, o compilador SQL e a tela de matriz não mudam.
- **Adicionar ação**: incluir em `ACTIONS` e na lista `actions` das entidades.
- **Mudança de semântica** (algo das regras §1) exige revisão de segurança e atualização da matriz dourada.

## 9. Evolução planejada (não implementada)

Acesso temporário com expiração · "break-glass" auditado · SSO/SCIM (provisionamento de
usuários/equipes) · revisão periódica de acessos (campanha de recertificação) ·
segregação de funções (perfis incompatíveis entre si) · condições com horário/IP ·
chaves de API com escopo próprio · política por tenant (MFA obrigatório, retenção de
log, limite de exportação) · ReBAC para compartilhamento profundo · criptografia de
campos sensíveis por tenant.

## 10. Estratégia de testes

- **Unitários** por regra (escopos, hierarquia e ciclos, condições, partições, aprovação, negação, campos, MFA, isolamento de perfil).
- **Matriz dourada** escrita à mão para os 6 perfis de sistema.
- **Propriedades com fuzz de semente fixa**: equivalência objeto↔lista; nenhum acesso entre tenants em combinações aleatórias; monotonicidade (somar grant nunca tira acesso, somar deny nunca dá); deny sempre vence; falha fechado com entrada malformada; sem escalonamento.
- **Teste diferencial contra Postgres real**: mesmo conjunto de dados e usuários aleatórios — o conjunto de ids do `WHERE` compilado tem de ser **idêntico** ao do motor em JS; e o RLS grosso é sempre superconjunto.
- **Segurança do `toSql`**: valores maliciosos só em parâmetros; nomes inválidos lançam.

---

## 11. Revisão adversarial de segurança (2026-10-09)

Um revisor independente tentou quebrar o motor (18 achados, todos reproduzidos com PoC). Estado:

**Fechado e travado por teste de regressão (`test/permissions/hardening.test.mjs`)**
- Contexto malformado (`null`, `NaN`, texto, número negativo, booleano) deixava de exigir aprovação / burlava o teto de alçada → agora é **desconhecido** (lado seguro).
- Aprovação de desconto valia só no `update`: o Atendente criava e enviava proposta com 40% sem aprovação → `create`, `send` e `update` exigem aprovação acima de 5%.
- **Auto-aprovação:** `approve` ganhou o contexto `requesterId`; Gestor tem negação para `requesterId == eu` (e, se o servidor esquecer de informar, a negação vale). Financeiro deixou de aprovar desconto (alçada comercial).
- `update` alterava dono, equipe, etapa, funil e até `tenantId`: o catálogo agora declara `IMMUTABLE_ATTRS` e `CONTROLLED_ATTRS` (dono/equipe exigem `transfer`; etapa/status/funil exigem `move`), e `canWriteField` + novo **`checkPatch`** validam o PATCH inteiro e o **registro resultante** (equivalente a um `WITH CHECK`).
- Compartilhamento com uma equipe vazava **para cima** na hierarquia → vale só para membros daquela equipe. Nova ação **`share`** (criar/remover compartilhamento) para contato, empresa e negócio.
- Perfil sem `tenantId` que não é de sistema valia para todos os tenants → só `system: true` vale sem dono.
- **MFA falha-fechada:** política ausente = exige MFA em ação sensível; só `mfa === true` vale; só `requireMfaForSensitive: false` desliga.
- `maskRow` em entidade desconhecida devolvia a linha inteira → devolve vazio; alias SQL interno do compartilhamento isolado (`shr_`); ator suspenso não concede perfil.

**Ainda aberto (priorizar antes de produção)**
- `checkNoEscalation` ignora as **negações e restrições de campo do próprio ator** e não percebe a **remoção** de restrições de um perfil editado (falta `checkRoleChange(ator, antes, depois)`); `subject.overrides` não tem validador nem auditoria.
- Normalização de tipos entre JS e SQL: UUID em maiúsculas, `numeric` que o `pg` devolve como texto, `COLLATE "C"` em comparações de texto, literais de tipo errado aceitos por `validateRole` (os 5 `todo` do teste diferencial).
- Campos: faltam *aliases* (`discount` vs `discountPct`), `maskDeep`, um `queryableAttrs` (campo oculto não pode filtrar/ordenar/agregar) e relatórios calculados por `filterFor` em vez de `report:read` no tenant inteiro.
- Catálogo sem entidade `team` (mudar `teamIds` muda o escopo e hoje cai em `user.update`), sem `impersonate`, e sensibilidade/MFA por ação (não por entidade × ação: `role.update`, `api_key.create`, `billing.update` não exigem MFA).
- Limites de tamanho (grants, condições, equipes) e cache de `expandTeams` por versão do organograma; `auditEvent` com campos forjáveis, sem snapshot em criar/remover e sem hash encadeado; "último admin" pelo id do perfil em vez do poder efetivo.
- Lacunas de design para auditoria corporativa: segregação de funções, recertificação de acessos, acesso temporário com expiração, *break-glass*, retenção imutável de log, limite/DLP de exportação, SSO/SCIM, criptografia por tenant.

**Requisitos que a API deve cumprir** (o motor sozinho não garante): derivar `ctx.*`, `sharedWith`, `subject` e `row` no servidor; usar `checkPatch` em todo PATCH; `can()` (não `canOrRequest`) para executar; guardar pedidos de aprovação com o hash do payload e impedir aprovador = solicitante; `maskRow` em toda serialização; `permVersion` por usuário/tenant em toda requisição.
