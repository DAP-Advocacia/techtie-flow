// Marca TechTie: o "T" facetado que também é uma gravata (tie). Vetor inline, sem arquivo de imagem:
// escala sem perder nitidez e herda o tema (ouro no escuro; ouro-escuro no claro, via variáveis CSS).
// O SVG é uma string FIXA (sem dados do usuário), por isso innerHTML é seguro aqui.
// Facetas planas (como metal lapidado): ombros angulares do "T", nó da gravata no centro e lâmina que afina até a ponta.
// A luz vem da esquerda: lado esquerdo claro, direito escuro. Cada polígono é uma face.
const FACES = [
  // ombro esquerdo
  ['hi', 'M3 15 L38 5 L47 14 L24 25 Z'],
  ['mid', 'M24 25 L47 14 L47 31 L29 30 Z'],
  // ombro direito
  ['mid', 'M97 15 L62 5 L53 14 L76 25 Z'],
  ['deep', 'M76 25 L53 14 L53 31 L71 30 Z'],
  // nó da gravata
  ['hi', 'M44 17 L50 13 L50 41 L45 37 Z'],
  ['lo', 'M50 13 L56 17 L55 37 L50 41 Z'],
  // lâmina
  ['hi', 'M45 38 L50 41 L50 72 L37 63 Z'],
  ['mid', 'M37 63 L50 72 L50 115 Z'],
  ['lo', 'M55 38 L50 41 L50 72 L63 63 Z'],
  ['deep', 'M63 63 L50 72 L50 115 Z'],
];

const svg = () => `
<svg viewBox="0 0 100 120" width="100%" height="100%" aria-hidden="true" focusable="false" stroke-linejoin="round">
  ${FACES.map(([tone, d]) => `<path d="${d}" fill="var(--logo-${tone})" stroke="var(--logo-hi)" stroke-opacity=".28" stroke-width=".6"/>`).join('')}
</svg>`;

/** Elemento <span> com a marca, do tamanho (px) pedido. */
export function techtieMark(size = 40) {
  const el = document.createElement('span');
  el.className = 'tt-mark';
  el.style.width = `${size}px`;
  el.style.height = `${Math.round(size * 1.2)}px`;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = svg();
  return el;
}
