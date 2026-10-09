// Cor de destaque (white-label). Sobrescreve --acc/--acc2/--dim/--bar em
// <html style> por cima dos tokens do tema; "champagne" (padrão) apenas REMOVE
// os overrides, deixando tokens.css mandar (assim claro/escuro seguem corretos).
//
// Persistência: localStorage['ttf:accent'] guarda o id ('gold'|'green'|'blue'|'red').
// ATENÇÃO: app.js precisa chamar applySavedAccent() no boot; enquanto isso não
// acontece, o accent salvo só é reaplicado ao abrir a tela de Configurações.
import { store } from '../../store.js';

export const ACCENT_KEY = 'ttf:accent';

// Valores por tema. Os de "gold" espelham tokens.css (usados só nas amostras
// de cor, já que gold é aplicado removendo overrides); os demais partem de
// --green / --ins / --red de cada tema, com variantes de ênfase, discreta e de barra.
export const ACCENTS = [
  {
    id: 'gold',
    name: 'Champagne',
    dark: { acc: '#d6c093', acc2: '#ead9b0', dim: '#8b7a55', bar: '#6f6850' },
    light: { acc: '#8a6d2f', acc2: '#6f5622', dim: '#b9a572', bar: '#c4ad74' },
  },
  {
    id: 'green',
    name: 'Verde',
    dark: { acc: '#6fbf8b', acc2: '#9bd8b0', dim: '#4f8a65', bar: '#3f6b50' },
    light: { acc: '#2f8f58', acc2: '#23724a', dim: '#7fb896', bar: '#8fc9a6' },
  },
  {
    id: 'blue',
    name: 'Azul',
    dark: { acc: '#8bb4dd', acc2: '#b3d0ee', dim: '#5f83a8', bar: '#46627f' },
    light: { acc: '#3f78b0', acc2: '#2f6090', dim: '#8fb3d6', bar: '#9dbfe0' },
  },
  {
    id: 'red',
    name: 'Vermelho',
    dark: { acc: '#e08a82', acc2: '#f0aaa3', dim: '#a85f59', bar: '#7a4743' },
    light: { acc: '#c0504a', acc2: '#9e3c37', dim: '#d89a96', bar: '#deaaa6' },
  },
];

const VARS = ['acc', 'acc2', 'dim', 'bar'];
const isValid = (id) => ACCENTS.some((a) => a.id === id);

// Accent atualmente aplicado no <html> (pode ser uma prévia ainda não salva).
let current = 'gold';
let subscribed = false;

/** Reaplica o accent atual quando o tema muda: as variantes mudam por tema. */
function ensureThemeSubscription() {
  if (subscribed) return;
  subscribed = true;
  let lastTheme = store.state.theme;
  // Assinatura permanente de propósito: o accent precisa acompanhar o tema em
  // qualquer tela depois de aplicado (inline style vence o [data-theme='light']).
  store.subscribe((s) => {
    if (s.theme === lastTheme) return;
    lastTheme = s.theme;
    applyAccent(current, s.theme);
  });
}

/** Aplica (ou, para 'gold', limpa) as variáveis de destaque no <html>. */
export function applyAccent(id, theme = store.state.theme) {
  ensureThemeSubscription();
  const accent = ACCENTS.find((a) => a.id === id) || ACCENTS[0];
  current = accent.id;
  const style = document.documentElement.style;
  if (accent.id === 'gold') {
    for (const v of VARS) style.removeProperty(`--${v}`);
    return accent.id;
  }
  const set = theme === 'light' ? accent.light : accent.dark;
  for (const v of VARS) style.setProperty(`--${v}`, set[v]);
  return accent.id;
}

export function readSavedAccent() {
  try {
    const id = localStorage.getItem(ACCENT_KEY);
    return isValid(id) ? id : null;
  } catch {
    return null; // localStorage bloqueado: vale o que está no store
  }
}

export function saveAccent(id) {
  try {
    localStorage.setItem(ACCENT_KEY, id);
  } catch {
    /* sem persistência: vale só nesta sessão */
  }
}

/** Lê o accent salvo, grava em store.state.tenant.brand.accent e aplica. */
export function applySavedAccent() {
  const brand = store.state.tenant.brand;
  const id = readSavedAccent() || (isValid(brand.accent) ? brand.accent : 'gold');
  // Mutação direta (sem update): é leitura de preferência no boot, nada a re-renderizar.
  brand.accent = id;
  return applyAccent(id);
}
