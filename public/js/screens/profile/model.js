// Perfil do usuário — regras PURAS (as mesmas do servidor, PATCH /api/me). Testado em test/api/profile-model.test.mjs.
export const LIMITS = { name: 200, jobTitle: 80, phone: 30, bio: 300 };

const collapse = (s) => String(s ?? '').trim().replace(/[ \t]+/g, ' ');

/** Campos prontos para enviar: sem espaços sobrando; "sobre" mantém as quebras de linha. */
export function normalizeProfile(f) {
  return { name: collapse(f.name), jobTitle: collapse(f.jobTitle), phone: collapse(f.phone), bio: String(f.bio ?? '').replace(/\r\n/g, '\n').trim() };
}

/** Erros por campo ({} se estiver tudo certo). */
export function validateProfile(f) {
  const n = normalizeProfile(f);
  const e = {};
  if (!n.name) e.name = 'Informe o seu nome.';
  else if (n.name.length > LIMITS.name) e.name = `O nome passa de ${LIMITS.name} caracteres.`;
  if (n.jobTitle.length > LIMITS.jobTitle) e.jobTitle = `O cargo passa de ${LIMITS.jobTitle} caracteres.`;
  if (n.phone && !/^[0-9+()\-. ]{6,30}$/.test(n.phone)) e.phone = 'Telefone inválido: use números, +, parênteses e traço.';
  if (n.bio.length > LIMITS.bio) e.bio = `O texto passa de ${LIMITS.bio} caracteres.`;
  return e;
}

/** Só o que mudou em relação ao que está salvo (vazio = nada a salvar). */
export function changedFields(saved, f) {
  const n = normalizeProfile(f);
  const base = normalizeProfile(saved || {});
  return Object.fromEntries(Object.entries(n).filter(([k, v]) => v !== base[k]));
}
