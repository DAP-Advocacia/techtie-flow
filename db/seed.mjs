// Cria o PRIMEIRO tenant e o administrador dele (e o funil inicial). Roda uma vez por tenant.
//   SEED_TENANT_NAME="Escritório X" SEED_TENANT_SLUG=escritorio-x \
//   SEED_ADMIN_NAME="Fulana" SEED_ADMIN_EMAIL=fulana@empresa.com.br SEED_ADMIN_PASSWORD='…' \
//   node db/seed.mjs
// Usa DIRECT_URL (administrador). A senha vem SÓ do ambiente: nunca em argumento nem em log.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
try {
  process.loadEnvFile?.();
} catch {
  /* sem .env */
}
const { Client } = require('pg');
const { hashPassword } = require('../src/auth.js');

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`${k} ausente.`);
    process.exit(1);
  }
  return v;
};
const url = need('DIRECT_URL');
const tenantName = need('SEED_TENANT_NAME');
const slug = need('SEED_TENANT_SLUG');
const adminName = need('SEED_ADMIN_NAME');
const email = need('SEED_ADMIN_EMAIL').trim().toLowerCase();
const password = need('SEED_ADMIN_PASSWORD');

const hash = await hashPassword(password); // valida tamanho da senha

const tenantId = randomUUID();
const adminId = randomUUID();
const teamId = randomUUID();
const funnels = [
  { name: 'Vendas · SDR', stages: [['Novo lead', 'open'], ['Qualificação', 'open'], ['Reunião', 'open'], ['Ganho', 'won']] },
  { name: 'Comercial', stages: [['Proposta', 'open'], ['Negociação', 'open'], ['Fechamento', 'won'], ['Perdido', 'lost']] },
];

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE app_owner'); // dono das tabelas; a RLS vale também para ele (FORCE)
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

  const dup = await client.query('SELECT 1 FROM auth_identities WHERE email_lower = $1', [email]);
  if (dup.rowCount) throw new Error('já existe uma conta com este e-mail');

  await client.query('INSERT INTO tenants (id, name, slug, settings) VALUES ($1, $2, $3, $4)', [tenantId, tenantName, slug, JSON.stringify({ requireMfaForSensitive: false })]);
  await client.query("INSERT INTO users (id, tenant_id, email, name, status) VALUES ($1, $2, $3, $4, 'active')", [adminId, tenantId, email, adminName]);
  await client.query('INSERT INTO auth_identities (user_id, tenant_id, email_lower, password_hash) VALUES ($1, $2, $3, $4)', [adminId, tenantId, email, hash]);
  await client.query("INSERT INTO user_roles (tenant_id, user_id, system_role_id) VALUES ($1, $2, 'role_admin')", [tenantId, adminId]);
  await client.query('INSERT INTO teams (id, tenant_id, name) VALUES ($1, $2, $3)', [teamId, tenantId, 'Equipe Comercial']);
  await client.query('INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1, $2, $3)', [tenantId, teamId, adminId]);
  for (const f of funnels) {
    const pid = randomUUID();
    await client.query('INSERT INTO pipelines (id, tenant_id, name) VALUES ($1, $2, $3)', [pid, tenantId, f.name]);
    let pos = 0;
    let open = 0;
    const nOpen = f.stages.filter(([, k]) => k === 'open').length;
    // probabilidade: ganho 100, perdido 0, abertas espalhadas pelo funil (2 abertas → 33 e 67)
    for (const [name, kind] of f.stages) await client.query('INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, kind, position, probability) VALUES ($1, $2, $3, $4, $5, $6)', [tenantId, pid, name, kind, pos++, kind === 'won' ? 100 : kind === 'lost' ? 0 : Math.round((100 * ++open) / (nOpen + 1))]);
  }
  await client.query('COMMIT');
  console.log(`Tenant "${tenantName}" criado (${tenantId}). Admin: ${email}`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('FALHA no seed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
