// Marca TechTie: o "T" que também é uma gravata (tie), em ouro facetado. É a arte oficial (PNG com fundo
// transparente, halo removido) em public/assets — duas resoluções: 192 px (barra lateral, ícones) e 512 px
// (login e tamanhos grandes). O tamanho pedido decide qual carregar.
export const MARK_SRC = { small: '/assets/techtie-mark-192.png', large: '/assets/techtie-mark-512.png' };

/** Elemento <span> com a marca (quadrada), do tamanho (px) pedido. */
export function techtieMark(size = 40) {
  const el = document.createElement('span');
  el.className = 'tt-mark';
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = size > 96 ? MARK_SRC.large : MARK_SRC.small;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  img.style.cssText = 'width:100%;height:100%;display:block;object-fit:contain';
  el.append(img);
  return el;
}
