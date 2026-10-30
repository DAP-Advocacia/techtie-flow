// Mascote "Flow" em 3D de verdade (Three.js). Corpo esférico com pelo (brilho de tecido), orelhas pontudas, pés, olhos, bochechas e boca
// presos à SUPERFÍCIE do corpo: tudo é filho do grupo `body`, que é a única peça que gira. As luzes ficam paradas no mundo, então o
// brilho escorrega pela bola quando ela vira — é isso que dá a profundidade.
// `buildModel(T)` só monta a cena (testável em Node, sem WebGL). `loadMascot3D()` cria o renderizador e carrega a biblioteca sob demanda;
// devolve null quando não há WebGL (o mascote então usa o desenho SVG).

const THREE_URL = '../../vendor/three.min.js';
const SIZE = 420; // lado do buffer de desenho (px); o CSS reduz ou amplia

/** Há WebGL neste navegador? (resultado guardado) */
let webgl = null;
export function canWebGL() {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext && (c.getContext('webgl2') || c.getContext('webgl'));
    webgl = !!gl;
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Monta o modelo. Devolve { root, body, face, mood, setMood, update, pulse }. */
export function buildModel(T) {
  const root = new T.Group();
  const body = new T.Group(); // a única peça que gira
  root.add(body);

  // ---------- materiais ----------
  const fur = new T.MeshPhysicalMaterial({ color: 0x8b5cf6, roughness: 0.62, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 1, sheenColor: new T.Color(0xffb8f2), sheenRoughness: 0.35 });
  const furDark = new T.MeshPhysicalMaterial({ color: 0x6a3fd6, roughness: 0.7, sheen: 1, sheenColor: new T.Color(0xd9a8ff), sheenRoughness: 0.4 });
  const pink = new T.MeshStandardMaterial({ color: 0xff8fd0, roughness: 0.8, emissive: 0x6b1a52, emissiveIntensity: 0.35 });
  const ink = new T.MeshPhysicalMaterial({ color: 0x160a36, roughness: 0.12, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 });
  const white = new T.MeshBasicMaterial({ color: 0xffffff });
  const cheekMat = new T.MeshStandardMaterial({ color: 0xff7fc4, roughness: 1, transparent: true, opacity: 0.8 });
  const heartMat = new T.MeshBasicMaterial({ color: 0xff4f9c });
  const halo = new T.MeshBasicMaterial({ color: 0xb794ff, transparent: true, opacity: 0.16, side: T.BackSide });

  const unit = new T.SphereGeometry(1, 32, 20); // esfera de raio 1, reaproveitada (escalada) em olhos, pés, bochechas, pelinhos…
  const Z = new T.Vector3(0, 0, 1);
  const Y = new T.Vector3(0, 1, 0);
  /** Põe `obj` na superfície, na direção `dir` (a 'frente' do objeto, +z, aponta para fora). */
  const place = (obj, dir, r) => {
    const v = new T.Vector3(...dir).normalize();
    obj.position.copy(v).multiplyScalar(r);
    obj.quaternion.setFromUnitVectors(Z, v);
    return obj;
  };

  // ---------- corpo ----------
  body.add(new T.Mesh(new T.SphereGeometry(1, 72, 52), fur));
  body.add(new T.Mesh(new T.SphereGeometry(1.07, 40, 28), halo)); // borda macia, como pelo

  // pelinhos espalhados (menos na frente, onde fica o rosto): dão a silhueta felpuda
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tuftGeo = new T.ConeGeometry(0.075, 0.22, 6);
  for (let i = 0; i < 46; i++) {
    const a = rnd() * Math.PI * 2;
    const y = rnd() * 1.7 - 0.95;
    const rad = Math.sqrt(1 - y * y);
    const dir = [Math.cos(a) * rad, y, Math.sin(a) * rad];
    if (dir[2] > 0.5 || y > 0.8) continue;
    const tuft = new T.Mesh(tuftGeo, furDark);
    const v = new T.Vector3(...dir);
    tuft.position.copy(v).multiplyScalar(1.0);
    tuft.quaternion.setFromUnitVectors(Y, v);
    tuft.scale.setScalar(0.7 + rnd() * 0.7);
    body.add(tuft);
  }

  // pés
  for (const x of [-1, 1]) {
    const foot = new T.Mesh(unit, furDark);
    foot.scale.set(0.3, 0.17, 0.38);
    foot.position.set(x * 0.4, -0.9, 0.3);
    body.add(foot);
  }

  // orelhas pontudas: cada uma tem um pivô na base (preso ao corpo), então só tremem a partir dali
  const ears = [];
  for (const side of [-1, 1]) {
    const pivot = new T.Group();
    pivot.position.set(side * 0.55, 0.8, 0.04);
    pivot.rotation.z = -side * 0.4;
    pivot.rotation.x = -0.08;
    const outer = new T.Mesh(new T.ConeGeometry(0.36, 0.95, 28, 1), fur);
    outer.scale.z = 0.6;
    outer.position.y = 0.4;
    const inner = new T.Mesh(new T.ConeGeometry(0.22, 0.66, 28, 1), pink);
    inner.scale.z = 0.5;
    inner.position.set(0, 0.34, 0.08);
    pivot.add(outer, inner);
    body.add(pivot);
    ears.push({ pivot, base: pivot.rotation.z, side });
  }

  // ---------- sombra no chão (não gira) ----------
  const N = 64;
  const px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot((x + 0.5) / N - 0.5, (y + 0.5) / N - 0.5) * 2;
      const a = Math.max(0, 1 - d);
      px.set([20, 6, 50, Math.round(255 * a * a * 0.65)], (y * N + x) * 4);
    }
  }
  const tex = new T.DataTexture(px, N, N);
  tex.magFilter = T.LinearFilter;
  tex.minFilter = T.LinearFilter;
  tex.needsUpdate = true;
  const shadow = new T.Mesh(new T.CircleGeometry(1.15, 32), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -1.12;
  root.add(shadow);

  // ---------- luzes (paradas no mundo) ----------
  root.add(new T.HemisphereLight(0xf0e4ff, 0x4a208f, 1.1));
  const key = new T.DirectionalLight(0xffffff, 2.6);
  key.position.set(-2.2, 3, 3.5);
  const rim = new T.DirectionalLight(0xff9de8, 1.9);
  rim.position.set(2.6, 1.2, -2.2);
  const bounce = new T.PointLight(0xff8fe0, 1.4, 6);
  bounce.position.set(0.4, -2, 2.4);
  root.add(key, rim, bounce);

  // ---------- rosto: tudo preso à superfície do corpo ----------
  const face = new T.Group();
  body.add(face);
  let eyeGroups = [];

  const eye = (x, k = 1) => {
    const g = new T.Group();
    const m = new T.Mesh(unit, ink);
    m.scale.set(0.115 * k, 0.15 * k, 0.06);
    const h1 = new T.Mesh(unit, white);
    h1.scale.setScalar(0.037 * k);
    h1.position.set(0.04 * k, 0.065 * k, 0.05);
    const h2 = new T.Mesh(unit, white);
    h2.scale.setScalar(0.017 * k);
    h2.position.set(-0.035 * k, -0.06 * k, 0.05);
    g.add(m, h1, h2);
    eyeGroups.push(g);
    return place(g, [x, 0.12, 0.93], 0.985);
  };
  const arc = (r, tube, angle, rotZ) => {
    const m = new T.Mesh(new T.TorusGeometry(r, tube, 8, 28, angle), ink);
    m.rotation.z = rotZ;
    const g = new T.Group();
    g.add(m);
    return g;
  };
  const bar = (len) => {
    const m = new T.Mesh(new T.CapsuleGeometry(0.016, len, 4, 8), ink);
    const g = new T.Group();
    g.add(m);
    return { g, m };
  };
  const heart = () => {
    const sh = new T.Shape();
    sh.moveTo(0.25, 0.25);
    sh.bezierCurveTo(0.25, 0.25, 0.2, 0, 0, 0);
    sh.bezierCurveTo(-0.3, 0, -0.3, 0.35, -0.3, 0.35);
    sh.bezierCurveTo(-0.3, 0.55, -0.1, 0.77, 0.25, 0.95);
    sh.bezierCurveTo(0.6, 0.77, 0.8, 0.55, 0.8, 0.35);
    sh.bezierCurveTo(0.8, 0.35, 0.8, 0, 0.5, 0);
    sh.bezierCurveTo(0.35, 0, 0.25, 0.25, 0.25, 0.25);
    const geo = new T.ShapeGeometry(sh);
    geo.translate(-0.25, -0.47, 0);
    geo.scale(0.2, 0.2, 0.2);
    return new T.Group().add(new T.Mesh(geo, heartMat));
  };
  const cheeks = (opacity) => {
    for (const x of [-1, 1]) {
      const c = new T.Mesh(unit, cheekMat.clone());
      c.material.opacity = opacity;
      c.scale.set(0.15, 0.09, 0.03);
      face.add(place(c, [x * 0.62, -0.1, 0.78], 0.99));
    }
  };
  const brow = (x, rot) => {
    const { g, m } = bar(0.1);
    m.rotation.z = Math.PI / 2 + rot;
    face.add(place(g, [x, 0.42, 0.82], 0.99));
  };
  const mouthOpen = () => {
    const g = new T.Group();
    const m = new T.Mesh(unit, ink);
    m.scale.set(0.15, 0.11, 0.05);
    const tongue = new T.Mesh(unit, pink);
    tongue.scale.set(0.085, 0.045, 0.03);
    tongue.position.set(0, -0.05, 0.03);
    g.add(m, tongue);
    face.add(place(g, [0, -0.25, 0.96], 0.985));
  };
  const smile = (r = 0.1, rot = Math.PI, y = -0.2) => face.add(place(arc(r, 0.022, Math.PI, rot), [0, y, 0.97], 0.995));

  function build(mood) {
    for (const c of [...face.children]) {
      face.remove(c);
      c.traverse((o) => o.geometry && o !== undefined && o.geometry !== unit && o.geometry.dispose?.());
    }
    eyeGroups = [];
    switch (mood) {
      case 'sleep':
        face.add(place(arc(0.075, 0.02, Math.PI, Math.PI), [-0.36, 0.14, 0.93], 0.995), place(arc(0.075, 0.02, Math.PI, Math.PI), [0.36, 0.14, 0.93], 0.995));
        smile(0.045, Math.PI, -0.2);
        cheeks(0.6);
        break;
      case 'wow':
        face.add(eye(-0.36, 1.25), eye(0.36, 1.25));
        {
          const m = new T.Mesh(unit, ink);
          m.scale.set(0.065, 0.085, 0.04);
          face.add(place(new T.Group().add(m), [0, -0.25, 0.96], 0.985));
        }
        cheeks(0.8);
        break;
      case 'think':
        face.add(eye(-0.36), eye(0.36));
        {
          const { g, m } = bar(0.13);
          m.rotation.z = Math.PI / 2;
          face.add(place(g, [0.05, -0.22, 0.97], 0.995));
        }
        brow(0.38, -0.35);
        cheeks(0.7);
        break;
      case 'confused':
        face.add(eye(-0.36), eye(0.36));
        face.add(place(arc(0.05, 0.018, Math.PI, Math.PI), [-0.07, -0.2, 0.97], 0.995), place(arc(0.05, 0.018, Math.PI, 0), [0.07, -0.18, 0.97], 0.995));
        brow(0.38, -0.3);
        cheeks(0.7);
        break;
      case 'love':
        for (const x of [-0.36, 0.36]) {
          const hh = heart();
          eyeGroups.push(hh);
          face.add(place(hh, [x, 0.13, 0.93], 1.0));
        }
        smile();
        cheeks(1);
        break;
      case 'laugh':
        face.add(place(arc(0.085, 0.022, Math.PI, 0), [-0.36, 0.1, 0.93], 0.995), place(arc(0.085, 0.022, Math.PI, 0), [0.36, 0.1, 0.93], 0.995));
        mouthOpen();
        cheeks(0.95);
        break;
      case 'sad':
        face.add(eye(-0.36), eye(0.36));
        face.add(place(arc(0.08, 0.02, Math.PI, 0), [0, -0.3, 0.95], 0.995));
        brow(-0.38, 0.4);
        brow(0.38, -0.4);
        cheeks(0.35);
        break;
      default:
        face.add(eye(-0.36), eye(0.36));
        smile();
        cheeks(0.8);
    }
  }

  // ---------- movimento ----------
  const st = { mood: 'happy', t: 0, react: 9, blink: 0, nextBlink: 3, rx: 0, ry: 0, shake: 0 };
  build('happy');

  /** Troca a expressão e dá um "pulinho" (também quando a expressão é a mesma: é uma reação). */
  function setMood(mood) {
    st.mood = mood;
    st.react = 0;
    st.shake = mood === 'laugh' ? 1.2 : 0;
    build(mood);
  }

  function pulse() {
    st.react = 0;
  }

  /** Avança `dt` segundos; (lx, ly) é a direção do cursor em [-1, 1]; `still` para movimento reduzido. */
  function update({ dt = 0.016, lx = 0, ly = 0, still = false }) {
    st.t += dt;
    const k = still ? 1 : 1 - Math.exp(-dt * 9);
    st.ry += (lx * 0.72 - st.ry) * k;
    st.rx += (ly * 0.46 - st.rx) * k;
    const sleepy = st.mood === 'sleep';
    const bob = still ? 0 : Math.sin(st.t * (sleepy ? 1.1 : 2.1)) * 0.045;
    st.react += dt;
    const r = st.react < 0.7 ? Math.sin(st.react * Math.PI * 4.5) * (1 - st.react / 0.7) * 0.1 : 0;
    st.shake = Math.max(0, st.shake - dt);
    body.rotation.y = st.ry;
    body.rotation.x = st.rx;
    body.rotation.z = still ? 0 : Math.sin(st.t * 34) * 0.035 * Math.min(1, st.shake);
    body.position.y = bob;
    body.scale.set(1 - r * 0.55, 1 + r, 1 - r * 0.55);
    shadow.scale.setScalar(1 - bob * 1.6);
    // orelhas: tremidinha ocasional a partir da base presa ao corpo
    for (const e of ears) {
      const burst = Math.max(0, Math.sin(st.t * 0.9 + (e.side > 0 ? 0.4 : 0)) - 0.93) * 14;
      e.pivot.rotation.z = e.base + (still ? 0 : Math.sin(st.t * 22) * burst * 0.09);
    }
    // piscar
    if (!still && eyeGroups.length && st.mood !== 'love') {
      st.nextBlink -= dt;
      if (st.nextBlink <= 0) {
        st.blink = 0.13;
        st.nextBlink = 2.6 + ((st.t * 997) % 1) * 3.2;
      }
    }
    st.blink = Math.max(0, st.blink - dt);
    for (const g of eyeGroups) g.scale.y = st.mood === 'love' ? 1 + Math.sin(st.t * 6) * 0.06 : st.blink > 0 ? 0.1 : 1;
    if (st.mood === 'love') for (const g of eyeGroups) g.scale.x = g.scale.y;
  }

  return { root, body, face, get mood() { return st.mood; }, setMood, update, pulse };
}

// ---------- renderizador (uma única instância; o canvas troca de lugar na página) ----------
let cache = null;
const lostHandlers = new Set();

/** Avisa quando o contexto WebGL for perdido (o mascote volta ao desenho SVG). */
export function onMascot3DLost(fn) {
  lostHandlers.add(fn);
  return () => lostHandlers.delete(fn);
}

const reducedMotion = () => {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** Carrega (uma vez) o 3D. Resolve com { canvas, mood, setMood, pulse, setLook, start } ou null se não houver WebGL/falhar. */
export function loadMascot3D() {
  if (cache) return cache;
  cache = (async () => {
    if (!canWebGL()) return null;
    const T = await import(THREE_URL);
    const canvas = document.createElement('canvas');
    canvas.className = 'mascot-3d';
    canvas.width = canvas.height = SIZE;
    canvas.setAttribute('aria-hidden', 'true');
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    const scene = new T.Scene();
    const model = buildModel(T);
    scene.add(model.root);
    const camera = new T.PerspectiveCamera(28, 1, 0.1, 50);
    camera.position.set(0, 0.3, 6.6);
    camera.lookAt(0, 0.2, 0);

    let raf = 0;
    let last = 0;
    let dead = false;
    const look = { x: 0, y: 0 };
    const frame = (now) => {
      raf = 0;
      if (dead || !canvas.isConnected || document.hidden) return; // parado; start() religa
      const still = reducedMotion();
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      model.update({ dt, lx: look.x, ly: look.y, still });
      renderer.render(scene, camera);
      if (!still) raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf || dead) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', () => !document.hidden && start());
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      dead = true;
      cache = null;
      for (const fn of [...lostHandlers]) fn();
    });

    return {
      canvas,
      get mood() {
        return model.mood;
      },
      setMood(m) {
        model.setMood(m);
        start();
      },
      pulse() {
        model.pulse();
        start();
      },
      setLook(x, y) {
        look.x = x;
        look.y = y;
        start();
      },
      start,
    };
  })().catch(() => null);
  return cache;
}
