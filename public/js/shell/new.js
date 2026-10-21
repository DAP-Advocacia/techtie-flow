// "+ Novo": criar negócio, contato ou tarefa de QUALQUER tela (barra superior, busca global, celular).
// Cada item já nasce desabilitado, com o motivo, se o perfil não pode criar aquilo.
import { store } from '../store.js';
import { toast } from '../ui.js';
import { ensureScreenCss } from '../css.js';
import { linkTo } from '../router.js';
import { openTaskPanel } from '../screens/tasks/panel.js';
import * as TA from '../screens/tasks/actions.js';
import { openContactForm, canCreateContact } from '../screens/contacts/form.js';
import { openNewDeal } from '../screens/pipeline/new-deal.js';
import * as P from '../screens/pipeline/perm.js';

/** Funil onde o usuário PODE criar negócio: o da equipe dele primeiro, senão o primeiro permitido. */
export function dealTarget() {
  const teamId = store.user()?.teamIds?.[0];
  const teamPipeline = store.state.teams.find((t) => t.id === teamId)?.pipelineId;
  const pipelines = P.visiblePipelines(P.visibleDeals()).sort((a, b) => Number(b.id === teamPipeline) - Number(a.id === teamPipeline));
  return pipelines.find((p) => P.createOwners(p).allowed.length > 0) || null;
}

/** @returns [{ id, label, hint, keywords, disabled, reason, run }] */
export function newActions() {
  const pipeline = dealTarget();
  const canDeal = !!pipeline;
  const canContact = canCreateContact();
  const canTask = TA.canCreate();
  return [
    {
      id: 'deal',
      label: 'Negócio',
      hint: pipeline ? `no funil ${pipeline.name}` : '',
      keywords: 'novo negocio venda oportunidade proposta',
      disabled: !canDeal,
      reason: 'Seu perfil não permite criar negócios.',
      run: () => {
        ensureScreenCss('pipeline');
        openNewDeal({
          pipeline,
          onCreated: (deal) => {
            toast('Negócio criado');
            location.hash = linkTo('deal', { id: deal.id });
          },
        });
      },
    },
    {
      id: 'contact',
      label: 'Contato',
      hint: '',
      keywords: 'novo contato cliente lead pessoa',
      disabled: !canContact,
      reason: 'Seu perfil não permite criar contatos.',
      run: () => openContactForm({ onSaved: (c) => (location.hash = linkTo('contacts', { c: c.id })) }),
    },
    {
      id: 'task',
      label: 'Tarefa',
      hint: '',
      keywords: 'nova tarefa lembrete atividade pendencia',
      disabled: !canTask,
      reason: 'Seu perfil não permite criar tarefas.',
      run: () => openTaskPanel({}),
    },
  ];
}
