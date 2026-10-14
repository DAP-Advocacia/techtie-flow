'use strict';
// Autenticação sem dependências externas: senha com scrypt, token assinado com HMAC-SHA256.
// (O estado de login — senha, tentativas, convite — mora no banco, em funções SECURITY
// DEFINER: ver db/migrations/0002_pilot.sql. Aqui só criptografia e formato do token.)
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SCRYPT_OPTS = { N, r: R, p: P, maxmem: 64 * 1024 * 1024 };

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

/** Regra de senha do piloto: tamanho (10 a 200). Complexidade arbitrária não ajuda; comprimento sim. */
function passwordProblem(password) {
  if (typeof password !== 'string') return 'Senha inválida.';
  if (password.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (password.length > MAX_PASSWORD) return `A senha pode ter no máximo ${MAX_PASSWORD} caracteres.`;
  return null;
}

async function hashPassword(password) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Hash descartável para gastar o mesmo tempo quando o e-mail não existe (evita revelar,
// pelo tempo de resposta, quais e-mails têm conta).
const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split('$');
  const ok = parts.length === 6 && parts[0] === 'scrypt';
  const [, n, r, p, saltB64, keyB64] = ok ? parts : DUMMY.split('$');
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  let got;
  try {
    got = await scrypt(typeof password === 'string' ? password.slice(0, MAX_PASSWORD) : '', salt, expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(got, expected) && ok && !!stored;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Token assinado `cabeçalho.corpo.assinatura` (HS256). `claims` não pode conter exp/iat. */
function signToken(claims, secret, ttlSeconds, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const body = { ...claims, iat, exp: iat + ttlSeconds };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify(body));
  const sig = b64u(crypto.createHmac('sha256', secret).update(`${head}.${payload}`).digest());
  return `${head}.${payload}.${sig}`;
}

/** Valida assinatura, algoritmo e expiração. Devolve as claims ou null (nunca lança). */
function verifyToken(token, secret, nowMs = Date.now()) {
  try {
    const [head, payload, sig, extra] = String(token || '').split('.');
    if (!head || !payload || !sig || extra !== undefined) return null;
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null; // recusa "none" e trocas de algoritmo
    const expected = crypto.createHmac('sha256', secret).update(`${head}.${payload}`).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Token de convite: o valor em claro vai por e-mail; só o SHA-256 vai ao banco. */
function newInviteToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}
const hashInviteToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Limitador em memória (janela deslizante) — freio contra força bruta por IP/e-mail.
 * limiter(key) REGISTRA uma tentativa e devolve se ainda está dentro do limite;
 * limiter.peek(key) só consulta (para contar apenas as tentativas que falharam).
 */
function makeLimiter(max, windowMs) {
  const hits = new Map();
  const limiter = (key, nowMs = Date.now()) => {
    const arr = (hits.get(key) || []).filter((t) => nowMs - t < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(nowMs);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => nowMs - t < windowMs)) hits.delete(k);
    return true;
  };
  limiter.peek = (key, nowMs = Date.now()) => (hits.get(key) || []).filter((t) => nowMs - t < windowMs).length < max;
  return limiter;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, signToken, verifyToken, newInviteToken, hashInviteToken, makeLimiter, MIN_PASSWORD };
