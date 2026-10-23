// CSV: ler (importar) e escrever (exportar). PURO (sem DOM, exceto `downloadCsv`). Testado em test/api/csv.test.mjs.
// Escreve no formato que o Excel em português abre direto: ponto e vírgula, UTF-8 com BOM e datas dd/mm/aaaa.
// Lê o que vier do Excel, do Bitrix e de outros: separa por ; , ou tab, aceita aspas (com vírgula, quebra de linha e "" dentro),
// BOM, CRLF e arquivo salvo em Windows-1252 (o "CSV" padrão do Excel brasileiro).

/** Bytes → texto. UTF-8 se for válido; senão Windows-1252 (acentos do Excel antigo). */
export function decodeBuffer(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Separador mais provável, olhando só a 1ª linha FORA das aspas. */
export function detectDelimiter(text) {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text.slice(0, 4000)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '\n') break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ';';
}

/**
 * Texto CSV → { delimiter, header, rows } (linhas totalmente vazias somem; cada linha tem o tamanho do cabeçalho).
 * `lines[i]` = número da linha no arquivo (cabeçalho = 1) para as mensagens de erro.
 */
export function parseCsv(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  const records = [];
  const lines = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) {
      records.push(row);
      lines.push(startLine);
    }
    row = [];
    startLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      line++;
      endRow();
    } else if (ch === '\n') {
      line++;
      endRow();
    } else cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  const [header = [], ...rest] = records;
  const width = header.length;
  return { delimiter, header: header.map((h) => h.trim()), rows: rest.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim())), lines: lines.slice(1) };
}

/** Texto de uma célula seguro para planilha: aspas quando precisa e sem "fórmula" (= + - @ no começo viram texto). */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // = e @ sempre viram texto; + e - também, EXCETO quando é número ou telefone ("+55 11 98765-4321", "-5"), que seguem como estão
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s))) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Cabeçalho + linhas → texto CSV (separador `;`, linhas com CRLF, SEM o BOM — `downloadCsv` põe). */
export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/** Baixa o arquivo (UTF-8 com BOM, que o Excel precisa para acertar os acentos). */
export function downloadCsv(filename, text) {
  const blob = new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 'contatos-2026-10-23.csv' */
export const csvName = (base, now = new Date()) => `${base}-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.csv`;
