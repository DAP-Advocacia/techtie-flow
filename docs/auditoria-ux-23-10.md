# Auditoria de UX (23/10/2026) — o que era real, o que foi feito, o que falta

Fonte: análise externa da versão desktop (nota 6,5/10). Cada ponto foi conferido no código antes de mexer.

## Feito neste ciclo

| Ponto da auditoria | O que era de verdade | O que foi feito |
|---|---|---|
| Tempo de 1ª resposta “9829m 38s” | Dado real (média de conversas antigas respondidas dias depois) e formato ruim | Servidor usa **mediana** (uma conversa velha não distorce); formato `8s`, `2m 10s`, `2h 05min`, `6d 19h`; tooltip explica |
| Domínio `crm.acme.com.br` “verificado” | Dado de demonstração vazando para a operação real (a marca nunca vem do servidor) | `dropDemoData` no 1º carregamento real: marca neutra, sem domínio |
| IA: base vazia mas teste cita documento | A conversa de teste de demonstração vazava (“Fonte: Catálogo de Integrações.pdf”) | Conversa de teste começa vazia em operação real |
| Fluxos “1,2 mil execuções” / auditoria inventada | Mesmo vazamento do mock | Somem em operação real; Automações mostra aviso honesto: editor em pré-visualização, motor de execução é a próxima etapa |
| Data mm/dd/yyyy e hora AM/PM | O `<input type=date/time>` segue o idioma do navegador de quem testa | Campos próprios `dd/mm/aaaa` e `HH:MM` (24 h) com máscara, calendário e valor ISO (tarefas, editar negócio, filtro de lista, horário comercial das automações) |
| Seletor de contato difícil com base grande | `<select>` com centenas de linhas | Busca por nome, empresa, telefone e e-mail; 40 por vez; teclado; telefone formatado; “+ Novo contato” (negócio) e “Nenhum” (tarefa) |
| WhatsApp “não-oficial (QR)” sem explicação | O fluxo de conexão já explicava; o cartão e “Gerenciar” não | Cartão ganha “Entenda este tipo de conexão”; “Gerenciar” mostra o que ganha, limitações e risco |
| Contatos: botão cortado, lista estreita | Botão “Importar CSV” entrou na coluna de 300 px | Coluna mais larga e botões quebram de linha |
| Kanban: painel de detalhes esconde etapas | Painel fixo de 340 px | Painel **recolhível** (lembra a escolha; recolhido por padrão abaixo de 1360 px; escolher um cartão reabre) e largura proporcional |
| Dashboard sem definição das métricas | Faltava texto | Cada indicador tem uma linha dizendo o que conta |

## Ainda aberto (ordem sugerida)

1. **Marca e domínio no servidor** — hoje o cartão de marca/domínio só guarda na tela e “Verificar” é simulado. Precisa persistir em `tenants.settings`, checar o CNAME de verdade e deixar claro o que não funciona ainda.
2. Dashboard: filtro por equipe/funil e clique no número levando à lista filtrada.
3. Novo negócio com “Mais detalhes” (empresa, origem, previsão) — depende de **campos personalizados** (item 4 da sequência).
4. Checklist de configuração do Agente de IA (instruções → base → transferência → teste → ativação) e histórico/falhas das automações — junto do item 3 (**automações de verdade**).
5. Permissões: matriz completa em “Avançado”, MFA no convite.
6. Contraste/tamanho mínimo de textos de apoio (hoje 11–12 px) e sidebar agrupável.
7. Formulário público de captação de leads (ainda não existe).
8. Auditoria **não avaliou o celular**; revisar depois.
