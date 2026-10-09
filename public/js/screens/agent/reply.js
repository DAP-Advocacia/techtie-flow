// Motor de resposta SIMULADO do chat de teste: casa palavras-chave e cita um
// documento que realmente exista (e esteja pronto) na base. Quando o doc
// necessário foi removido/ainda processa, cai no transbordo por baixa
// confiança, que é o que o agente real faria sem fonte.

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const findDoc = (docs, re) => docs.find((d) => d.status === 'ready' && re.test(norm(d.name)));
const findRule = (rules, re) => rules.find((r) => re.test(norm(r)));

// Só transfere quando existe uma regra cadastrada que case: sem regra o agente
// nunca transfere (é o que a tela promete), então devolve null e o chamador
// segue respondendo normalmente.
function handoff(rules, re) {
  const rule = findRule(rules, re);
  return rule ? { kind: 'handoff', text: 'Passando para um atendente humano', rule } : null;
}

/**
 * @param {string} input texto do lead
 * @param {{knowledgeDocs: Array, handoffRules: string[]}} agent
 * @returns {{kind:'ai', text:string, source?:string} | {kind:'handoff', text:string, rule:string}}
 */
export function simulateReply(input, agent) {
  const t = norm(input);
  const docs = agent.knowledgeDocs || [];
  const rules = agent.handoffRules || [];
  // Sem fonte na base: transfere por baixa confiança se houver essa regra;
  // senão admite que não sabe, em vez de inventar.
  const lowConfidence = () =>
    handoff(rules, /confianca/) || {
      kind: 'ai',
      text: 'Ainda não tenho essa informação na minha base. Pode me contar um pouco mais sobre o que você precisa?',
    };

  // Palavras inteiras (\b): "pessoas" (resposta natural a "quantas pessoas?")
  // e "rápido" (contém "api") não podem disparar transbordo nem ERP.
  if (/\b(humano|atendente|vendedor|gerente)\b/.test(t) || /\b(falar|conversar|passa\w*|chama\w*|transfer\w*)\b.*\b(pessoa|alguem)\b/.test(t)) {
    const ho = handoff(rules, /pessoa|humano|atendente/);
    if (ho) return ho;
  } else if (/\b(desconto|abatimento|negociar)\b/.test(t)) {
    const ho = handoff(rules, /desconto|negocia/);
    if (ho) return ho;
  }
  if (/\b(erp|api|integra\w*)\b/.test(t)) {
    const doc = findDoc(docs, /integra/);
    if (!doc) return lowConfidence();
    return {
      kind: 'ai',
      text: 'Fazemos sim! Integramos via API com os principais ERPs. Qual sistema vocês usam hoje?',
      source: doc.name,
    };
  }
  if (/\b(preco\w*|valor(es)?|quanto|custa\w*|mensalidade)\b/.test(t)) {
    const doc = findDoc(docs, /preco|tabela/);
    if (!doc) return lowConfidence();
    return {
      kind: 'ai',
      text: 'Os valores variam conforme o plano e o número de atendentes. Para eu indicar a faixa certa: quantas pessoas vão usar e em qual prazo vocês querem começar?',
      source: doc.name,
    };
  }
  const faq = findDoc(docs, /faq/) || docs.find((d) => d.status === 'ready');
  return {
    kind: 'ai',
    text: 'Obrigada pelo contato! Para te ajudar melhor, me conta: qual é a sua necessidade principal, em que prazo pretende resolver e qual a faixa de investimento prevista?',
    source: faq?.name,
  };
}
