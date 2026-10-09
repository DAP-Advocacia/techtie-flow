// Álgebra de predicados — a "linguagem comum" entre decidir sobre UM objeto
// (evaluate) e filtrar uma LISTA (toSql). O motor compila a política de um
// usuário para uma expressão; a mesma expressão roda em JS ou vira WHERE no
// Postgres, então as duas respostas não têm como divergir por construção
// (e o teste diferencial confere isso contra um Postgres de verdade).
//
// Nós (objetos simples, serializáveis em JSON):
//   { t:'true' } | { t:'false' }
//   { t:'and', args:[…] } | { t:'or', args:[…] } | { t:'not', arg }
//   { t:'cmp', field, op, value }   — value já é literal (referências são resolvidas na compilação)
//   { t:'shared', entity, levels, userId, teamIds } — compartilhamento explícito por registro
//
// Semântica DOIS-valorada: toda comparação devolve true/false, nunca NULL.
// (SQL puro é três-valorado: `NOT (col = x)` com col NULL dá NULL e some da
// lista. Aqui cada comparação vira COALESCE/IS DISTINCT FROM para que NOT
// funcione igual em JS e em SQL — é isso que torna negações seguras.)
import { OPERATORS, columnOf } from './catalog.js';

export const TRUE = Object.freeze({ t: 'true' });
export const FALSE = Object.freeze({ t: 'false' });

export const cmp = (field, op, value) => ({ t: 'cmp', field, op, value });
export const shared = (entity, levels, userId, teamIds) => ({ t: 'shared', entity, levels, userId, teamIds });

export function and(...args) {
  const flat = [];
  for (const a of args.flat()) {
    if (a.t === 'false') return FALSE;
    if (a.t === 'true') continue;
    if (a.t === 'and') flat.push(...a.args);
    else flat.push(a);
  }
  if (!flat.length) return TRUE;
  return flat.length === 1 ? flat[0] : { t: 'and', args: flat };
}

export function or(...args) {
  const flat = [];
  for (const a of args.flat()) {
    if (a.t === 'true') return TRUE;
    if (a.t === 'false') continue;
    if (a.t === 'or') flat.push(...a.args);
    else flat.push(a);
  }
  if (!flat.length) return FALSE;
  return flat.length === 1 ? flat[0] : { t: 'or', args: flat };
}

export function not(arg) {
  if (arg.t === 'true') return FALSE;
  if (arg.t === 'false') return TRUE;
  if (arg.t === 'not') return arg.arg;
  return { t: 'not', arg };
}

// ---------------------------------------------------------------------------
// Avaliação em JS (decisão sobre um registro)
// ---------------------------------------------------------------------------

function compare(left, op, value) {
  // CORREÇÃO (divergência JS x SQL com valor nulo): em JS `-1 < null` e `5 >= null`
  // são true (null vira 0) e `null` contra `null` em 'ne' dava true; no Postgres
  // `col < NULL` é NULL (=> FALSE no COALESCE) e `NULL IS DISTINCT FROM NULL` é
  // FALSE. Como decide() (JS) e a lista (SQL) precisam concordar, a semântica
  // canônica é a do SQL: comparação ordenada com valor nulo é falsa, e 'ne' é
  // IS DISTINCT FROM de verdade. Antes, uma linha podia aparecer na lista SQL e
  // ser negada por decide() (ou o contrário), inclusive no lado do deny.
  switch (op) {
    case 'eq':
      return left != null && left === value;
    case 'ne':
      if (value == null) return left != null; // IS DISTINCT FROM NULL
      return left == null || left !== value; // IS DISTINCT FROM
    case 'in':
      return left != null && Array.isArray(value) && value.includes(left);
    case 'nin':
      return left == null || !(Array.isArray(value) && value.includes(left));
    case 'lt':
      return left != null && value != null && left < value;
    case 'lte':
      return left != null && value != null && left <= value;
    case 'gt':
      return left != null && value != null && left > value;
    case 'gte':
      return left != null && value != null && left >= value;
    case 'isNull':
      return left == null;
    case 'notNull':
      return left != null;
    default:
      throw new Error(`operador desconhecido: ${op}`);
  }
}

/** Avalia `expr` contra um registro (objeto com os atributos do catálogo). Falha fechado. */
export function evaluate(expr, row) {
  switch (expr.t) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'and':
      return expr.args.every((a) => evaluate(a, row));
    case 'or':
      return expr.args.some((a) => evaluate(a, row));
    case 'not':
      return !evaluate(expr.arg, row);
    case 'cmp':
      return compare(row?.[expr.field], expr.op, expr.value);
    case 'shared': {
      const grants = row?.sharedWith;
      if (!Array.isArray(grants)) return false;
      // CORREÇÃO: entrada nula na lista de compartilhamentos lançava TypeError, e
      // `g.id === expr.userId` casava undefined===undefined (usuário sem id recebia
      // acesso a qualquer registro com um share "user" sem id). Id ausente nunca casa.
      return grants.some(
        (g) =>
          g != null &&
          g.id != null &&
          expr.levels.includes(g.level) &&
          ((g.type === 'user' && expr.userId != null && g.id === expr.userId) || (g.type === 'team' && Array.isArray(expr.teamIds) && expr.teamIds.includes(g.id)))
      );
    }
    default:
      throw new Error(`nó de expressão desconhecido: ${expr.t}`);
  }
}

/** Transforma a expressão em função (row) => boolean, para filtrar arrays. */
export const toPredicate = (expr) => (row) => evaluate(expr, row);

// ---------------------------------------------------------------------------
// Compilação para SQL (filtro de lista)
// ---------------------------------------------------------------------------

const PG_TYPES = { uuid: 'uuid', text: 'text', numeric: 'numeric', boolean: 'boolean' };

/**
 * Compila `expr` para uma cláusula WHERE parametrizada.
 *  - Nomes de coluna vêm SÓ do catálogo (whitelist) e do alias validado; valores
 *    SEMPRE como parâmetros ($n) — nada do usuário é interpolado no texto SQL.
 *  - `entityDef` = entrada do catálogo; `opts.alias` = alias da tabela na query;
 *    `opts.startAt` = primeiro número de parâmetro (para juntar com outros).
 * Devolve { sql, params }. Expressão TRUE vira 'TRUE', FALSE vira 'FALSE'.
 */
export function toSql(expr, entityDef, { alias = 't', startAt = 1 } = {}) {
  // CORREÇÃO: alias não-string era coagido (['t'] passava; objetos com toString
  // também) e startAt string ('1') dava numeração errada ('1'+1-1 = 10), gerando
  // $10 no lugar de $1 — parâmetro trocado silenciosamente ao juntar com outra query.
  if (typeof alias !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(alias) || alias.toLowerCase() === 'shr_') throw new Error('alias SQL inválido'); // shr_ é o alias interno do EXISTS de compartilhamento
  if (!Number.isInteger(startAt) || startAt < 1) throw new Error('startAt inválido');
  const params = [];
  const ph = (value, type) => {
    params.push(value);
    return `$${startAt + params.length - 1}::${type}`;
  };
  const colOf = (field) => {
    // hasOwn: 'constructor'/'toString'/'__proto__' não são colunas (viravam t.constructor)
    const type = typeof field === 'string' && Object.hasOwn(entityDef.attrs, field) ? entityDef.attrs[field] : undefined;
    if (!type || !Object.hasOwn(PG_TYPES, type)) throw new Error(`atributo "${String(field)}" não existe em ${entityDef.table}`);
    return { col: `${alias}.${columnOf(field)}`, type: PG_TYPES[type] };
  };

  const walk = (e) => {
    switch (e.t) {
      case 'true':
        return 'TRUE';
      case 'false':
        return 'FALSE';
      case 'and':
        return '(' + e.args.map(walk).join(' AND ') + ')';
      case 'or':
        return '(' + e.args.map(walk).join(' OR ') + ')';
      case 'not':
        return `(NOT ${walk(e.arg)})`;
      case 'cmp': {
        if (!OPERATORS.includes(e.op)) throw new Error(`operador desconhecido: ${e.op}`);
        const { col, type } = colOf(e.field);
        switch (e.op) {
          case 'isNull':
            return `(${col} IS NULL)`;
          case 'notNull':
            return `(${col} IS NOT NULL)`;
          case 'eq':
            return `COALESCE(${col} = ${ph(e.value, type)}, FALSE)`;
          case 'ne':
            return `(${col} IS DISTINCT FROM ${ph(e.value, type)})`;
          case 'in':
            return `COALESCE(${col} = ANY(${ph(e.value, type + '[]')}), FALSE)`;
          case 'nin':
            return `(NOT COALESCE(${col} = ANY(${ph(e.value, type + '[]')}), FALSE))`;
          default: {
            const sqlOp = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[e.op];
            return `COALESCE(${col} ${sqlOp} ${ph(e.value, type)}, FALSE)`;
          }
        }
      }
      case 'shared': {
        // tabela resource_shares: ver db/migrations/0001_permissions.sql
        const ent = ph(e.entity, 'text');
        const levels = ph(e.levels, 'text[]');
        const user = ph(e.userId, 'uuid');
        const teams = ph(e.teamIds, 'uuid[]');
        return (
          `EXISTS (SELECT 1 FROM resource_shares shr_ WHERE shr_.tenant_id = ${alias}.tenant_id ` +
          `AND shr_.entity = ${ent} AND shr_.resource_id = ${alias}.id AND shr_.level = ANY(${levels}) ` +
          `AND ((shr_.subject_type = 'user' AND shr_.subject_id = ${user}) ` +
          `OR (shr_.subject_type = 'team' AND shr_.subject_id = ANY(${teams}))))`
        );
      }
      default:
        throw new Error(`nó de expressão desconhecido: ${e.t}`);
    }
  };

  return { sql: walk(expr), params };
}

/** Texto legível da expressão (depuração e "por quê" na UI). */
export function describe(expr) {
  switch (expr.t) {
    case 'true':
      return 'sempre';
    case 'false':
      return 'nunca';
    case 'and':
      return '(' + expr.args.map(describe).join(' E ') + ')';
    case 'or':
      return '(' + expr.args.map(describe).join(' OU ') + ')';
    case 'not':
      return 'NÃO ' + describe(expr.arg);
    case 'cmp':
      return `${expr.field} ${expr.op}${expr.op === 'isNull' || expr.op === 'notNull' ? '' : ' ' + JSON.stringify(expr.value)}`;
    case 'shared':
      return `compartilhado(${expr.levels.join('/')})`;
    default:
      return '?';
  }
}
