// Gera dist/ para hospedar o protótipo como site ESTÁTICO (ex.: Vercel).
// O navegador importa módulos de dois lugares: /js, /css (public/) e /shared/permissions
// (motor de permissões, que o backend também usa). Em hospedagem estática só existe UMA pasta
// de saída, então juntamos as duas: dist/ = public/ + dist/shared/ = shared/.
// (O src/server.js faz o mesmo mapeamento em tempo de execução para o desenvolvimento local.)
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'public'), dist, { recursive: true });
cpSync(join(root, 'shared'), join(dist, 'shared'), { recursive: true });

// Conferência: toda referência absoluta ("/js/…", "/shared/…", "/css/…") dentro de dist/ precisa existir.
// Falha o build se o site publicado fosse quebrar por arquivo ausente.
const refs = /(?:from\s+|import\s*\(\s*|@import\s+url\(\s*|href=|src=)['"]?(\/(?:js|css|shared)\/[^'")\s]+)/g;
const missing = new Set();
let files = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(js|css|html)$/.test(name)) {
      files++;
      for (const m of readFileSync(full, 'utf8').matchAll(refs)) {
        const target = join(dist, m[1].split(/[?#]/)[0]);
        if (!existsSync(target)) missing.add(`${m[1]}  (em ${full.slice(dist.length + 1)})`);
      }
    }
  }
};
walk(dist);

if (missing.size) {
  console.error('[build-static] referências absolutas sem arquivo correspondente:\n  ' + [...missing].join('\n  '));
  process.exit(1);
}
console.log(`[build-static] dist/ pronto: ${files} arquivos .js/.css/.html conferidos, nenhuma referência quebrada.`);
