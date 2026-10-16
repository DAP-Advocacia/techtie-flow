'use strict';
// Cliente mínimo da OpenAI (Chat Completions). Sem SDK: só fetch, para ficar fácil de testar (fetch injetável)
// e sem dependência nova. A chave vem SEMPRE do ambiente do servidor (OPENAI_API_KEY) e nunca sai dele:
// erros devolvem só o status e a mensagem da OpenAI, jamais o cabeçalho de autorização.
const URL_CHAT = 'https://api.openai.com/v1/chat/completions';

class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * @param opts { apiKey, model, fetchImpl }
 * @returns { configured, model, chat({ messages, model?, temperature?, maxTokens?, json?, timeoutMs? }) }
 *   chat devolve { text, usage: { prompt, completion }, model }
 */
function createOpenAI({ apiKey, model = 'gpt-4o-mini', fetchImpl = globalThis.fetch } = {}) {
  return {
    configured: !!apiKey,
    model,
    async chat({ messages, model: m, temperature = 0.3, maxTokens = 500, json = false, timeoutMs = 30_000 }) {
      if (!apiKey) throw new AiError('A chave da OpenAI não está configurada no servidor (OPENAI_API_KEY).', 503);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(URL_CHAT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: m || model, messages, temperature, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new AiError(e.name === 'AbortError' ? 'A OpenAI demorou demais para responder.' : 'Não foi possível falar com a OpenAI agora.', 504);
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const why = String(data?.error?.message || `erro ${res.status}`).slice(0, 200);
        throw new AiError(res.status === 429 ? 'A OpenAI está limitando as chamadas (tente de novo em instantes ou verifique o saldo da conta).' : `A OpenAI recusou o pedido: ${why}`, res.status === 401 ? 503 : 502);
      }
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new AiError('A OpenAI respondeu sem texto.');
      return { text, usage: { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0 }, model: data.model || m || model };
    },
  };
}

module.exports = { createOpenAI, AiError };
