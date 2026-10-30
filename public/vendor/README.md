# Bibliotecas de terceiros (servidas como estão)

## three.min.js — Three.js 0.187.0 (MIT, ver `three.LICENSE.txt`)

Pacote só com as classes que o mascote usa (`scripts/three-entry.js`), gerado com tree-shaking. Para regerar ou atualizar:

```bash
mkdir /tmp/three && cd /tmp/three && npm pack three@<versão> && tar -xzf three-*.tgz
sed "s#from 'three'#from './package/build/three.module.js'#" <repo>/scripts/three-entry.js > entry.js
npx esbuild entry.js --bundle --minify --format=esm --legal-comments=none --outfile=<repo>/public/vendor/three.min.js
```

Adicionou uma classe nova no mascote? Inclua-a em `scripts/three-entry.js` e regere.
