const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

const originalLoad = Module._load;
let extension;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  extension = require('../extension');
} finally {
  Module._load = originalLoad;
}

const { parseJson, transformJson } = extension;

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
