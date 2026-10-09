const { Pool } = require('pg');

// Máximo de conexões simultâneas deste processo com o pooler do Supabase.
// Configurável via env (DB_POOL_MAX) pra poder ajustar sem rebuild — só
// trocar a variável no EasyPanel e reiniciar o processo. Sem a env
// definida, cai no mesmo default que já era usado antes (10, o default do
// próprio `pg`) — não muda nada pra quem não configurar isso.
//
// O teto real não é "quanto o Node aguenta" (aguenta muito mais que isso),
// é quantas conexões o POOLER do Supabase permite — confirme esse limite
// no painel do Supabase antes de subir este valor; configurar um número
// maior do que o Supabase aceita quebra do mesmo jeito que um valor fixo
// errado quebraria (conexões rejeitadas do lado dele).
const DB_POOL_MAX = Number(process.env.DB_POOL_MAX) || 10;

// Pool compartilhado por toda a aplicação, usando o pooler de transação
// (pgbouncer) do Supabase — ver DATABASE_URL no .env.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: DB_POOL_MAX });

// Sem isso, um erro numa conexão ociosa do pool (ex: o pooler do Supabase
// fechando uma conexão parada) vira um evento 'error' sem listener no
// EventEmitter do Pool, o que DERRUBA o processo Node inteiro — passa por
// cima até do process.on('uncaughtException') do server.js. Só logar aqui é
// suficiente: o pool cria uma conexão nova sozinho na próxima query.
pool.on('error', (err) => {
  console.error('[db] erro numa conexão ociosa do pool (processo mantido no ar):', err.message);
});

module.exports = { pool };
