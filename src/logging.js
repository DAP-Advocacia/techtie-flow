'use strict';
// O libsignal (criptografia do WhatsApp, dentro do Baileys) imprime com console.info/warn o OBJETO
// INTEIRO da sessão sempre que troca/fecha uma sessão com um contato ("Closing session: SessionEntry
// {...}") — e esse objeto inclui CHAVES PRIVADAS (privKey, rootKey…). Num terminal local é só ruído;
// com os logs indo para um serviço (Docker, EasyPanel, Datadog…) vira vazamento de segredo.
// Aqui essas linhas são descartadas na origem. Qualquer outro log passa intacto.
const SIGNAL_PREFIXES = ['Closing session', 'Opening session', 'Removing old closed session', 'Migrating session to', 'Session already closed', 'Session already open'];

const isSignalNoise = (args) => typeof args[0] === 'string' && SIGNAL_PREFIXES.some((p) => args[0].startsWith(p));

/** Envolve info/log/warn do `target` (padrão: console global). Devolve função que desfaz. */
function silenceSignalNoise(target = console) {
  const originals = {};
  for (const level of ['info', 'log', 'warn']) {
    originals[level] = target[level];
    target[level] = (...args) => {
      if (isSignalNoise(args)) return;
      originals[level].apply(target, args);
    };
  }
  return () => Object.assign(target, originals);
}

module.exports = { silenceSignalNoise, isSignalNoise };
