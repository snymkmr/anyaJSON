const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const originalLoad = Module._load;
const vscodeMock = {};
let extension;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  extension = require('../extension');
} finally {
  Module._load = originalLoad;
}

const { parseJson, transformJson, getFilteredJsonTableRows } = extension;
const { validateLargeJsonFile } = extension;

test('supports case-insensitive exact-value filtering', () => {
  const preview = {
    columns: ['city'],
    rows: [{ city: 'Toronto' }, { city: 'Toronto West' }]
  };

  assert.equal(getFilteredJsonTableRows(preview, 'toro').length, 2);
  assert.deepEqual(getFilteredJsonTableRows(preview, 'toronto', true), [{ city: 'Toronto' }]);
  assert.deepEqual(getFilteredJsonTableRows(preview, '  TORONTO  ', true), [{ city: 'Toronto' }]);
});

test('parses JSON values, arrays, objects, and escaped strings', () => {
  const parsed = parseJson('{"null":null,"truth":true,"number":-1.25e+3,"items":[false,"line\\nbreak"]}');

  assert.equal(parsed.root.type, 'object');
  assert.equal(parsed.root.properties.length, 4);
  assert.deepEqual(parsed.root.properties[3].value.items.map(item => item.raw), ['false', '"line\\nbreak"']);
});

test('accepts and preserves a UTF-8 BOM', () => {
  const source = '\uFEFF{"a":1}';

  assert.equal(parseJson(source).hasBom, true);
  assert.equal(transformJson(source, false), '\uFEFF{\n  "a": 1\n}');
});

test('rejects comments, trailing commas, malformed numbers, and invalid escapes', () => {
  const invalidInputs = [
    '{"a":1 // comment\n}',
    '{"a":1,}',
    '[1,]',
    '1e+',
    '"\\x"',
    '{"a" 1}'
  ];

  for (const source of invalidInputs) {
    assert.throws(() => parseJson(source), error => error.name === 'JsonSyntaxError');
  }
});

test('reports the offset of malformed JSON', () => {
  const invalidInputs = [
    ['{"a":1,}', 7],
    ['[1,]', 3],
    ['1e+', 3],
    ['"\\x"', 2],
    ['{"a" 1}', 5],
    ['{"a":1', 6]
  ];

  for (const [source, expectedOffset] of invalidInputs) {
    assert.throws(
      () => parseJson(source),
      error => error.name === 'JsonSyntaxError' && error.offset === expectedOffset
    );
  }
});

test('formats with two spaces by default without reordering keys or changing numbers', () => {
  const source = '{"9":1e+30,"2":900719925474099312345,"name":"A","empty":[],"object":{}}';
  const expected = [
    '{',
    '  "9": 1e+30,',
    '  "2": 900719925474099312345,',
    '  "name": "A",',
    '  "empty": [],',
    '  "object": {}',
    '}'
  ].join('\n');

  assert.equal(transformJson(source, false), expected);
});

test('minifies whitespace outside strings while preserving escapes and number spellings', () => {
  const source = ' \n { "text" : "  keep ,: spaces  ", "escaped" : "line\\nfeed", "amount": 1e+30 } \n';
  const expected = '{"text":"  keep ,: spaces  ","escaped":"line\\nfeed","amount":1e+30}\n';

  const minified = transformJson(source, true);
  assert.equal(minified, expected);
  assert.equal(minified.slice(0, -1).includes('\n'), false);
  assert.equal(minified.includes('\r'), false);
});

test('uses tab indentation and preserves CRLF and final newline settings', () => {
  const source = '{"a":[1,2]}\r\n';
  const expected = '{\r\n\t"a": [\r\n\t\t1,\r\n\t\t2\r\n\t]\r\n}\r\n';

  assert.equal(transformJson(source, false, {
    insertSpaces: false,
    tabSize: 4,
    lineEnding: '\r\n'
  }), expected);
});

test('keeps a missing final newline and supports top-level scalar JSON', () => {
  assert.equal(transformJson('true', false), 'true');
  assert.equal(transformJson('null', true), 'null');
  assert.equal(transformJson('[]', false), '[]');
});

test('parses a 5 MB one-line synthetic MT103-style message', () => {
  const targetBytes = 5_000_000;
  const message = {
    messageType: 'MT103',
    synthetic: true,
    field20_senderReference: 'ANYJSON00000001',
    field23B_bankOperationCode: 'CRED',
    field32A_valueDateCurrencyAmount: '261031USD000123,45',
    field50K_orderingCustomer: '/TEST0001\nTEST SENDER\nTORONTO CA',
    field57A_accountWithInstitution: 'SYNTHCA0XXX',
    field59_beneficiaryCustomer: '/TEST0001B\nTEST BENEFICIARY\nSAMPLE CITY US',
    field70_remittanceInformation: 'INVOICE INV-0001 PAYMENT FOR TEST GOODS',
    field71A_detailsOfCharges: 'SHA',
    padding: ''
  };
  const sourceBytes = Buffer.byteLength(JSON.stringify(message));
  message.padding = 'X'.repeat(targetBytes - sourceBytes);
  const source = JSON.stringify(message);
  const parsed = parseJson(source).root;
  const messageType = parsed.properties.find(property => JSON.parse(property.key) === 'messageType').value.raw;

  assert.equal(Buffer.byteLength(source), targetBytes);
  assert.doesNotMatch(source, /[\r\n]/);
  assert.equal(JSON.parse(messageType), 'MT103');
});

test('validates JSON files directly from a stream and reports line and column', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyajson-large-lint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const validPath = path.join(directory, 'valid.json');
  const invalidPath = path.join(directory, 'invalid.json');
  const invalidBomPath = path.join(directory, 'invalid-bom.json');
  const longStringPath = path.join(directory, 'long-string.json');
  await fs.writeFile(validPath, '\uFEFF{\r\n  "items": [1, true, null]\r\n}');
  await fs.writeFile(invalidPath, '{\n  "items": [1,]\n}');
  await fs.writeFile(invalidBomPath, ' \uFEFF{}');
  await fs.writeFile(longStringPath, JSON.stringify('x'.repeat(5_000_000)));

  assert.deepEqual(await validateLargeJsonFile({ fsPath: validPath }), { isValid: true });
  assert.deepEqual(await validateLargeJsonFile({ fsPath: longStringPath }), { isValid: true });
  assert.deepEqual(await validateLargeJsonFile({ fsPath: invalidPath }), {
    isValid: false,
    offset: 16,
    line: 2,
    column: 15,
    message: 'Trailing commas are not allowed in JSON.'
  });
  assert.deepEqual(await validateLargeJsonFile({ fsPath: invalidBomPath }), {
    isValid: false,
    offset: 1,
    line: 1,
    column: 2,
    message: 'Expected a JSON value.'
  });
});

test('indents with tabs by default and supports 2 or 4 spaces', () => {
  const { resolveIndentOptions } = extension;
  assert.deepEqual(resolveIndentOptions(undefined), { insertSpaces: false });
  assert.deepEqual(resolveIndentOptions('tab'), { insertSpaces: false });
  assert.deepEqual(resolveIndentOptions('bogus'), { insertSpaces: false });
  assert.deepEqual(resolveIndentOptions('2'), { insertSpaces: true, tabSize: 2 });
  assert.deepEqual(resolveIndentOptions('4'), { insertSpaces: true, tabSize: 4 });
  assert.equal(transformJson('{"a":[1.0]}', false, resolveIndentOptions('tab')), '{\n\t"a": [\n\t\t1.0\n\t]\n}');
});

test('keeps literal _xHHHH_ text unchanged in Excel cells, including the case of x', () => {
  const { escapeExcelText } = extension;
  assert.equal(escapeExcelText('_x0041_'), '_x005F_x0041_');
  assert.equal(escapeExcelText('_X00ff_'), '_x005F_X00ff_');
  assert.equal(escapeExcelText('a\rb\u0001'), 'a_x000D_b_x0001_');
  assert.equal(escapeExcelText('<&>"\''), '&lt;&amp;&gt;&quot;&apos;');
});

test('lints strict JSON automatically but leaves JSON with Comments (jsonc) to explicit commands', () => {
  const { isJsonDocument, isAutoLintedJsonDocument } = extension;
  const doc = (languageId, fsPath, scheme = 'file') => ({ languageId, uri: { scheme, fsPath } });
  assert.equal(isAutoLintedJsonDocument(doc('json', '/repo/data.json')), true);
  assert.equal(isAutoLintedJsonDocument(doc('json', '', 'untitled')), true);
  assert.equal(isAutoLintedJsonDocument(doc('plaintext', '/repo/huge.json')), true);
  assert.equal(isAutoLintedJsonDocument(doc('jsonc', '/repo/tsconfig.json')), false);
  assert.equal(isAutoLintedJsonDocument(doc('jsonc', '/repo/.vscode/settings.json')), false);
  assert.equal(isAutoLintedJsonDocument(doc('typescript', '/repo/a.ts')), false);
  assert.equal(isAutoLintedJsonDocument(undefined), false);
  // Explicit Format, Minify, Lint and Preview commands still accept .json files opened as jsonc.
  assert.equal(isJsonDocument(doc('jsonc', '/repo/tsconfig.json')), true);
});

test('"editor" indentation follows the file\'s editor options and leaves other settings unchanged', () => {
  const { resolveIndentOptions } = extension;
  assert.deepEqual(resolveIndentOptions('editor', { insertSpaces: true, tabSize: 2 }), { insertSpaces: true, tabSize: 2 });
  assert.deepEqual(resolveIndentOptions('editor', { insertSpaces: true, tabSize: 4 }), { insertSpaces: true, tabSize: 4 });
  assert.deepEqual(resolveIndentOptions('editor', { insertSpaces: false, tabSize: 4 }), { insertSpaces: false });
  assert.deepEqual(resolveIndentOptions('editor', { insertSpaces: true, tabSize: 'auto' }), { insertSpaces: true, tabSize: 4 });
  assert.deepEqual(resolveIndentOptions('editor', undefined), { insertSpaces: false });
  // Explicit settings ignore the editor's options.
  assert.deepEqual(resolveIndentOptions('tab', { insertSpaces: true, tabSize: 2 }), { insertSpaces: false });
  assert.deepEqual(resolveIndentOptions('4', { insertSpaces: false, tabSize: 2 }), { insertSpaces: true, tabSize: 4 });
  assert.equal(
    transformJson('{"a":[1]}', false, resolveIndentOptions('editor', { insertSpaces: true, tabSize: 2 })),
    '{\n  "a": [\n    1\n  ]\n}'
  );
});

test('parses, lints and minifies very deeply nested JSON without overflowing the stack', () => {
  const depth = 100000;
  const arrays = '['.repeat(depth) + '1' + ']'.repeat(depth);
  const objects = '{"a":'.repeat(depth) + 'null' + '}'.repeat(depth);
  assert.equal(parseJson(arrays).root.type, 'array');
  assert.equal(parseJson(objects).root.type, 'object');
  assert.equal(transformJson(arrays, true), arrays);
  assert.equal(transformJson(` ${objects}\n`, true), `${objects}\n`);

  assert.throws(() => parseJson(arrays.slice(0, -1)), error =>
    error.name === 'JsonSyntaxError' && error.offset === arrays.length - 1 && error.message === "Expected ',' or ']' after the array item.");
  assert.throws(() => parseJson('['.repeat(depth) + '1,]' + ']'.repeat(depth - 1)), error =>
    error.name === 'JsonSyntaxError' && error.message === 'Trailing commas are not allowed in JSON.');
});

test('formats deep nesting that fits, and explains when indented output would be too large', () => {
  const depth = 3000;
  const nested = '['.repeat(depth) + ']'.repeat(depth);
  const formatted = transformJson(nested, false, { insertSpaces: true, tabSize: 2 });
  assert.equal(formatted.split('\n').length, 2 * depth - 1);
  assert.equal(transformJson(formatted, true), nested);

  const tooDeep = '['.repeat(100000) + '1' + ']'.repeat(100000);
  assert.throws(() => transformJson(tooDeep, false, { insertSpaces: false }), /too large to create because the document is very deeply nested/);
});

test('table preview reports extreme nesting clearly and still previews normal JSON', () => {
  const { buildJsonTablePreview } = extension;
  const preview = buildJsonTablePreview('[{"a":1,"b":{"c":"x"}},{"a":2}]');
  assert.deepEqual(preview.columns, ['a', 'b.c']);
  assert.equal(preview.totalRows, 2);
  assert.throws(() => buildJsonTablePreview('['.repeat(100000) + ']'.repeat(100000)), /nested too deeply to preview/);
  assert.throws(() => buildJsonTablePreview('[1,]'), error => error.name === 'JsonSyntaxError');
});

test('large-file validation handles very deep nesting', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyajson-deep-lint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const depth = 200000;
  const validPath = path.join(directory, 'deep.json');
  const invalidPath = path.join(directory, 'deep-invalid.json');
  await fs.writeFile(validPath, '['.repeat(depth) + ']'.repeat(depth));
  await fs.writeFile(invalidPath, '['.repeat(depth) + ']'.repeat(depth - 1));
  assert.deepEqual(await validateLargeJsonFile({ fsPath: validPath }), { isValid: true });
  const invalid = await validateLargeJsonFile({ fsPath: invalidPath });
  assert.equal(invalid.isValid, false);
  assert.equal(invalid.message, "Expected ',' or ']' after the array item.");
});
