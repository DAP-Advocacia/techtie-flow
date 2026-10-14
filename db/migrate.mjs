// Aplica as migrações de db/migrations/*.sql em ordem, uma vez cada.
//   node db/migrate.mjs                 # usa DIRECT_URL (conexão de sessão, porta 5432)
// Variáveis: DIRECT_URL (administrador, ex.: `postgres` do Supabase), APP_USER_PASSWORD (opcional:
// define a senha do papel `app_user`, usado em DATABASE_URL pela aplicação).
// Cada arquivo roda numa única chamada (eles trazem o próprio BEGIN/COMMIT quando precisam).
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
try {
  process.loadEnvFile?.();
} catch {
  /* sem .env */
}
const { Client } = require('pg');

const url = process.env.DIRECT_URL;
if (!url) {
  console.error('DIRECT_URL ausente (conexão de administrador, porta 5432).');
  process.exit(1);
}
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) {
      console.log(`= ${f} (já aplicada)`);
      continue;
    }
    console.log(`> aplicando ${f} …`);
    await client.query(readFileSync(path.join(dir, f), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    console.log(`  ok`);
  }
  if (process.env.APP_USER_PASSWORD) {
    const { rows } = await client.query('SELECT format($1, $2::text) AS q', ['ALTER ROLE app_user PASSWORD %L', process.env.APP_USER_PASSWORD]);
    await client.query(rows[0].q);
    console.log('senha do papel app_user definida');
  }
} catch (err) {
  console.error('FALHA na migração:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
