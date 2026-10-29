// Cor de destaque (white-label). Sobrescreve --acc/--acc2/--dim/--bar em
// <html style> por cima dos tokens do tema; "champagne" (padrão) apenas REMOVE
// os overrides, deixando tokens.css mandar (assim claro/escuro seguem corretos).
//
// Persistência: localStorage['ttf:accent'] guarda o id ('gold'|'green'|'blue'|'red').
// ATENÇÃO: app.js precisa chamar applySavedAccent() no boot; enquanto isso não
// acontece, o accent salvo só é reaplicado ao abrir a tela de Configurações.
import { store } from '../../store.js';

export const ACCENT_KEY = 'ttf:accent';

// Há um tema só (claro). O id 'gold' é o padrão (por herança de nome; hoje é o ciano do Bitrix
// e espelha tokens.css, usado só na amostra, já que o padrão é aplicado removendo overrides).
// Os demais são opções white-label, com variantes de ênfase, discreta e de barra.
export const ACCENTS = [
  {
    id: 'gold',
    name: 'Ciano',
    light: { acc: '#0066a1', acc2: '#004f80', dim: '#7fb7d6', bar: '#2fc7f7' },
  },
  {
    id: 'blue',
    name: 'Azul',
    light: { acc: '#2d6fc0', acc2: '#1f5599', dim: '#8fb3d6', bar: '#409eef' },
  },
  {
    id: 'green',
    name: 'Verde',
    light: { acc: '#2f8f58', acc2: '#23724a', dim: '#7fb896', bar: '#8fc9a6' },
  },
  {
    id: 'champagne',
    name: 'Dourado',
    light: { acc: '#8a6d2f', acc2: '#6f5622', dim: '#b9a572', bar: '#c4ad74' },
  },
  {
    id: 'red',
    name: 'Vermelho',
    light: { acc: '#c0504a', acc2: '#9e3c37', dim: '#d89a96', bar: '#deaaa6' },
  },
];

const VARS = ['acc', 'acc2', 'dim', 'bar'];
const isValid = (id) => ACCENTS.some((a) => a.id === id);

// Accent atualmente aplicado no <html> (pode ser uma prévia ainda não salva).
let current = 'gold';

/** Aplica (ou, para 'gold', limpa) as variáveis de destaque no <html>. */
export function applyAccent(id) {
  const accent = ACCENTS.find((a) => a.id === id) || ACCENTS[0];
  current = accent.id;
  const style = document.documentElement.style;
  if (accent.id === 'gold') {
    for (const v of VARS) style.removeProperty(`--${v}`);
    return accent.id;
  }
  const set = accent.light;
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
