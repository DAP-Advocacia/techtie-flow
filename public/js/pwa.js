// App instalável (PWA): registra o service worker e controla o botão "Instalar app".
// Android/Chrome: o navegador avisa (beforeinstallprompt) e o botão abre o diálogo nativo.
// iPhone/Safari: não há diálogo programático; o botão explica "Compartilhar → Adicionar à Tela de Início".
import { toast } from './ui.js';

let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // guarda para abrir quando o usuário clicar no botão
  deferred = e;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Mostra o botão "Instalar app"? (não aparece se já está instalado/aberto como app) */
export const shouldOffer = () => !isStandalone() && (!!deferred || isIOS());

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function install() {
  if (deferred) {
    const prompt = deferred;
    deferred = null;
    notify();
    prompt.prompt();
    await prompt.userChoice.catch(() => {});
    return;
  }
  toast('No iPhone: toque em Compartilhar (quadrado com seta) e depois em "Adicionar à Tela de Início".', 7000);
}

/** Registra o service worker (só em HTTPS ou localhost; sem ele o app continua funcionando normal). */
export function register() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
