# Agente de IA

O agente responde clientes no WhatsApp **sozinho**, usando a personalidade, as regras de transbordo e a base de
conhecimento cadastradas em **Agente de IA** (tela). Funciona com a OpenAI; a chave fica só no servidor.

## Como liga
1. No Coolify, variável **`OPENAI_API_KEY`** (secret). Opcional: `OPENAI_MODEL` (padrão `gpt-4o-mini`) e `AI_DAILY_TOKEN_CAP`.
2. Em **Agente de IA**: escreva a personalidade, as regras de transbordo e envie documentos (PDF, DOCX, TXT, MD, CSV).
3. Escolha o **número** e ligue o agente. A IA só responde nos números com ela ligada (`instances.ai_active`).
4. Use **Testar agente**: fala com a OpenAI de verdade, com o que está salvo, **sem** enviar nada ao WhatsApp.

## Quando a IA responde (e quando NÃO)
Responde mensagem **nova** de cliente quando, ao mesmo tempo: o número tem a IA ligada; a conversa **não tem atendente**;
ninguém assumiu nem a IA já transferiu (`conversations.ai_paused`); a conversa não está resolvida; não passou do limite de
respostas da conversa (padrão 8) nem do teto diário de tokens; o WhatsApp do número está conectado.
- Um **humano** que responde (pela caixa de entrada ou digitando no celular) **pausa** a IA nessa conversa.
- Quando a IA decide **transferir** (pedido do cliente, regra de transbordo, falta de informação), ela manda uma frase de
  transição, **pausa**, devolve a conversa à **fila** como não lida e deixa uma nota de sistema com o motivo.
- Mensagens seguidas do cliente (2,5 s) viram **uma** resposta. Há uma pequena pausa de "digitação" antes de enviar.
- Erro da OpenAI = **silêncio**: a conversa continua na fila para os humanos (nunca manda mensagem quebrada).

## Base de conhecimento
O servidor converte o arquivo em texto, quebra em trechos (~900 caracteres) e, a cada pergunta, escolhe os trechos mais
parecidos (busca por termos, sem embeddings nesta versão) e os coloca no prompt. O agente é instruído a **não inventar**:
se a resposta não está na base, ele transfere. Limites: 40 documentos, 6 MB por arquivo. PDF escaneado (só imagem) não tem texto.

## Custo e segurança
- Cada resposta grava os tokens em `ai_usage`; a IA para ao atingir `AI_DAILY_TOKEN_CAP` (24 h, por empresa).
- A chave nunca vai ao navegador nem aparece em erros ou logs. Permissões: ler a configuração exige `ai_agent.read`;
  salvar, enviar documentos e ligar a IA num número exigem `ai_agent.update`.
- O dashboard mostra a linha "Agente de IA" (conversas que ele respondeu primeiro e tempo de 1ª resposta).

## Próximos passos possíveis
Busca semântica (embeddings/pgvector) para bases grandes; horário de atendimento da IA; IA por número com personalidade
própria; transcrição de áudio do cliente; XLSX na base.
