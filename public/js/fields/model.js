// Campos de data, hora e busca de contato em pt-BR. PURO (sem DOM). Testado em test/api/fields-model.test.mjs.
// O <input type="date"> do navegador segue o idioma do NAVEGADOR (mm/dd/aaaa e 12 h em quem usa inglês): aqui a
// pessoa sempre vê dd/mm/aaaa e 24 horas, e o valor que sai continua ISO (aaaa-mm-dd / HH:MM).

/** Digitação → máscara dd/mm/aaaa (só números, barras sozinhas). */
export function maskDate(raw) {
  const d = String(raw ?? '').replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** Digitação → máscara HH:MM. */
export function maskTime(raw) {
  const d = String(raw ?? '').replace(/\D/g, '').slice(0, 4);
  return d.length <= 2 ? d : `${d.slice(0, 2)}:${d.slice(2)}`;
}

/** 'dd/mm/aaaa' → 'aaaa-mm-dd'; '' se incompleta ou se o dia não existe (31/02). */
export function isoFromBr(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text ?? '').trim());
  if (!m) return '';
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  if (y < 1900 || y > 2200 || dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** 'aaaa-mm-dd' → 'dd/mm/aaaa'. */
export function brFromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** 'HH:MM' válido (00:00–23:59) ou ''. Aceita '9:30' e '0930'. */
export function cleanTime(text) {
  const s = String(text ?? '').trim();
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m) return '';
  const [h, mi] = [Number(m[1]), Number(m[2])];
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : '';
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Telefone para leitura: +55 11 98765-4321 (celular), +55 11 3456-7890 (fixo); outros países: como veio. */
export function prettyPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const rest = d.slice(4);
    return `+55 ${d.slice(2, 4)} ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  }
  return `+${d}`;
}

/**
 * Busca de contato por nome, empresa, telefone (qualquer pedaço, com ou sem máscara) e e-mail. Todos os termos
 * precisam aparecer. Quem COMEÇA com o termo vem antes. `limit` corta a lista (o total volta em `total`).
 * @returns {{ items: object[], total: number }}
 */
export function searchContacts(contacts, query, limit = 40) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const scored = [];
  for (const c of contacts) {
    const name = fold(c.name);
    const hay = `${name} ${fold(c.company)} ${fold(c.email)}`;
    const digits = String(c.phone ?? '').replace(/\D/g, '');
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const onlyDigits = /^\d+$/.test(t);
      if (onlyDigits && digits.includes(t)) score += 1;
      else if (name.startsWith(t)) score += 4;
      else if (name.includes(` ${t}`)) score += 3;
      else if (hay.includes(t)) score += 2;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.c.name).localeCompare(String(b.c.name), 'pt-BR'));
  return { items: scored.slice(0, limit).map((x) => x.c), total: scored.length };
}

/** O nome é só o telefone (contato criado pelo WhatsApp sem nome)? */
export const nameIsPhone = (c) => /^[+\d\s().-]{8,}$/.test(String(c?.name ?? '').trim());
