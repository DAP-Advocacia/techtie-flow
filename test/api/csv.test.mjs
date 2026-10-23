// CSV: ler o que vem do Excel/Bitrix e escrever no formato que o Excel brasileiro abre.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseCsv, toCsv, csvCell, detectDelimiter, decodeBuffer, csvName } = await import('../../public/js/lists/csv.js');

test('separador: ; , ou tab, olhando a 1ª linha fora das aspas', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.equal(detectDelimiter('"a;b",c,d\n1,2,3'), ',', 'ponto e vírgula dentro de aspas não conta');
  assert.equal(detectDelimiter('coluna única'), ';');
});

test('ler: cabeçalho, linhas, número da linha no arquivo, BOM, CRLF, vazias somem, linhas curtas completam', () => {
  const r = parseCsv('﻿Nome;Empresa;Telefone\r\nAna;Acme;11 98888-7777\r\n\r\nBia;;\r\nCaio\r\n');
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.header, ['Nome', 'Empresa', 'Telefone']);
  assert.deepEqual(r.rows, [['Ana', 'Acme', '11 98888-7777'], ['Bia', '', ''], ['Caio', '', '']]);
  assert.deepEqual(r.lines, [2, 4, 5], 'linha 3 estava em branco');
});

test('ler: aspas com separador, aspas duplas e quebra de linha dentro da célula', () => {
  const r = parseCsv('nome,obs\n"Silva, Ana","disse ""oi""\ne saiu"\nBia,ok');
  assert.deepEqual(r.rows, [['Silva, Ana', 'disse "oi"\ne saiu'], ['Bia', 'ok']]);
  assert.deepEqual(r.lines, [2, 4], 'a linha seguinte conta a quebra dentro das aspas');
  assert.deepEqual(parseCsv('').rows, []);
  assert.deepEqual(parseCsv('só;cabeçalho').rows, []);
});

test('escrever: ; CRLF, aspas só quando precisa, e texto que parece fórmula vira texto', () => {
  assert.equal(csvCell('simples'), 'simples');
  assert.equal(csvCell('com;ponto'), '"com;ponto"');
  assert.equal(csvCell('disse "oi"'), '"disse ""oi"""');
  assert.equal(csvCell('linha\nquebra'), '"linha\nquebra"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(1234.5), '1234.5');
  assert.equal(csvCell('=CMD()'), "'=CMD()");
  assert.equal(csvCell('+55 (11) 98888-7777'), '+55 (11) 98888-7777', 'telefone com + segue como está');
  assert.equal(csvCell('+cmd|calc'), "'+cmd|calc");
  assert.equal(csvCell('-2+3'), "'-2+3", 'conta que parece fórmula vira texto');
  assert.equal(csvCell('@fulano'), "'@fulano");
  assert.equal(csvCell('-5'), '-5', 'número negativo continua número');
  assert.equal(csvCell('-cuidado'), "'-cuidado");
  assert.equal(toCsv(['Nome', 'Valor'], [['Ana', '10,5'], ['A;B', '']]), 'Nome;Valor\r\nAna;10,5\r\n"A;B";\r\n');
});

test('ida e volta: o que se exporta se lê igual (inclusive acentos, aspas e quebras)', () => {
  const rows = [['José "Zé" Silva', 'Acme; Ltda', 'linha 1\nlinha 2'], ['Ana', '', 'ok']];
  const back = parseCsv(toCsv(['Nome', 'Empresa', 'Obs'], rows));
  assert.deepEqual(back.rows, rows);
});

test('bytes: UTF-8 quando é válido; Windows-1252 (Excel antigo) quando não é; tira o BOM', () => {
  assert.equal(decodeBuffer(new TextEncoder().encode('﻿Ação;Ótimo')), 'Ação;Ótimo');
  assert.equal(decodeBuffer(Uint8Array.from([0x41, 0xe7, 0xe3, 0x6f])), 'Ação', 'ç = E7 e ã = E3 em Windows-1252');
});

test('nome do arquivo', () => {
  assert.equal(csvName('contatos', new Date(2026, 9, 3)), 'contatos-2026-10-03.csv');
});
