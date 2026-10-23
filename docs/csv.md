# Importar e exportar CSV

## Exportar
Nas listas em **tabela** (Contatos → Tabela; Negócios → Lista) o botão **Exportar CSV** baixa **exatamente o que está na tela**: as
linhas já filtradas e ordenadas e só as colunas visíveis (campo oculto no perfil nunca é coluna, então nunca sai). Antes de baixar,
o motor confere a permissão `export` (Admin, Gestor e Financeiro nos negócios; Atendente, SDR e Somente leitura não veem o botão) e a
exportação é **registrada na auditoria** com quem exportou e quantas linhas. O arquivo abre direto no Excel em português:
**ponto e vírgula**, UTF-8 com BOM, datas dd/mm/aaaa, valores com vírgula, nome (não id) de responsável e etapa. Texto que começa com
`=` ou `@` (ou com `+`/`-` que não seja número/telefone) é gravado como texto, para não virar fórmula na planilha.

## Importar
Botão **Importar CSV** em Contatos e em Negócios (por funil). Exige `import` do motor (contatos também `create`): Admin e Gestor.
Assistente em 4 passos: **arquivo → ligar colunas → conferir → importar**.
- **Arquivo**: salvo como CSV no Excel/Bitrix. Aceita separador `;` `,` ou tabulação, aspas, quebra de linha dentro da célula e arquivo em
  Windows-1252 (acento do Excel antigo). Até **2000 linhas** por vez. "Baixar modelo" entrega a planilha de exemplo. **.xlsx não** é lido ainda
  (salvar como CSV).
- **Colunas**: o sistema chuta pelo cabeçalho ("Celular" → Telefone, "Fase" → Etapa…); você corrige. Contatos: nome (obrigatório), empresa,
  telefone, e-mail, origem. Negócios: título (obrigatório), contato (nome/telefone/e-mail), valor, etapa, previsão de fechamento, responsável.
- **Conferir**: mostra quantos entram e quais linhas ficam de fora, com o motivo (sem nome, telefone/e-mail inválido, repetido no arquivo,
  já existe, etapa que não existe, responsável não encontrado…). As regras são as **mesmas do servidor** (`shared/import/rules.js`).
- **Contatos**: telefone vira só dígitos (10 ou 11 dígitos ganham o 55; "+" na frente mantém o país). Quem já existe na empresa (mesmo telefone
  ou e-mail, **inclusive contatos que você não enxerga**) é pulado, sem dizer de quem é, e nada do que está cadastrado é alterado.
- **Negócios**: etapa por nome (sem acento/caixa; em branco = a primeira em andamento); responsável por e-mail ou nome (em branco = você); valor
  "R$ 1.500,50"; contato ligado por telefone, e-mail ou nome entre os que **você pode ler** — se não achar, **cria** o contato. Cada negócio passa
  pelo motor como se fosse criado à mão: o que o perfil não pode criar (outro responsável, etapa final) fica de fora com o motivo.
- O resultado (criados, de fora, contatos novos) vem do servidor; "Baixar linhas de fora" gera um CSV com linha e motivo. Fica na auditoria.

## Técnico
`shared/import/rules.js` (regras puras, usadas pela tela e pelo servidor), `public/js/lists/csv.js` (ler/escrever), `screens/import/wizard.js`
e `actions.js`, `src/api/routes-import.js` (`POST /api/exports`, `/api/import/contacts`, `/api/import/deals`). Testes: `test/api/csv.test.mjs`,
`import-rules.test.mjs`, `test/ui/csv-ui.test.mjs` e o fluxo contra Postgres real em `test/api/api.test.mjs`.
