// Ajudantes do roteador por hash: "#/deal?id=abc" → { id: 'deal', params: { id: 'abc' } }.
// O app.js escolhe a tela só pelo primeiro trecho; os parâmetros são lidos pela própria tela.
export function hashParts() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { id: path.split('/')[0], params: new URLSearchParams(query) };
}
export const hashParam = (key) => hashParts().params.get(key);

/** "#/deal?id=abc" a partir de ('deal', { id: 'abc' }). */
export function linkTo(id, params) {
  const q = params ? new URLSearchParams(params).toString() : '';
  return `#/${id}${q ? `?${q}` : ''}`;
}
