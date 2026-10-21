// O painel da tarefa abre em várias telas (Tarefas, Negócios, Contatos, Inbox, Início): o CSS não pode depender de a
// tela Tarefas ter sido visitada. Mesmo atributo do carregador de rotas (app.js), então nunca carrega duas vezes.
import { h } from '../../ui.js';

export function ensureTasksCss() {
  if (document.querySelector('link[data-screen-css="tasks"]')) return;
  const link = h('link', { rel: 'stylesheet', href: '/css/screens/tasks.css', 'data-screen-css': 'tasks' });
  link.addEventListener('error', () => link.remove());
  document.head.append(link);
}
