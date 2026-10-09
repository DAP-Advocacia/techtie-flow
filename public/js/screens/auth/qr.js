// QR Code FICTÍCIO: desenha uma matriz pseudo-aleatória determinística com a
// "cara" de um QR (3 marcadores de canto, linhas de sincronismo, marcador de
// alinhamento). Não codifica nada nem é escaneável — a tela o rotula "DEMO".
// Gerado como SVG (sem libs, escala nítida em qualquer tamanho).

const SVG_NS = 'http://www.w3.org/2000/svg';
const N = 29; // equivalente a um QR versão 3

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Matriz N×N de booleanos (true = módulo escuro). Mesma seed, mesmo desenho. */
export function qrMatrix(seed) {
  const rnd = mulberry32(seed);
  const m = Array.from({ length: N }, () => Array(N).fill(null));
  const put = (r, c, v) => {
    if (r >= 0 && c >= 0 && r < N && c < N) m[r][c] = v;
  };

  // Marcadores de canto 7x7 (anel escuro, anel claro, centro 3x3) + separador claro.
  for (const [r0, c0] of [[0, 0], [0, N - 7], [N - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        put(r0 + r, c0 + c, ring <= 3 && ring !== 2);
      }
    }
  }
  // Linhas de sincronismo alternadas.
  for (let i = 8; i < N - 8; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }
  // Marcador de alinhamento 5x5 perto do canto inferior direito.
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) put(N - 9 + r, N - 9 + c, Math.max(Math.abs(r - 2), Math.abs(c - 2)) !== 1);
  }
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) if (m[r][c] === null) m[r][c] = rnd() < 0.5;
  }
  return m;
}

/** <svg> do QR; a cor dos módulos é currentColor (o CSS define --ink). */
export function buildQrSvg(seed) {
  const m = qrMatrix(seed);
  let d = '';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) if (m[r][c]) d += `M${c} ${r}h1v1h-1z`;
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${N} ${N}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR Code de demonstração');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}
