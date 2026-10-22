# Funis configuráveis

Tela **Funis** (menu, grupo de administração, só no computador): criar, renomear e apagar funis; editar as etapas de cada um
e a lista de **motivos de perda** da empresa. Antes os funis vinham prontos e ninguém conseguia mudar nada pela tela.

## Quem pode
Entidade `pipeline` do motor de permissões: **criar** e **excluir** (Admin) e **alterar** (Admin e Gestor). Quem não tem a
permissão vê os controles desabilitados com o motivo; o servidor confere tudo de novo. Nada novo no catálogo de permissões.

## Etapas
- Cada etapa tem **nome**, **tipo** (em andamento, ganha ou perdida), **probabilidade** (0 a 100%) e **ordem** (subir/descer).
- Ganha vale sempre 100% e perdida 0% (travado). Todo funil precisa de **3 a 30 etapas**, com pelo menos uma de cada tipo.
- **Etapa com negócio não se remove e não muda de tipo** (isso seria mover negócio sem passar pela regra de mover). Nome e
  probabilidade mudam à vontade. O servidor confere com **todos** os negócios da empresa, não só os que a pessoa enxerga.
- A etapa que já existia **mantém o id**: os negócios continuam ligados a ela ao renomear ou reordenar.
- Funil novo nasce com Novo (25%), Qualificação (50%), Proposta (75%), Ganho e Perdido. Nome de funil não repete (sem diferenciar
  maiúscula nem acento). Só dá para apagar funil **sem negócios**, e a empresa mantém **pelo menos um**.
- Os funis que já existiam receberam probabilidade na migração (ganho 100, perdido 0, abertas espalhadas pelo funil).

## Motivos de perda
- Lista **única por empresa** (vale para todos os funis), até 30 motivos de até 80 caracteres; "Sugerir motivos comuns" preenche.
- **Com a lista cadastrada, perder um negócio exige escolher um dos motivos** (diálogo de confirmação, página do negócio, Path,
  arrastar e ação em massa); o servidor recusa motivo fora da lista. Sem lista, continua opcional e livre.
- O negócio guarda o **texto** do motivo (`deals.lost_reason`): renomear ou apagar um motivo não mexe no histórico. Aparece na
  página do negócio e na atividade ("moveu de X para Perdido (motivo: Preço)"). Reabrir o negócio limpa o motivo.

## Previsão de receita ponderada
Valor × probabilidade da etapa. Aparece no Início (cartão **Fechando este mês**: "previsão ponderada R$ …"), no rodapé da lista de
Negócios ("Soma … · ponderada …") e nas colunas **Probabilidade** e **Valor ponderado** da lista (valor oculto no perfil = sem
valor ponderado).

## Técnico
- Migração `0007_pipeline_config.sql`: `pipeline_stages.probability`, `deals.lost_reason`, tabela `loss_reasons` (RLS por tenant).
- Migração `0008_pipeline_probability_backfill.sql`: preenche a probabilidade dos funis que já existiam, empresa por empresa (a RLS é
  FORCE: sem `app.tenant_id` o UPDATE não enxerga linha nenhuma — foi o que deixou tudo em 0% na 0007). Só mexe no que ninguém configurou.
- API (`src/api/routes-pipelines.js`): `POST /api/pipelines`, `PATCH /api/pipelines/:id`, `PUT /api/pipelines/:id/stages`
  (lista inteira na ordem da tela), `DELETE /api/pipelines/:id`, `PUT /api/loss-reasons`. Tudo na auditoria (`pipeline.*`) e o
  tempo real avisa as outras pessoas (`pipelines`) para recarregar.
- Front: `screens/funnels.js`, `funnels/model.js` (regras puras, testadas), `funnels/actions.js` (protótipo e operação).
- Testes: `test/api/funnels-model.test.mjs`, `test/ui/funnels-ui.test.mjs`, e o fluxo completo contra Postgres real em `test/api/api.test.mjs`.
