// QR Code de DEMONSTRAÇÃO: matriz determinística (mesma semente = mesmo
// desenho) com os elementos que fazem um QR "parecer" QR (3 marcadores de
// canto, linhas de sincronismo, marcador de alinhamento) e o resto
// pseudoaleatório. NÃO codifica nada e não é escaneável — o selo DEMO deixa
// isso explícito. Em produção, o gateway devolve a string do QR do Baileys.
const SVG_NS = 'http://www.w3.org/2000/svg';
const N = 29; // módulos por lado (equivale a um QR versão 3)
const QUIET = 2; // margem em módulos

export function hashSeed(str) {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

// mulberry32: PRNG pequeno e determinístico.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function qrMatrix(seed) {
  const rand = rng(hashSeed(seed));
  const m = Array.from({ length: N }, () => new Array(N).fill(false));
  const fixed = Array.from({ length: N }, () => new Array(N).fill(false));
  const set = (x, y, v) => {
    m[y][x] = v;
    fixed[y][x] = true;
  };

  // Marcador de canto 7x7 + separador claro de 1 módulo ao redor.
  const finder = (ox, oy) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        set(x, y, inside && (ring || core));
      }
    }
  };
  finder(0, 0);
  finder(N - 7, 0);
  finder(0, N - 7);

  // Linhas de sincronismo.
  for (let i = 8; i < N - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  // Marcador de alinhamento 5x5 centrado em (N-7, N-7).
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const edge = Math.max(Math.abs(dx), Math.abs(dy));
      set(N - 7 + dx, N - 7 + dy, edge !== 1);
    }
  }

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!fixed[y][x]) m[y][x] = rand() < 0.48;
  return m;
}

/**
 * <svg> do QR demo. As cores são fixas (escuro sobre claro) de propósito: um QR
 * precisa de contraste dark-on-light para ser lido, independentemente do tema.
 */
export function qrSvg(seed) {
  const m = qrMatrix(seed);
  let d = '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m[y][x]) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
  const size = N + QUIET * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR Code de demonstração (não é um código real)');
  svg.classList.add('instances-qr__svg');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
