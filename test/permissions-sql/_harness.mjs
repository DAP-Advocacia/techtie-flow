// Infra dos testes SQL: detecta Docker/pg, sobe um Postgres DESCARTÁVEL
// (postgres:16-alpine, nome ttf-pgtest-*, porta livre aleatória), aplica a
// migração e entrega pools como superusuário (seed) e como app_user (o que a
// aplicação usa). O contêiner é SEMPRE removido (dispose, exit e sinais).
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const MIGRATION = path.join(repoRoot, 'db', 'migrations', '0001_permissions.sql');
export const IMAGE = 'postgres:16-alpine';
const ADMIN_PW = 'ttf-admin-pw';
export const APP_PW = 'ttf-app-pw';

const docker = (args, timeout = 20000) => spawnSync('docker', args, { encoding: 'utf8', timeout });

async function loadPg() {
  try {
    const m = await import('pg');
    return m.default ?? m;
  } catch {
    // Fallback: TTF_PG_PATH = caminho absoluto de um node_modules/pg instalado fora do repo.
    if (process.env.TTF_PG_PATH) {
      try {
        return createRequire(pathToFileURL(path.join(process.env.TTF_PG_PATH, 'x.js')))(process.env.TTF_PG_PATH);
      } catch {
        /* cai no null */
      }
    }
    return null;
  }
}

/** { skip: string|false, pg } — skip explica por que os testes devem ser pulados. */
export async function detectEnv() {
  if (process.env.TTF_SKIP_SQL_TESTS) return { skip: 'TTF_SKIP_SQL_TESTS definido', pg: null };
  const pg = await loadPg();
  if (!pg) return { skip: "módulo 'pg' não encontrado (rode npm install ou defina TTF_PG_PATH)", pg: null };
  const info = docker(['info', '--format', '{{.ServerVersion}}'], 10000);
  if (info.error || info.status !== 0) return { skip: 'Docker indisponível (docker info falhou/expirou): testes SQL pulados', pg };
  const img = docker(['image', 'inspect', IMAGE], 10000);
  if (img.status !== 0) return { skip: `imagem ${IMAGE} não está baixada localmente (docker pull ${IMAGE})`, pg };
  return { skip: false, pg };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const live = new Set();
let hooked = false;
function removeAll() {
  for (const name of live) docker(['rm', '-f', '-v', name], 20000);
  live.clear();
}
function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', removeAll);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { removeAll(); process.exit(1); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sobe o contêiner, aplica a migração (como administrador, que assume app_owner
 * por SET ROLE) e define a senha do app_user.
 * @returns {{ pg, name, port, admin: Pool, app: Pool, appPool: (opts)=>Pool, applyMigration: ()=>Promise, dispose: ()=>Promise }}
 */
export async function startPostgres(pg, tag, { migrate = true } = {}) {
  hook();
  let name;
  let port;
  for (let attempt = 0; attempt < 5; attempt++) {
    port = await freePort();
    name = `ttf-pgtest-${process.pid}-${tag}-${port}`;
    live.add(name);
    const r = docker([
      'run', '-d', '--name', name, '--tmpfs', '/var/lib/postgresql/data',
      '-e', `POSTGRES_PASSWORD=${ADMIN_PW}`, '-p', `127.0.0.1:${port}:5432`, IMAGE,
      '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=100',
    ]);
    if (r.status === 0) break;
    live.delete(name);
    docker(['rm', '-f', name]);
    name = null;
    if (attempt === 4) throw new Error('docker run falhou: ' + (r.stderr || r.error));
  }

  const adminCfg = { host: '127.0.0.1', port, user: 'postgres', password: ADMIN_PW, database: 'postgres' };
  const admin = new pg.Pool({ ...adminCfg, max: 4 });
  admin.on('error', () => {});
  const pools = [admin];
  const dispose = async () => {
    for (const p of pools) await p.end().catch(() => {});
    docker(['rm', '-f', '-v', name]);
    live.delete(name);
    // higiene: o contêiner TEM que ter sumido (docker ps -a)
    if (containerExists(name)) throw new Error(`contêiner ${name} não foi removido`);
  };

  try {
    // O TCP só abre quando o servidor FINAL sobe (o temporário da init só escuta por socket).
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      try {
        await admin.query('SELECT 1');
        ready = true;
      } catch {
        await sleep(500);
      }
    }
    if (!ready) throw new Error('Postgres não ficou pronto a tempo');

    const applyMigration = async () => {
      const sql = fs.readFileSync(MIGRATION, 'utf8');
      const c = await admin.connect();
      let failed = false;
      try {
        await c.query(sql);
      } catch (e) {
        failed = true;
        await c.query('ROLLBACK').catch(() => {}); // o script abre BEGIN: não devolver conexão em transação abortada
        throw e;
      } finally {
        c.release(failed);
      }
    };
    const harness = {
      pg, name, port, admin, applyMigration, dispose,
      appPool: (opts = {}) => {
        const p = new pg.Pool({ host: '127.0.0.1', port, user: 'app_user', password: APP_PW, database: 'postgres', max: 4, ...opts });
        p.on('error', () => {});
        pools.push(p);
        return p;
      },
    };
    if (migrate) {
      await applyMigration();
      await admin.query(`ALTER ROLE app_user PASSWORD '${APP_PW}'`);
    }
    harness.app = harness.appPool();
    return harness;
  } catch (err) {
    await dispose();
    throw err;
  }
}

/** Confere que o contêiner sumiu (usado no teste final de higiene). */
export function containerExists(name) {
  const r = docker(['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}']);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).includes(name);
}

/** Executa fn(client) numa transação de superusuário com app.tenant_id setado (necessário
 *  para os triggers SECURITY DEFINER da closure, que rodam como app_owner sob FORCE RLS). */
export async function adminTx(admin, tenantId, fn) {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** PRNG determinístico (sem Math.random). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gera UUIDs v4-formatados determinísticos a partir de um PRNG. */
export function uuidGen(rng) {
  const hex = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(rng() * 16).toString(16);
    return s;
  };
  return () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}
