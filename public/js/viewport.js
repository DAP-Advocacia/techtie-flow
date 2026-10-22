// Acompanha a área REALMENTE visível da tela. No celular o teclado e as barras do navegador encolhem a área visível sem
// mudar o `100vh`; então modais e gavetas (que se medem por --vvh/--vvt, ver base.css) deixavam os botões de baixo
// atrás do teclado. Aqui a medida é atualizada a cada mudança, e o campo que ganha foco dentro de um modal é trazido à vista.

/** Grava --vvh (altura visível) e --vvt (deslocamento do topo visível) na raiz da página. */
export function syncViewport() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  if (!Number.isFinite(height) || height <= 0) return; // sem medida confiável: ficam os valores de base.css (100dvh)
  const root = document.documentElement;
  root.style.setProperty('--vvh', `${Math.round(height)}px`);
  root.style.setProperty('--vvt', `${Math.round(vv?.offsetTop || 0)}px`);
}

export function trackViewport() {
  syncViewport();
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  // o teclado demora um instante para abrir: depois dele, o campo em foco volta para o meio da área visível
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t?.matches?.('input, textarea, select') || !t.closest?.('[role="dialog"], .palette')) return;
    setTimeout(() => t.isConnected && t.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 320);
  });
}
