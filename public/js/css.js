// CSS de tela sob demanda. As telas carregam o próprio CSS pela rota (app.js), mas painéis e diálogos de uma tela
// abrem em OUTRAS (ex.: "Nova tarefa" ou "Novo contato" a partir da barra superior): eles pedem o CSS aqui.
// Usa o MESMO atributo do carregador de rotas, então nunca carrega duas vezes.
import { h } from './ui.js';

export function ensureScreenCss(id) {
  if (document.querySelector(`link[data-screen-css="${id}"]`)) return;
  const link = h('link', { rel: 'stylesheet', href: `/css/screens/${id}.css`, 'data-screen-css': id });
  link.addEventListener('error', () => link.remove());
  document.head.append(link);
}
