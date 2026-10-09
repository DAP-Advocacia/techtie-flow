// Validação do domínio personalizado e constantes de DNS da plataforma.
export const PLATFORM_CNAME = 'cname.techtie.app';
export const DEFAULT_HOST = 'app.techtie.app';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// TLD só com letras (ou punycode xn--).
const TLD = /^(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$/;

/** Normaliza (trim + minúsculas) e valida. Devolve { value, error }. */
export function validateDomain(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return { value, error: null };
  if (/[\s/:@?#]/.test(value)) {
    return { value, error: 'Informe apenas o domínio, sem https://, espaços nem caminhos (ex.: crm.empresa.com.br).' };
  }
  if (value.length > 253) return { value, error: 'Domínio longo demais (máximo de 253 caracteres).' };
  const labels = value.split('.');
  if (labels.length < 2) return { value, error: 'Domínio incompleto. Use algo como crm.empresa.com.br.' };
  if (labels.some((l) => !l)) return { value, error: 'Há um ponto sobrando ou duplicado no domínio.' };
  if (!labels.every((l) => LABEL.test(l))) {
    return { value, error: 'Use só letras, números e hífens (sem começar ou terminar com hífen; máx. 63 por parte).' };
  }
  if (!TLD.test(labels[labels.length - 1])) return { value, error: 'A terminação do domínio é inválida (ex.: .com.br).' };
  return { value, error: null };
}

/** 'crm.acme.com.br' -> 'crm' (nome do registro CNAME a criar). */
export const cnameHost = (domain) => String(domain).split('.')[0] || domain;
