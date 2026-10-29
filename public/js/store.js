// Store único do protótipo: estado em memória (dados fictícios) + tema
// persistido + assinatura de mudanças. Telas LEEM de store.state, ESCREVEM
// só via store.update(fn) e re-renderizam em store.subscribe(fn). Quando
// houver backend, só este módulo troca de implementação.
import { createMockData } from './mock/data.js';

const listeners = new Set();

export const store = {
  state: { ...createMockData(), theme: 'light',session: { loggedIn: false } },

  /** Muta o estado dentro de fn(state) e avisa os assinantes. */
  update(fn) {
    fn(this.state);
    for (const l of [...listeners]) l(this.state);
  },

  /** Assina mudanças; devolve a função de cancelar. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ---- atalhos de leitura ----
  user() {
    return this.state.users.find((u) => u.id === this.state.currentUserId);
  },
  contact(id) {
    return this.state.contacts.find((c) => c.id === id);
  },
  userById(id) {
    return this.state.users.find((u) => u.id === id);
  },
  instance(id) {
    return this.state.instances.find((i) => i.id === id);
  },
  pipeline(id) {
    return this.state.pipelines.find((p) => p.id === id);
  },
  stage(stageId) {
    for (const p of this.state.pipelines) {
      const s = p.stages.find((x) => x.id === stageId);
      if (s) return s;
    }
    return undefined;
  },
  deal(id) {
    return this.state.deals.find((d) => d.id === id);
  },
};

/** Tema único (claro). Mantido para as telas que ainda leem data-theme; não há mais alternância. */
export function applyTheme() {
  document.documentElement.dataset.theme = 'light';
}
