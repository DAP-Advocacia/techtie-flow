// Entrada do pacote do Three.js usado pelo mascote (public/vendor/three.min.js). Só as classes listadas entram (tree-shaking).
// Para regerar: ver public/vendor/README.md.
export {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, SphereGeometry, ConeGeometry, CapsuleGeometry, TorusGeometry, CircleGeometry,
  ShapeGeometry, Shape, MeshStandardMaterial, MeshPhysicalMaterial, MeshBasicMaterial, DirectionalLight, PointLight, HemisphereLight,
  Vector3, Color, MathUtils, SRGBColorSpace, ACESFilmicToneMapping, DataTexture, LinearFilter, BackSide,
} from 'three';
