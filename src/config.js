'use strict';
// Configuração por variáveis de ambiente (arquivo .env local ou painel do servidor).
// Nada de segredo no código: ver .env.example.
try {
  process.loadEnvFile?.(); // Node >= 20.12: lê .env se existir (sem dependência)
} catch {
  /* sem .env: usa só o ambiente do processo */
}

const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const config = {
  port: Number(env.PORT || 3333),
  databaseUrl: env.DATABASE_URL || '',
  authSecret: env.AUTH_TOKEN_SECRET || '',
  tokenTtlSeconds: Number(env.AUTH_TOKEN_TTL_HOURS || 12) * 3600,
  authFolder: env.AUTH_FOLDER || './auth_session',
  // origens do front autorizadas a chamar a API (ex.: https://techtie-flow.vercel.app)
  corsOrigins: list(env.CORS_ORIGIN),
  // URL pública do front (link do convite)
  appUrl: (env.APP_URL || '').replace(/\/$/, ''),
  // liga a API/WhatsApp; sem isso o servidor só serve o protótipo estático
  apiEnabled: !!(env.DATABASE_URL && env.AUTH_TOKEN_SECRET),
  whatsappEnabled: env.WHATSAPP_ENABLED !== 'false',
  // Atrás de proxy reverso (EasyPanel, Nginx, Cloudflare) o IP real vem em X-Forwarded-For.
  // Só ligue se HÁ proxy: sem ele, qualquer cliente forjaria o cabeçalho e burlaria os limites.
  trustProxy: env.TRUST_PROXY === 'true',
  // Agente de IA (OpenAI). A chave fica só aqui, no servidor; sem ela a IA simplesmente não responde.
  openaiKey: env.OPENAI_API_KEY || '',
  openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
  aiDailyTokenCap: Number(env.AI_DAILY_TOKEN_CAP || 300000),
};

/** Falha cedo, com mensagem clara, se o ambiente do modo API estiver incompleto/inseguro. */
function assertApiConfig() {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL ausente');
  if (config.authSecret.length < 32) problems.push('AUTH_TOKEN_SECRET precisa ter 32+ caracteres (gere com: node -p "require(\'crypto\').randomBytes(48).toString(\'base64url\')")');
  if (problems.length) throw new Error('Configuração inválida: ' + problems.join('; '));
}

module.exports = { config, assertApiConfig };
