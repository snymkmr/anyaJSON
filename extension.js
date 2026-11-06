const vscode = require('vscode');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createDeflateRaw } = require('node:zlib');

class JsonSyntaxError extends Error {
  constructor(offset, message) {
    super(message);
    this.name = 'JsonSyntaxError';
    this.offset = offset;
  }
}

function parseJson(text) {
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const hasBom = offset === 1;

  function fail(message, at = offset) {
    throw new JsonSyntaxError(at, message);
  }

  function skipWhitespace() {
    while (offset < text.length && /[\u0020\u0009\u000a\u000d]/.test(text[offset])) {
      offset += 1;
    }
  }

  function readString() {
    const start = offset;
    offset += 1;

    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return text.slice(start, offset);
      }
      if (code < 0x20) {
        fail('Unescaped control character in string.', offset);
      }
      if (code !== 0x5c) {
        offset += 1;
        continue;
      }

      offset += 1;
      if (offset >= text.length) {
        fail('Incomplete escape sequence.', offset);
      }
      const escape = text[offset];
      if ('"\\/bfnrt'.includes(escape)) {
        offset += 1;
        continue;
      }
      if (escape !== 'u') {
        fail('Invalid escape sequence.', offset);
      }

      offset += 1;
      for (let digit = 0; digit < 4; digit += 1) {
        if (offset >= text.length) {
          fail('Incomplete Unicode escape sequence.', offset);
        }
        if (!/[0-9a-f]/i.test(text[offset])) {
          fail('Invalid Unicode escape sequence.', offset);
        }
        offset += 1;
      }
    }

    fail('Unterminated string.', text.length);
  }

  function readNumber() {
    const start = offset;
    if (text[offset] === '-') {
      offset += 1;
      if (offset >= text.length) {
        fail('Expected a digit after the minus sign.', offset);
      }
    }

    if (text[offset] === '0') {
      offset += 1;
    } else if (/[1-9]/.test(text[offset] || '')) {
      while (/[0-9]/.test(text[offset] || '')) offset += 1;
    } else {
      fail('Expected a digit in the number.', offset);
    }

    if (text[offset] === '.') {
      offset += 1;
      if (!/[0-9]/.test(text[offset] || '')) {
        fail('Expected a digit after the decimal point.', offset);
      }
      while (/[0-9]/.test(text[offset] || '')) offset += 1;
    }

    if (text[offset] === 'e' || text[offset] === 'E') {
      offset += 1;
      if (text[offset] === '+' || text[offset] === '-') offset += 1;
      if (!/[0-9]/.test(text[offset] || '')) {
        fail('Expected a digit in the exponent.', offset);
      }
      while (/[0-9]/.test(text[offset] || '')) offset += 1;
    }

    return { type: 'scalar', raw: text.slice(start, offset) };
  }

  function readLiteral(literal) {
    const start = offset;
    for (let index = 0; index < literal.length; index += 1) {
      if (text[offset] !== literal[index]) {
        fail(`Expected '${literal}'.`, offset);
      }
      offset += 1;
    }
    return { type: 'scalar', raw: text.slice(start, offset) };
  }

  function readValue() {
    skipWhitespace();
    if (offset >= text.length) {
      fail('Expected a JSON value.', offset);
    }

    const character = text[offset];
    if (character === '"') {
      return { type: 'scalar', raw: readString() };
    }
    if (character === '{') {
      offset += 1;
      skipWhitespace();
      const properties = [];
      if (text[offset] === '}') {
        offset += 1;
        return { type: 'object', properties };
      }

      while (true) {
        if (text[offset] !== '"') {
          fail("Expected a quoted property name or '}'.", offset);
        }
        const key = readString();
        skipWhitespace();
        if (text[offset] !== ':') {
          fail("Expected ':' after the property name.", offset);
        }
        offset += 1;
        const value = readValue();
        properties.push({ key, value });
        skipWhitespace();

        if (text[offset] === '}') {
          offset += 1;
          return { type: 'object', properties };
        }
        if (text[offset] !== ',') {
          fail("Expected ',' or '}' after the property value.", offset);
        }
        offset += 1;
        skipWhitespace();
        if (text[offset] === '}') {
          fail('Trailing commas are not allowed in JSON.', offset);
        }
      }
    }
    if (character === '[') {
      offset += 1;
      skipWhitespace();
      const items = [];
      if (text[offset] === ']') {
        offset += 1;
        return { type: 'array', items };
      }

      while (true) {
        items.push(readValue());
        skipWhitespace();
        if (text[offset] === ']') {
          offset += 1;
          return { type: 'array', items };
        }
        if (text[offset] !== ',') {
          fail("Expected ',' or ']' after the array item.", offset);
        }
        offset += 1;
        skipWhitespace();
        if (text[offset] === ']') {
          fail('Trailing commas are not allowed in JSON.', offset);
        }
      }
    }
    if (character === '-') return readNumber();
    if (/[0-9]/.test(character)) return readNumber();
    if (character === 't') return readLiteral('true');
    if (character === 'f') return readLiteral('false');
    if (character === 'n') return readLiteral('null');
    fail('Expected a JSON value.', offset);
  }

  skipWhitespace();
  const root = readValue();
  skipWhitespace();
  if (offset < text.length) {
    fail('Unexpected content after the JSON value.', offset);
  }
  return { root, hasBom };
}

function serializeJson(node, indentUnit, lineEnding, depth = 0) {
  if (node.type === 'scalar') return node.raw;

  const indent = (level) => indentUnit.repeat(level);
  if (node.type === 'array') {
    if (node.items.length === 0) return '[]';
    const items = node.items.map((item) => `${indent(depth + 1)}${serializeJson(item, indentUnit, lineEnding, depth + 1)}`);
    return `[${lineEnding}${items.join(`,${lineEnding}`)}${lineEnding}${indent(depth)}]`;
  }

  if (node.properties.length === 0) return '{}';
  const properties = node.properties.map(({ key, value }) =>
    `${indent(depth + 1)}${key}${indentUnit === '' ? ':' : ': '}${serializeJson(value, indentUnit, lineEnding, depth + 1)}`
  );
  return `{${lineEnding}${properties.join(`,${lineEnding}`)}${lineEnding}${indent(depth)}}`;
}

function transformJson(text, minify, options = {}) {
  const { root, hasBom } = parseJson(text);
  const sourceHasFinalNewline = /(?:\r\n|\n|\r)$/.test(text);
  let result;

  if (minify) {
    result = serializeJson(root, '', '', 0);
  } else {
    const useSpaces = options.insertSpaces !== false;
    const tabSize = Number.isInteger(options.tabSize) ? Math.max(1, Math.min(options.tabSize, 16)) : 2;
    const indentUnit = useSpaces ? ' '.repeat(tabSize) : '\t';
    result = serializeJson(root, indentUnit, options.lineEnding || '\n', 0);
  }

  if (hasBom) result = `\uFEFF${result}`;
  if (sourceHasFinalNewline) result += options.lineEnding || '\n';
  return result;
}

const JSON_PREVIEW_PAGE_SIZE = 50;
const JSON_PREVIEW_PAGE_SIZES = [25, 50, 100, 200];
const JSON_PREVIEW_MAX_COLUMNS = 200;
const JSON_LARGE_FILE_THRESHOLD = 50_000_000;
const JSON_LARGE_PREVIEW_MAX_ROWS = 10000;
const JSON_NUMBER = Symbol('jsonNumber');

class JsonFileReader {
  constructor(stream, onProgress, totalBytes) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.index = 0;
    this.finished = false;
    this.onProgress = onProgress;
    this.totalBytes = totalBytes;
    this.bytesRead = 0;
    this.offset = 0;
    this.line = 1;
    this.column = 1;
    this.lastWasCarriageReturn = false;
  }

  peek() {
    return this.buffer[this.index];
  }

  consume() {
    const character = this.buffer[this.index];
    this.index += 1;
    this.offset += 1;
    if (character === '\r') {
      this.line += 1;
      this.column = 1;
      this.lastWasCarriageReturn = true;
    } else if (character === '\n') {
      if (!this.lastWasCarriageReturn) this.line += 1;
      this.column = 1;
      this.lastWasCarriageReturn = false;
    } else {
      this.column += 1;
      this.lastWasCarriageReturn = false;
    }
  }

  consumeRange(length) {
    if (length <= 0) return;
    const text = this.buffer.slice(this.index, this.index + length);
    this.index += length;
    this.offset += length;

    const carriageReturn = text.indexOf('\r');
    const lineFeed = text.indexOf('\n');
    if (carriageReturn < 0 && lineFeed < 0) {
      this.column += length;
      this.lastWasCarriageReturn = text.endsWith('\r');
      return;
    }

    let cursor = 0;
    let lineBreakCount = 0;
    let lastLineBreakEnd = 0;
    while (cursor < text.length) {
      const nextCarriageReturn = text.indexOf('\r', cursor);
      const nextLineFeed = text.indexOf('\n', cursor);
      if (nextCarriageReturn >= 0 && (nextLineFeed < 0 || nextCarriageReturn < nextLineFeed)) {
        lineBreakCount += 1;
        if (text[nextCarriageReturn + 1] === '\n') {
          cursor = nextCarriageReturn + 2;
          lastLineBreakEnd = cursor;
        } else {
          cursor = nextCarriageReturn + 1;
          lastLineBreakEnd = cursor;
        }
      } else if (nextLineFeed >= 0) {
        if (!(nextLineFeed === 0 && this.lastWasCarriageReturn)) lineBreakCount += 1;
        cursor = nextLineFeed + 1;
        lastLineBreakEnd = cursor;
      } else {
        break;
      }
    }
    this.line += lineBreakCount;
    this.column = text.length - lastLineBreakEnd + 1;
    this.lastWasCarriageReturn = text.endsWith('\r');
  }

  async fill() {
    if (this.index < this.buffer.length) return true;
    if (this.finished) return false;
    const next = await this.iterator.next();
    this.index = 0;
    if (next.done) {
      this.buffer = this.decoder.end();
      this.finished = true;
    } else {
      this.bytesRead += next.value.length;
      if (this.onProgress) this.onProgress(this.bytesRead, this.totalBytes);
      this.buffer = this.decoder.write(next.value);
    }
    if (this.buffer.length > 0) return true;
    return this.finished ? false : this.fill();
  }
}

async function nextJsonCharacter(reader) {
  while (reader.peek() === undefined) {
    if (!await reader.fill()) return undefined;
  }
  const character = reader.peek();
  reader.consume();
  return character;
}

async function peekJsonCharacter(reader) {
  while (reader.peek() === undefined) {
    if (!await reader.fill()) return undefined;
  }
  return reader.peek();
}

async function skipJsonWhitespace(reader, allowBom = false) {
  while (true) {
    if (reader.index >= reader.buffer.length && !await reader.fill()) return;
    const start = reader.index;
    let end = start;
    while (end < reader.buffer.length) {
      const code = reader.buffer.charCodeAt(end);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        end += 1;
      } else if (allowBom && reader.offset + end - start === 0 && code === 0xfeff) {
        allowBom = false;
        end += 1;
      } else {
        break;
      }
    }
    if (end > start) reader.consumeRange(end - start);
    if (reader.index < reader.buffer.length) return;
  }
}

function failLargeJsonValidation(reader, message) {
  throw new JsonSyntaxError(reader.offset, message);
}

async function readLargeJsonString(reader) {
  while (true) {
    if (reader.index >= reader.buffer.length && !await reader.fill()) {
      failLargeJsonValidation(reader, 'Unterminated string.');
    }
    let scanIndex = reader.index;
    while (scanIndex < reader.buffer.length) {
      const code = reader.buffer.charCodeAt(scanIndex);
      if (code === 0x22 || code === 0x5c || code < 0x20) break;
      scanIndex += 1;
    }
    if (scanIndex > reader.index) reader.consumeRange(scanIndex - reader.index);
    if (reader.index >= reader.buffer.length) continue;

    const character = reader.peek();
    if (character === '"') {
      reader.consume();
      return;
    }
    if (character.charCodeAt(0) < 0x20) failLargeJsonValidation(reader, 'Unescaped control character in string.');
    reader.consume();
    if (character !== '\\') continue;

    const escape = await peekJsonCharacter(reader);
    if (escape === undefined) failLargeJsonValidation(reader, 'Incomplete escape sequence.');
    if ('"\\/bfnrt'.includes(escape)) {
      reader.consume();
      continue;
    }
    if (escape !== 'u') failLargeJsonValidation(reader, 'Invalid escape sequence.');
    reader.consume();
    for (let digit = 0; digit < 4; digit += 1) {
      const hexadecimal = await peekJsonCharacter(reader);
      if (hexadecimal === undefined) failLargeJsonValidation(reader, 'Incomplete Unicode escape sequence.');
      if (!/[0-9a-f]/i.test(hexadecimal)) failLargeJsonValidation(reader, 'Invalid Unicode escape sequence.');
      reader.consume();
    }
  }
}

async function consumeLargeJsonDigits(reader) {
  while (true) {
    if (reader.index >= reader.buffer.length && !await reader.fill()) return;
    const start = reader.index;
    while (reader.index < reader.buffer.length) {
      const code = reader.buffer.charCodeAt(reader.index);
      if (code < 0x30 || code > 0x39) break;
      reader.index += 1;
    }
    const digitCount = reader.index - start;
    reader.index = start;
    if (digitCount > 0) reader.consumeRange(digitCount);
    if (reader.index < reader.buffer.length) return;
  }
}

async function readLargeJsonNumber(reader, firstCharacter) {
  let character = firstCharacter;
  if (character === '-') {
    character = await peekJsonCharacter(reader);
    if (character === undefined || !/[0-9]/.test(character)) {
      failLargeJsonValidation(reader, 'Expected a digit after the minus sign.');
    }
    reader.consume();
  }

  if (character === '0') {
    // A following digit is left for the parent parser to report as unexpected content.
  } else if (/[1-9]/.test(character)) {
    await consumeLargeJsonDigits(reader);
  } else {
    failLargeJsonValidation(reader, 'Expected a digit in the number.');
  }

  if (await peekJsonCharacter(reader) === '.') {
    reader.consume();
    if (!/[0-9]/.test((await peekJsonCharacter(reader)) || '')) {
      failLargeJsonValidation(reader, 'Expected a digit after the decimal point.');
    }
    await consumeLargeJsonDigits(reader);
  }
  const exponent = await peekJsonCharacter(reader);
  if (exponent === 'e' || exponent === 'E') {
    reader.consume();
    const sign = await peekJsonCharacter(reader);
    if (sign === '+' || sign === '-') reader.consume();
    if (!/[0-9]/.test((await peekJsonCharacter(reader)) || '')) {
      failLargeJsonValidation(reader, 'Expected a digit in the exponent.');
    }
    await consumeLargeJsonDigits(reader);
  }
}

async function readLargeJsonLiteral(reader, literal) {
  for (let index = 1; index < literal.length; index += 1) {
    if (await peekJsonCharacter(reader) !== literal[index]) {
      failLargeJsonValidation(reader, `Expected '${literal}'.`);
    }
    reader.consume();
  }
}

async function parseLargeJsonValue(reader) {
  await skipJsonWhitespace(reader);
  const firstCharacter = await peekJsonCharacter(reader);
  if (firstCharacter === undefined) failLargeJsonValidation(reader, 'Expected a JSON value.');
  if (!(firstCharacter === '"' || firstCharacter === '{' || firstCharacter === '['
    || firstCharacter === '-' || /[0-9]/.test(firstCharacter)
    || firstCharacter === 't' || firstCharacter === 'f' || firstCharacter === 'n')) {
    failLargeJsonValidation(reader, 'Expected a JSON value.');
  }
  reader.consume();

  if (firstCharacter === '"') return readLargeJsonString(reader);
  if (firstCharacter === '-') return readLargeJsonNumber(reader, firstCharacter);
  if (/[0-9]/.test(firstCharacter)) return readLargeJsonNumber(reader, firstCharacter);
  if (firstCharacter === 't') return readLargeJsonLiteral(reader, 'true');
  if (firstCharacter === 'f') return readLargeJsonLiteral(reader, 'false');
  if (firstCharacter === 'n') return readLargeJsonLiteral(reader, 'null');

  if (firstCharacter === '{') {
    await skipJsonWhitespace(reader);
    if (await peekJsonCharacter(reader) === '}') {
      reader.consume();
      return;
    }
    while (true) {
      if (await peekJsonCharacter(reader) !== '"') {
        failLargeJsonValidation(reader, "Expected a quoted property name or '}'.");
      }
      reader.consume();
      await readLargeJsonString(reader);
      await skipJsonWhitespace(reader);
      if (await peekJsonCharacter(reader) !== ':') failLargeJsonValidation(reader, "Expected ':' after the property name.");
      reader.consume();
      await skipJsonWhitespace(reader);
      await parseLargeJsonValue(reader);
      await skipJsonWhitespace(reader);
      const separator = await peekJsonCharacter(reader);
      if (separator === '}') {
        reader.consume();
        return;
      }
      if (separator !== ',') failLargeJsonValidation(reader, "Expected ',' or '}' after the property value.");
      reader.consume();
      await skipJsonWhitespace(reader);
      if (await peekJsonCharacter(reader) === '}') failLargeJsonValidation(reader, 'Trailing commas are not allowed in JSON.');
    }
  }

  if (firstCharacter === '[') {
    await skipJsonWhitespace(reader);
    if (await peekJsonCharacter(reader) === ']') {
      reader.consume();
      return;
    }
    while (true) {
      await parseLargeJsonValue(reader);
      await skipJsonWhitespace(reader);
      const separator = await peekJsonCharacter(reader);
      if (separator === ']') {
        reader.consume();
        return;
      }
      if (separator !== ',') failLargeJsonValidation(reader, "Expected ',' or ']' after the array item.");
      reader.consume();
      await skipJsonWhitespace(reader);
      if (await peekJsonCharacter(reader) === ']') failLargeJsonValidation(reader, 'Trailing commas are not allowed in JSON.');
    }
  }

  failLargeJsonValidation(reader, 'Expected a JSON value.');
}

async function validateLargeJsonFile(uri, onProgress) {
  const stat = await fs.promises.stat(uri.fsPath);
  const reader = new JsonFileReader(fs.createReadStream(uri.fsPath), onProgress, stat.size);
  try {
    await skipJsonWhitespace(reader, true);
    await parseLargeJsonValue(reader);
    await skipJsonWhitespace(reader);
    if (await peekJsonCharacter(reader) !== undefined) {
      failLargeJsonValidation(reader, 'Unexpected content after the JSON value.');
    }
    return { isValid: true };
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    return {
      isValid: false,
      offset: error.offset,
      line: reader.line,
      column: reader.column,
      message: error.message
    };
  }
}

async function scanJsonValue(reader, firstCharacter, capture, stopAfterString = false) {
  const parts = [];
  let segmentStart = reader.index - 1;
  let inString = firstCharacter === '"';
  let escaped = false;
  let curlyDepth = firstCharacter === '{' ? 1 : 0;
  let squareDepth = firstCharacter === '[' ? 1 : 0;
  let sawContainer = curlyDepth > 0 || squareDepth > 0;

  while (true) {
    const character = reader.peek();
    if (character === undefined) {
      if (capture) parts.push(reader.buffer.slice(segmentStart, reader.index));
      if (!await reader.fill()) break;
      segmentStart = reader.index;
      continue;
    }

    if (!inString && !sawContainer && (character === ',' || character === ']' || character === '}')) break;

    reader.consume();
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        inString = false;
        if (stopAfterString) break;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      curlyDepth += 1;
      sawContainer = true;
    } else if (character === '}') {
      curlyDepth -= 1;
      if (curlyDepth < 0) throw new Error('Unexpected closing brace in JSON.');
    } else if (character === '[') {
      squareDepth += 1;
      sawContainer = true;
    } else if (character === ']') {
      squareDepth -= 1;
      if (squareDepth < 0) throw new Error('Unexpected closing bracket in JSON.');
    }

    if (sawContainer && curlyDepth === 0 && squareDepth === 0) break;
  }

  if (inString || curlyDepth !== 0 || squareDepth !== 0) throw new Error('Unexpected end of JSON file.');
  if (capture) parts.push(reader.buffer.slice(segmentStart, reader.index));
  return capture ? parts.join('') : undefined;
}

function createLargeJsonArrayCandidate(sourcePath) {
  return {
    sourcePath,
    rows: [],
    columns: new Set(),
    rowCount: 0,
    onlyObjects: true,
    onlyScalars: true
  };
}

async function readLargeJsonArray(reader, sourcePath) {
  const candidate = createLargeJsonArrayCandidate(sourcePath);
  let afterComma = false;
  while (true) {
    await skipJsonWhitespace(reader);
    const character = await peekJsonCharacter(reader);
    if (character === undefined) throw new Error('Unexpected end of JSON array.');
    if (character === ']') {
      if (afterComma) throw new Error('Trailing commas are not allowed in JSON.');
      reader.consume();
      return candidate;
    }
    if (character === ',') throw new Error('Expected a JSON value in the array.');

    reader.consume();
    const raw = (await scanJsonValue(reader, character, true)).trim();
    let node;
    try {
      node = parseJson(raw).root;
    } catch (error) {
      throw new Error(`Invalid JSON at row ${candidate.rowCount + 1}: ${error.message}`);
    }
    const value = materializeJsonNode(node);
    const row = isRecord(value) ? flattenJsonRecord(value) : { Value: formatPreviewValue(value) };
    if (Object.keys(row).length === 0) row.Value = '{}';
    candidate.rowCount += 1;
    candidate.onlyObjects &&= node.type === 'object';
    candidate.onlyScalars &&= node.type === 'scalar';
    for (const column of Object.keys(row)) candidate.columns.add(column);
    if (candidate.rows.length < JSON_LARGE_PREVIEW_MAX_ROWS) candidate.rows.push(row);

    await skipJsonWhitespace(reader);
    const separator = await nextJsonCharacter(reader);
    if (separator === ']') return candidate;
    if (separator !== ',') throw new Error("Expected ',' or ']' after an array item.");
    afterComma = true;
    await skipJsonWhitespace(reader);
    if (await peekJsonCharacter(reader) === ']') throw new Error('Trailing commas are not allowed in JSON.');
    afterComma = false;
  }
}

async function readLargeJsonObject(reader, sourcePath, candidates) {
  await skipJsonWhitespace(reader);
  let afterComma = false;
  while (await peekJsonCharacter(reader) !== '}') {
    const keyStart = await nextJsonCharacter(reader);
    if (keyStart !== '"') throw new Error('Expected a quoted property name in a JSON object.');
    const keyRaw = await scanJsonValue(reader, keyStart, true, true);
    let key;
    try {
      key = JSON.parse(keyRaw);
    } catch {
      throw new Error('Invalid property name in a JSON object.');
    }
    await skipJsonWhitespace(reader);
    if (await nextJsonCharacter(reader) !== ':') throw new Error("Expected ':' after a property name.");
    await skipJsonWhitespace(reader);
    const valueStart = await nextJsonCharacter(reader);
    if (valueStart === undefined) throw new Error('Unexpected end of JSON object.');
    const valuePath = sourcePath ? `${sourcePath}.${key}` : key;
    if (valueStart === '[') candidates.push(await readLargeJsonArray(reader, valuePath));
    else if (valueStart === '{') await readLargeJsonObject(reader, valuePath, candidates);
    else await skipLargeJsonValue(reader, valueStart);

    await skipJsonWhitespace(reader);
    const separator = await nextJsonCharacter(reader);
    if (separator === '}') return;
    if (separator !== ',') throw new Error("Expected ',' or '}' after an object property.");
    afterComma = true;
    await skipJsonWhitespace(reader);
    if (await peekJsonCharacter(reader) === '}') throw new Error('Trailing commas are not allowed in JSON.');
    afterComma = false;
  }
  if (afterComma) throw new Error('Unexpected end of JSON object.');
  reader.consume();
}

async function skipLargeJsonValue(reader, firstCharacter) {
  const raw = await scanJsonValue(reader, firstCharacter, firstCharacter !== '{' && firstCharacter !== '[');
  if (raw !== undefined) parseJson(raw.trim());
}

async function readLargeJsonTablePreview(uri, onProgress) {
  let stream;
  let totalBytes;
  if (uri.scheme === 'file') {
    const stat = await fs.promises.stat(uri.fsPath);
    totalBytes = stat.size;
    stream = fs.createReadStream(uri.fsPath);
  } else {
    const contents = await vscode.workspace.fs.readFile(uri);
    totalBytes = contents.byteLength;
    stream = Readable.from([contents]);
  }

  const reader = new JsonFileReader(stream, onProgress, totalBytes);
  const candidates = [];
  let rootArray;
  await skipJsonWhitespace(reader, true);
  const rootCharacter = await nextJsonCharacter(reader);
  if (rootCharacter === '[') {
    rootArray = await readLargeJsonArray(reader, '$');
    candidates.push(rootArray);
  } else if (rootCharacter === '{') {
    await readLargeJsonObject(reader, '', candidates);
  } else {
    throw new Error('Large-file table preview requires a root array or an array inside a root object.');
  }

  await skipJsonWhitespace(reader);
  if (await nextJsonCharacter(reader) !== undefined) throw new Error('Unexpected content after the JSON value.');

  const objectCandidates = candidates.filter(candidate => candidate.rowCount > 0 && candidate.onlyObjects);
  const scalarCandidates = candidates.filter(candidate => candidate.rowCount > 1 && candidate.onlyScalars);
  let selected;
  if (objectCandidates.length > 0) {
    objectCandidates.sort((left, right) =>
      Number(right.rowCount > 1) - Number(left.rowCount > 1) ||
      right.columns.size - left.columns.size || right.rowCount - left.rowCount
    );
    selected = objectCandidates[0];
  } else if (scalarCandidates.length > 0) {
    scalarCandidates.sort((left, right) => right.rowCount - left.rowCount);
    selected = scalarCandidates[0];
  } else {
    selected = rootArray || candidates[0];
  }
  if (!selected) throw new Error('No table array was found in this large JSON file.');

  const columns = selected.onlyScalars ? ['Value'] : [...selected.columns];
  if (columns.length === 0) columns.push('Value');
  if (selected.rows.length === 0) selected.rows.push({ Value: '[]' });
  return {
    sourcePath: selected.sourcePath,
    columns: columns.slice(0, JSON_PREVIEW_MAX_COLUMNS),
    sourceColumnCount: columns.length,
    rows: selected.rows,
    totalRows: selected.rowCount || 1,
    isPartial: selected.rowCount > selected.rows.length,
    isLargeFile: true
  };
}

function formatPreviewValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return serializePreviewJson(value);
  return String(value);
}

function serializePreviewJson(value) {
  if (value === null) return 'null';
  if (isJsonNumber(value)) return value[JSON_NUMBER];
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(serializePreviewJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${serializePreviewJson(item)}`).join(',')}}`;
  }
  return String(value);
}

function isJsonNumber(value) {
  return typeof value === 'object' && value !== null && typeof value[JSON_NUMBER] === 'string';
}

function materializeJsonNode(node) {
  if (node.type === 'scalar') {
    if (node.raw[0] === '"') return JSON.parse(node.raw);
    if (node.raw === 'true') return true;
    if (node.raw === 'false') return false;
    if (node.raw === 'null') return null;
    return { [JSON_NUMBER]: node.raw };
  }
  if (node.type === 'array') return node.items.map(materializeJsonNode);
  const object = Object.create(null);
  for (const property of node.properties) {
    object[JSON.parse(property.key)] = materializeJsonNode(property.value);
  }
  return object;
}

function flattenJsonRecord(record) {
  const row = Object.create(null);
  const visit = (value, prefix) => {
    if (!isRecord(value)) {
      if (prefix) row[prefix] = formatPreviewValue(value);
      return;
    }

    const entries = Object.entries(value);
    if (entries.length === 0) {
      row[prefix || 'Value'] = '{}';
      return;
    }
    for (const [key, child] of entries) {
      const column = prefix ? `${prefix}.${key}` : key;
      if (isRecord(child) && !isJsonNumber(child)) visit(child, column);
      else row[column] = formatPreviewValue(child);
    }
  };
  visit(record, '');
  return row;
}

function collectJsonColumns(rows) {
  const columns = new Set();
  for (const row of rows) {
    for (const column of Object.keys(row)) columns.add(column);
  }
  return [...columns];
}

function buildJsonTablePreview(text) {
  const { root } = parseJson(text);
  const value = materializeJsonNode(root);
  const objectCandidates = [];
  const scalarCandidates = [];

  const visit = (current, currentPath, depth) => {
    if (Array.isArray(current)) {
      if (current.length > 0 && current.every(isRecord)) {
        const rows = current.map(flattenJsonRecord);
        objectCandidates.push({ path: currentPath || '$', rows, columns: collectJsonColumns(rows).length, depth });
      } else if (current.length > 1 && current.every(item => item === null || typeof item !== 'object' || isJsonNumber(item))) {
        scalarCandidates.push({
          path: currentPath || '$',
          rows: current.map(item => ({ Value: formatPreviewValue(item) })),
          depth
        });
      }
      current.forEach((item, index) => visit(item, `${currentPath || '$'}[${index}]`, depth + 1));
      return;
    }

    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      visit(child, currentPath ? `${currentPath}.${key}` : key, depth + 1);
    }
  };
  visit(value, '', 0);

  if (objectCandidates.length > 0) {
    objectCandidates.sort((left, right) =>
      Number(right.rows.length > 1) - Number(left.rows.length > 1) ||
      right.columns - left.columns || right.rows.length - left.rows.length || right.depth - left.depth
    );
    const selected = objectCandidates[0];
    const columns = collectJsonColumns(selected.rows);
    return {
      sourcePath: selected.path,
      columns: columns.slice(0, JSON_PREVIEW_MAX_COLUMNS),
      sourceColumnCount: columns.length,
      rows: selected.rows,
      totalRows: selected.rows.length
    };
  }

  if (scalarCandidates.length > 0) {
    scalarCandidates.sort((left, right) => right.rows.length - left.rows.length || right.depth - left.depth);
    const selected = scalarCandidates[0];
    return { sourcePath: selected.path, columns: ['Value'], sourceColumnCount: 1, rows: selected.rows, totalRows: selected.rows.length };
  }

  let rows;
  if (isRecord(value)) {
    rows = [flattenJsonRecord(value)];
  } else if (Array.isArray(value)) {
    rows = value.length > 0
      ? value.map(item => isRecord(item) ? flattenJsonRecord(item) : { Value: formatPreviewValue(item) })
      : [{ Value: '[]' }];
  } else {
    rows = [{ Value: formatPreviewValue(value) }];
  }
  if (rows[0] && Object.keys(rows[0]).length === 0) rows = [{ Value: '{}' }];
  const columns = collectJsonColumns(rows);
  return { sourcePath: '$', columns: columns.slice(0, JSON_PREVIEW_MAX_COLUMNS), sourceColumnCount: columns.length, rows, totalRows: rows.length };
}

function getFilteredJsonTableRows(preview, filterValue = '', exactMatch = false) {
  const filter = typeof filterValue === 'string' ? filterValue.trim().toLocaleLowerCase() : '';
  return filter
    ? preview.rows.filter(row => preview.columns.some(column => {
      const value = (row[column] ?? '').toLocaleLowerCase();
      return exactMatch ? value === filter : value.includes(filter);
    }))
    : preview.rows;
}

function queryJsonTable(preview, request = {}) {
  const filteredRows = getFilteredJsonTableRows(preview, request.filter, request.exactMatch === true);
  const pageSize = JSON_PREVIEW_PAGE_SIZES.includes(request.pageSize) ? request.pageSize : JSON_PREVIEW_PAGE_SIZE;
  const pageCount = Math.ceil(filteredRows.length / pageSize);
  const requestedPage = Number.isInteger(request.page) ? request.page : 0;
  const page = pageCount === 0 ? 0 : Math.min(Math.max(0, requestedPage), pageCount - 1);
  const rows = filteredRows.slice(page * pageSize, (page + 1) * pageSize).map(row =>
    preview.columns.map(column => row[column] ?? '')
  );
  return {
    type: 'page',
    requestId: request.requestId,
    columns: preview.columns,
    rows,
    sourcePath: preview.sourcePath,
    page,
    pageSize,
    totalRows: filteredRows.length,
    sourceTotalRows: preview.totalRows,
    previewedRows: preview.rows.length,
    isPartial: preview.isPartial === true
  };
}

const EXCEL_MAX_ROWS = 1048576;
const EXCEL_MAX_COLUMNS = 16384;
const ZIP32_MAX_VALUE = 0xffffffff;
const ZIP_CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function excelColumnName(columnNumber) {
  let number = columnNumber;
  let name = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function escapeExcelText(value) {
  // Escape the underscore of literal _xHHHH_ text so Excel keeps it as written (including the case of the x).
  const text = String(value ?? '').replace(/_(x[0-9a-f]{4})_/gi, '_x005F_$1_');
  let escaped = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === 0x0d || code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
      escaped += `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`;
    } else if (character === '&') escaped += '&amp;';
    else if (character === '<') escaped += '&lt;';
    else if (character === '>') escaped += '&gt;';
    else if (character === '"') escaped += '&quot;';
    else if (character === "'") escaped += '&apos;';
    else escaped += character;
  }
  return escaped;
}

function* excelWorksheetRowXml(row, rowNumber) {
  yield `<row r="${rowNumber}">`;
  for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
    const cellReference = `${excelColumnName(columnIndex + 1)}${rowNumber}`;
    yield `<c r="${cellReference}" t="inlineStr"><is><t xml:space="preserve">${escapeExcelText(row[columnIndex])}</t></is></c>`;
  }
  yield '</row>';
}

function* excelWorksheetXml(headers, rows) {
  yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetData>';
  yield* excelWorksheetRowXml(headers, 1);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    yield* excelWorksheetRowXml(rows[rowIndex], rowIndex + 2);
  }
  yield '</sheetData>';
  if (rows.length > 0) yield `<autoFilter ref="A1:${excelColumnName(headers.length)}${rows.length + 1}"/>`;
  yield '</worksheet>';
}

function calculateZipCrc32(buffer) {
  let checksum = 0xffffffff;
  for (const byte of buffer) checksum = ZIP_CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function createZipLocalHeader(fileName, method, flags, checksum, compressedSize, uncompressedSize) {
  const name = Buffer.from(fileName, 'utf8');
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function createZipCentralHeader(entry) {
  const name = Buffer.from(entry.fileName, 'utf8');
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(entry.checksum, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.localOffset, 42);
  name.copy(header, 46);
  return header;
}

function createExcelWorkbookArchive(headers, rows) {
  if (headers.length === 0) throw new Error('There are no columns to export.');
  if (headers.length > EXCEL_MAX_COLUMNS) throw new Error(`Excel supports at most ${EXCEL_MAX_COLUMNS.toLocaleString()} columns per worksheet.`);
  if (rows.length + 1 > EXCEL_MAX_ROWS) throw new Error(`Excel supports at most ${(EXCEL_MAX_ROWS - 1).toLocaleString()} data rows plus a header row per worksheet.`);
  const checkCellLength = value => {
    if (String(value ?? '').length > 32767) throw new Error('Excel supports at most 32,767 characters in a cell. Shorten the data and try again.');
  };
  headers.forEach(checkCellLength);
  rows.forEach(row => row.forEach(checkCellLength));
  return { headers, rows };
}

async function* excelWorkbookZipChunks(workbook) {
  const workbookParts = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>']
  ];
  const centralEntries = [];
  let archiveOffset = 0;
  for (const [fileName, content] of workbookParts) {
    const data = Buffer.from(content, 'utf8');
    const checksum = calculateZipCrc32(data);
    const header = createZipLocalHeader(fileName, 0, 0x0800, checksum, data.length, data.length);
    const localOffset = archiveOffset;
    yield header;
    archiveOffset += header.length;
    yield data;
    archiveOffset += data.length;
    centralEntries.push({ fileName, method: 0, flags: 0x0800, checksum, compressedSize: data.length, uncompressedSize: data.length, localOffset });
  }

  const sheetFileName = 'xl/worksheets/sheet1.xml';
  const sheetFlags = 0x0808;
  const sheetLocalOffset = archiveOffset;
  const sheetHeader = createZipLocalHeader(sheetFileName, 8, sheetFlags, 0, 0, 0);
  yield sheetHeader;
  archiveOffset += sheetHeader.length;

  let checksumState = 0xffffffff;
  let uncompressedSize = 0;
  const checksumStream = new Transform({
    transform(chunk, encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      uncompressedSize += data.length;
      for (const byte of data) checksumState = ZIP_CRC32_TABLE[(checksumState ^ byte) & 0xff] ^ (checksumState >>> 8);
      callback(null, data);
    }
  });
  const deflater = createDeflateRaw();
  const compression = pipeline(Readable.from(excelWorksheetXml(workbook.headers, workbook.rows)), checksumStream, deflater);
  let compressedSize = 0;
  for await (const chunk of deflater) {
    compressedSize += chunk.length;
    archiveOffset += chunk.length;
    yield chunk;
  }
  await compression;
  const sheetChecksum = (checksumState ^ 0xffffffff) >>> 0;
  if (compressedSize > ZIP32_MAX_VALUE || uncompressedSize > ZIP32_MAX_VALUE || archiveOffset > ZIP32_MAX_VALUE) {
    throw new Error('The exported workbook is too large for this Excel file format.');
  }
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(sheetChecksum, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  yield descriptor;
  archiveOffset += descriptor.length;
  centralEntries.push({ fileName: sheetFileName, method: 8, flags: sheetFlags, checksum: sheetChecksum, compressedSize, uncompressedSize, localOffset: sheetLocalOffset });

  const centralOffset = archiveOffset;
  for (const entry of centralEntries) {
    const centralHeader = createZipCentralHeader(entry);
    yield centralHeader;
    archiveOffset += centralHeader.length;
  }
  const centralSize = archiveOffset - centralOffset;
  if (archiveOffset > ZIP32_MAX_VALUE || centralSize > ZIP32_MAX_VALUE) throw new Error('The exported workbook is too large for this Excel file format.');
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(centralEntries.length, 8);
  endRecord.writeUInt16LE(centralEntries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);
  yield endRecord;
}

async function writeExcelArchive(target, workbook) {
  const zipStream = Readable.from(excelWorkbookZipChunks(workbook));
  if (target.scheme !== 'file') {
    const chunks = [];
    for await (const chunk of zipStream) chunks.push(chunk);
    await vscode.workspace.fs.writeFile(target, Buffer.concat(chunks));
    return;
  }

  const temporaryPath = path.join(path.dirname(target.fsPath), `.${path.basename(target.fsPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await pipeline(zipStream, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
    await fs.promises.rename(temporaryPath, target.fsPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function exportJsonPreviewForExcel(preview, sourceUri, filterValue, exactMatch) {
  const rows = getFilteredJsonTableRows(preview, filterValue, exactMatch).map(row =>
    preview.columns.map(column => row[column] ?? '')
  );
  const sourcePath = sourceUri.scheme === 'file' ? sourceUri.fsPath : '';
  const sourceName = sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : 'data';
  const defaultUri = sourcePath
    ? vscode.Uri.file(path.join(path.dirname(sourcePath), `${sourceName}_export.xlsx`))
    : undefined;
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: 'Export to Excel',
    filters: { 'Excel workbooks': ['xlsx'] }
  });
  if (!target) return;
  await writeExcelArchive(target, createExcelWorkbookArchive(preview.columns, rows));
  void vscode.window.showInformationMessage(`Exported ${rows.length.toLocaleString()} rows to an Excel workbook.`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsonNumber(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function renderJsonPreviewError(webview, fileName, message) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const contentSecurityPolicy = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)} JSON preview</title>
  <style>
    * { box-sizing: border-box; }
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 16px; }
    .title-bar { display: flex; align-items: center; gap: 12px; }
    .title-bar h1 { font-size: 18px; margin: 0; overflow-wrap: anywhere; }
    .title-actions { display: flex; gap: 4px; margin-left: auto; }
    .icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .icon-button:disabled { opacity: .45; cursor: default; }
    #window-action[data-window-mode="poppedOut"] .pop-in-icon { display: block; }
    #window-action[data-window-mode="poppedOut"] .pop-out-icon { display: none; }
    .pop-in-icon { display: none; }
    .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    p { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="title-bar">
    <h1>${escapeHtml(fileName)}</h1>
    <div class="title-actions">
      <button id="refresh-preview" class="icon-button" type="button" title="Refresh preview" aria-label="Refresh preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/></svg></button>
      <button id="window-action" class="icon-button" data-window-mode="main" type="button" title="Pop out preview" aria-label="Pop out preview"><svg class="pop-out-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg><svg class="pop-in-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 12 12"/><path d="M12 6v6h6"/><path d="M15 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h7"/></svg></button>
    </div>
  </div>
  <p id="error-message">Could not preview this JSON file: ${escapeHtml(message)}</p>
  <script nonce="${nonce}">
    (() => {
      const api = acquireVsCodeApi();
      const windowAction = document.getElementById('window-action');
      let windowMode = api.getState()?.windowMode === 'poppedOut' ? 'poppedOut' : 'main';
      const updateWindowMode = mode => {
        windowMode = mode;
        windowAction.dataset.windowMode = mode;
        windowAction.title = mode === 'poppedOut' ? 'Pop in preview' : 'Pop out preview';
        windowAction.setAttribute('aria-label', windowAction.title);
        api.setState({ ...api.getState(), windowMode: mode });
      };
      updateWindowMode(windowMode);
      document.getElementById('refresh-preview').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
      windowAction.addEventListener('click', () => {
        const nextMode = windowMode === 'poppedOut' ? 'main' : 'poppedOut';
        updateWindowMode(nextMode);
        windowAction.disabled = true;
        api.postMessage({ type: 'windowAction', mode: nextMode });
      });
      window.addEventListener('message', event => {
        if (event.data?.type === 'windowMode') {
          updateWindowMode(event.data.mode === 'poppedOut' ? 'poppedOut' : 'main');
          windowAction.disabled = false;
        } else if (event.data?.type === 'windowActionError') {
          windowAction.disabled = false;
        } else if (event.data?.type === 'refreshError') {
          document.getElementById('error-message').textContent = 'Could not refresh JSON preview: ' + event.data.message;
        }
      });
      api.postMessage({ type: 'ready', mode: windowMode });
    })();
  </script>
</body>
</html>`;
}

function renderJsonPreviewHtml(webview, fileName, preview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const contentSecurityPolicy = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const columnNote = preview.sourceColumnCount > JSON_PREVIEW_MAX_COLUMNS
    ? `<p class="description">Showing the first ${JSON_PREVIEW_MAX_COLUMNS} of ${preview.sourceColumnCount.toLocaleString()} columns.</p>`
    : '';
  const largeFileNote = preview.isLargeFile
    ? `<p class="description">Large-file preview reads the saved file from disk. ${preview.isPartial
      ? `Showing the first ${preview.rows.length.toLocaleString()} of ${preview.totalRows.toLocaleString()} rows; filtering covers these loaded rows only, and Excel export is unavailable for a partial preview.`
      : `All ${preview.totalRows.toLocaleString()} rows are loaded. Save changes before refreshing the preview.`}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)} JSON preview</title>
  <style>
    * { box-sizing: border-box; }
    body { display: flex; flex-direction: column; height: 100vh; margin: 0; overflow: hidden; padding: 0 18px 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
    .title-bar { display: flex; align-items: center; gap: 12px; }
    .title-bar h1 { margin: 18px 0 12px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
    .title-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; flex: 0 0 auto; }
    .icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .icon-button:disabled { opacity: .45; cursor: default; }
    #window-action[data-window-mode="poppedOut"] .pop-in-icon { display: block; }
    #window-action[data-window-mode="poppedOut"] .pop-out-icon { display: none; }
    .pop-in-icon { display: none; }
    .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .title-actions .excel-export-button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 4px 9px; color: #fff; background: #217346; border: 1px solid #185c37; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .title-actions .excel-export-button:hover { background: #185c37; }
    .title-actions .icon-button[data-exact-match="true"] { background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); border-color: var(--vscode-focusBorder); }
    .excel-mark { display: inline-grid; place-items: center; width: 17px; height: 17px; border: 1px solid rgba(255,255,255,.8); border-radius: 2px; font-size: 11px; line-height: 1; font-weight: 700; }
    .toolbar, .controls { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .page-size-control { justify-content: flex-end; margin: 4px 0 0; }
    .table-pagination { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 8px; margin: 0 0 8px; }
    .page-info { flex: 0 0 auto; margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: right; }
    .pagination { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin: 0; }
    input, select, button { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; padding: 5px 8px; font: inherit; }
    input { width: min(360px, 100%); }
    input:focus, select:focus, button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    button { cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    #result-count { margin-left: auto; opacity: .8; white-space: nowrap; }
    .description, .meta { margin: 0 0 10px; color: var(--vscode-descriptionForeground); }
    .meta { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
    #source-path { overflow-wrap: anywhere; }
    .table-scroll { flex: 1 1 auto; min-height: 0; max-width: 100%; overflow: auto; border: 1px solid var(--vscode-panel-border); }
    table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; }
    th, td { min-width: 150px; max-width: 420px; padding: 7px 9px; text-align: left; vertical-align: top; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; white-space: pre-wrap; }
    th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorStickyScroll-background, var(--vscode-sideBar-background)); }
    th.row-number, td.row-number { min-width: 54px; width: 54px; text-align: right; color: var(--vscode-descriptionForeground); }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    #status { color: var(--vscode-descriptionForeground); padding: 12px; }
    .pagination button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; }
    .pagination button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .pagination button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  </style>
</head>
<body>
  <div class="title-bar">
    <h1>${escapeHtml(fileName)}</h1>
    <div class="title-actions">
      <button id="export-excel" class="excel-export-button" type="button"${preview.isPartial ? ' disabled title="Export is unavailable for a partial large-file preview" aria-label="Export is unavailable for a partial large-file preview"' : ' title="Export all filtered rows as an Excel workbook (.xlsx)" aria-label="Export all filtered rows as an Excel workbook (.xlsx)"'}><span class="excel-mark" aria-hidden="true">X</span><span>Export</span></button>
      <button id="exact-filter" class="icon-button" data-exact-match="false" type="button" aria-pressed="false" title="Exact filtering off" aria-label="Exact filtering off"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7z"/><path d="M16 17h6M16 20h6"/></svg></button>
      <button id="refresh-preview" class="icon-button" type="button" title="Refresh preview" aria-label="Refresh preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/></svg></button>
      <button id="window-action" class="icon-button" data-window-mode="main" type="button" title="Pop out preview" aria-label="Pop out preview"><svg class="pop-out-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg><svg class="pop-in-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 12 12"/><path d="M12 6v6h6"/><path d="M15 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h7"/></svg></button>
    </div>
  </div>
  <div class="toolbar">
    <input id="filter" type="search" placeholder="Filter rows…" aria-label="Filter rows">
    <span id="result-count" aria-live="polite"></span>
  </div>
  ${columnNote}
  ${largeFileNote}
  <div class="meta"><span id="source-path">Path: ${escapeHtml(preview.sourcePath || '$')}</span></div>
  <div class="table-pagination">
    <div id="page-info" class="page-info" aria-live="polite">Loading JSON data…</div>
    <div class="pagination" aria-label="Table pagination">
      <button id="previous" type="button" title="Previous page" aria-label="Previous page" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 18l-6-6 6-6"/></svg></button>
      <button id="next" type="button" title="Next page" aria-label="Next page" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 18l6-6-6-6"/></svg></button>
    </div>
  </div>
  <div class="table-scroll"><table><thead id="table-head"></thead><tbody id="table-body"></tbody></table><div id="status">Loading JSON data…</div></div>
  <div class="controls page-size-control">
    <label for="page-size">Rows per page</label>
    <select id="page-size" aria-label="Rows per page">${JSON_PREVIEW_PAGE_SIZES.map(size => `<option value="${size}"${size === JSON_PREVIEW_PAGE_SIZE ? ' selected' : ''}>${size}</option>`).join('')}</select>
  </div>
  <script nonce="${nonce}">
    (() => {
      const api = acquireVsCodeApi();
      const filter = document.getElementById('filter');
      const pageSize = document.getElementById('page-size');
      const previous = document.getElementById('previous');
      const next = document.getElementById('next');
      const head = document.getElementById('table-head');
      const body = document.getElementById('table-body');
      const status = document.getElementById('status');
      const pageInfo = document.getElementById('page-info');
      const sourcePath = document.getElementById('source-path');
      const resultCount = document.getElementById('result-count');
      const windowAction = document.getElementById('window-action');
      let windowMode = api.getState()?.windowMode === 'poppedOut' ? 'poppedOut' : 'main';
      const updateWindowMode = mode => {
        windowMode = mode;
        windowAction.dataset.windowMode = mode;
        windowAction.title = mode === 'poppedOut' ? 'Pop in preview' : 'Pop out preview';
        windowAction.setAttribute('aria-label', windowAction.title);
        api.setState({ ...api.getState(), windowMode: mode });
      };
      updateWindowMode(windowMode);
      const exportExcel = document.getElementById('export-excel');
      const exactFilter = document.getElementById('exact-filter');
      let page = 0;
      let requestId = 0;
      let filterTimer;
      let exactMatch = false;
      const updateExactFilter = () => {
        const label = exactMatch ? 'Exact filtering on' : 'Exact filtering off';
        exactFilter.dataset.exactMatch = String(exactMatch);
        exactFilter.setAttribute('aria-pressed', String(exactMatch));
        exactFilter.title = label;
        exactFilter.setAttribute('aria-label', label);
      };
      const request = () => {
        requestId += 1;
        status.textContent = 'Loading…';
        api.postMessage({ type: 'query', filter: filter.value, exactMatch, page, pageSize: Number(pageSize.value), requestId });
      };
      windowAction.addEventListener('click', () => {
        const nextMode = windowMode === 'poppedOut' ? 'main' : 'poppedOut';
        updateWindowMode(nextMode);
        windowAction.disabled = true;
        api.postMessage({ type: 'windowAction', mode: nextMode });
      });
      exportExcel.addEventListener('click', () => api.postMessage({ type: 'export', filter: filter.value, exactMatch }));
      exactFilter.addEventListener('click', () => {
        exactMatch = !exactMatch;
        updateExactFilter();
        page = 0;
        request();
      });
      document.getElementById('refresh-preview').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
      const makeCell = (tagName, value, className) => {
        const cell = document.createElement(tagName);
        if (className) cell.className = className;
        cell.textContent = value;
        return cell;
      };
      window.addEventListener('message', event => {
        const result = event.data;
        if (result?.type === 'windowMode') {
          updateWindowMode(result.mode === 'poppedOut' ? 'poppedOut' : 'main');
          windowAction.disabled = false;
          return;
        }
        if (result?.type === 'windowActionError') {
          windowAction.disabled = false;
          return;
        }
        if (result?.type === 'refreshError') {
          status.textContent = 'Refresh failed: ' + result.message;
          return;
        }
        if (!result || result.type !== 'page' || result.requestId !== requestId) return;
        head.replaceChildren();
        body.replaceChildren();
        const header = document.createElement('tr');
        header.appendChild(makeCell('th', '#', 'row-number'));
        for (const column of result.columns) header.appendChild(makeCell('th', column));
        head.appendChild(header);
        for (let index = 0; index < result.rows.length; index += 1) {
          const row = document.createElement('tr');
          row.appendChild(makeCell('th', (result.page * result.pageSize + index + 1).toLocaleString(), 'row-number'));
          for (const value of result.rows[index]) row.appendChild(makeCell('td', value));
          body.appendChild(row);
        }
        const pages = Math.ceil(result.totalRows / result.pageSize);
        page = result.page;
        pageInfo.textContent = result.totalRows === 0
          ? '0 rows'
          : 'Page ' + (page + 1).toLocaleString() + ' of ' + pages.toLocaleString() + ' · ' + result.totalRows.toLocaleString() + (result.isPartial ? ' loaded matching rows' : ' rows');
        resultCount.textContent = result.isPartial
          ? result.totalRows.toLocaleString() + ' matching / ' + result.previewedRows.toLocaleString() + ' loaded of ' + result.sourceTotalRows.toLocaleString() + ' rows'
          : result.totalRows.toLocaleString() + ' matching / ' + result.sourceTotalRows.toLocaleString() + ' rows';
        sourcePath.textContent = 'Path: ' + result.sourcePath;
        status.textContent = result.totalRows === 0 ? 'No matching rows.' : '';
        previous.disabled = page <= 0;
        next.disabled = page + 1 >= pages;
      });
      filter.addEventListener('input', () => {
        page = 0;
        clearTimeout(filterTimer);
        filterTimer = setTimeout(request, 150);
      });
      pageSize.addEventListener('change', () => { page = 0; request(); });
      previous.addEventListener('click', () => { if (page > 0) { page -= 1; request(); } });
      next.addEventListener('click', () => { page += 1; request(); });
      api.postMessage({ type: 'ready', mode: windowMode });
    })();
  </script>
</body>
</html>`;
}

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('anyajson');
  const validationStates = new Map();
  const validationTimers = new Map();
  const pendingValidations = new Set();
  const previewPanels = new Map();
  const previewWindowModes = new Map();
  const previewModels = new Map();
  const previewSourceUris = new Map();
  const largePreviewUris = new Set();
  const previewTimers = new Map();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusBar.name = 'AnyaJSON JSON Lint';

  const refreshJsonPreview = (document) => {
    const uri = document.uri.toString();
    const panel = previewPanels.get(uri);
    if (!panel) return;
    const fileName = path.basename(document.uri.fsPath) || 'Untitled JSON';
    try {
      const preview = buildJsonTablePreview(document.getText());
      previewModels.set(uri, preview);
      panel.title = `AnyaJSON: ${fileName}`;
      panel.webview.html = renderJsonPreviewHtml(panel.webview, fileName, preview);
    } catch (error) {
      previewModels.delete(uri);
      panel.webview.html = renderJsonPreviewError(panel.webview, fileName, errorMessage(error));
    }
  };

  const previewJsonCommand = async (resource) => {
    const activeDocument = vscode.window.activeTextEditor?.document;
    const sourceUri = resource || activeDocument?.uri;
    if (!sourceUri) {
      void vscode.window.showWarningMessage('Select or open a JSON file before previewing it as a table.');
      return;
    }

    const fileName = path.basename(sourceUri.fsPath || sourceUri.path || '') || 'Untitled JSON';
    const uri = sourceUri.toString();
    let document;
    let preview;
    let isLargeFile = false;
    try {
      const openSourceDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
      const sourceExtension = path.extname(sourceUri.fsPath || sourceUri.path || '').toLowerCase();
      if (!isJsonDocument(openSourceDocument) && sourceExtension !== '.json') {
        void vscode.window.showWarningMessage('Select or open a JSON file before previewing it as a table.');
        return;
      }
      try {
        const fileStat = await vscode.workspace.fs.stat(sourceUri);
        isLargeFile = fileStat.size > JSON_LARGE_FILE_THRESHOLD;
      } catch (error) {
        if (sourceUri.scheme === 'file') throw error;
      }
      if (isLargeFile) {
        preview = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Reading ${fileName} for AnyaJSON preview`,
          cancellable: false
        }, progress => {
          let reportedBytes = 0;
          return readLargeJsonTablePreview(sourceUri, (read, total) => {
            const increment = total ? 100 * (read - reportedBytes) / total : 0;
            reportedBytes = read;
            progress.report({ increment, message: total ? `${Math.min(100, Math.round(100 * read / total))}%` : undefined });
          });
        });
      } else {
        document = await resolveJsonDocument(resource);
        if (!document) {
          void vscode.window.showWarningMessage('Select or open a JSON file before previewing it as a table.');
          return;
        }
        preview = buildJsonTablePreview(document.getText());
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`${isLargeFile ? 'Cannot preview large JSON file' : 'Cannot preview invalid JSON'}: ${errorMessage(error)}`);
      return;
    }
    previewModels.set(uri, preview);
    previewSourceUris.set(uri, sourceUri);
    if (isLargeFile) largePreviewUris.add(uri);
    else largePreviewUris.delete(uri);

    let panel = previewPanels.get(uri);
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'anyajson.tablePreview',
        `AnyaJSON: ${fileName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [] }
      );
      previewPanels.set(uri, panel);
      previewWindowModes.set(uri, 'main');
      const messageListener = panel.webview.onDidReceiveMessage(message => {
        if (message?.type === 'windowAction') {
          const currentMode = previewWindowModes.get(uri) || 'main';
          const nextMode = message.mode === 'main' || message.mode === 'poppedOut'
            ? message.mode
            : currentMode === 'poppedOut' ? 'main' : 'poppedOut';
          const isPoppedOut = nextMode === 'main';
          const command = isPoppedOut
            ? 'workbench.action.restoreEditorsToMainWindow'
            : 'workbench.action.moveEditorToNewWindow';
          previewWindowModes.set(uri, nextMode);
          void panel.webview.postMessage({ type: 'windowMode', mode: nextMode });
          void vscode.commands.executeCommand(command).then(undefined, error => {
            previewWindowModes.set(uri, currentMode);
            void vscode.window.showErrorMessage(`Could not ${isPoppedOut ? 'pop in' : 'pop out'} the JSON preview: ${errorMessage(error)}`);
            void panel.webview.postMessage({ type: 'windowMode', mode: currentMode });
          });
          return;
        }
        if (message?.type === 'refresh') {
          const largeSourceUri = previewSourceUris.get(uri);
          if (largePreviewUris.has(uri) && largeSourceUri) {
            void vscode.window.withProgress({
              location: vscode.ProgressLocation.Notification,
              title: `Refreshing ${fileName} AnyaJSON preview`,
              cancellable: false
            }, progress => {
              let reportedBytes = 0;
              return readLargeJsonTablePreview(largeSourceUri, (read, total) => {
                const increment = total ? 100 * (read - reportedBytes) / total : 0;
                reportedBytes = read;
                progress.report({ increment, message: total ? `${Math.min(100, Math.round(100 * read / total))}%` : undefined });
              });
            }).then(refreshed => {
              previewModels.set(uri, refreshed);
              panel.webview.html = renderJsonPreviewHtml(panel.webview, fileName, refreshed);
            }, error => panel.webview.postMessage({ type: 'refreshError', message: errorMessage(error) }));
            return;
          }
          const sourceDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
          if (sourceDocument) refreshJsonPreview(sourceDocument);
          else void panel.webview.postMessage({ type: 'refreshError', message: 'The source document is no longer open.' });
          return;
        }
        if (message?.type === 'export') {
          const current = previewModels.get(uri);
          if (current && !current.isPartial) {
            void exportJsonPreviewForExcel(current, sourceUri, message.filter, message.exactMatch === true)
              .catch(error => vscode.window.showErrorMessage(`Could not export Excel workbook: ${errorMessage(error)}`));
          }
          return;
        }
        if (message?.type === 'ready') {
          if (message.mode === 'main' || message.mode === 'poppedOut') {
            previewWindowModes.set(uri, message.mode);
          }
          void panel.webview.postMessage({ type: 'windowMode', mode: previewWindowModes.get(uri) || 'main' });
          const current = previewModels.get(uri);
          if (current) void panel.webview.postMessage(queryJsonTable(current, { page: 0, pageSize: JSON_PREVIEW_PAGE_SIZE, requestId: 0 }));
          return;
        }
        if (message?.type === 'query') {
          const current = previewModels.get(uri);
          if (current) void panel.webview.postMessage(queryJsonTable(current, message));
        }
      });
      const disposeListener = panel.onDidDispose(() => {
        messageListener.dispose();
        previewPanels.delete(uri);
        previewModels.delete(uri);
        previewSourceUris.delete(uri);
        largePreviewUris.delete(uri);
        previewWindowModes.delete(uri);
      });
      context.subscriptions.push({ dispose: () => { messageListener.dispose(); disposeListener.dispose(); } });
    }

    panel.title = `AnyaJSON: ${fileName}`;
    panel.webview.html = renderJsonPreviewHtml(panel.webview, fileName, preview);
    panel.reveal(vscode.ViewColumn.Beside);
    // Webview panels open as preview (italic) tabs, which the next opened file replaces.
    // Pin the panel so a large-file preview is not discarded and re-read.
    if (panel.active) await vscode.commands.executeCommand('workbench.action.keepEditor');
  };

  const updateStatusBar = () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!isJsonDocument(document)) {
      statusBar.hide();
      return;
    }

    const key = document.uri.toString();
    statusBar.show();
    statusBar.command = {
      command: 'anyajson.lintJson',
      title: 'Refresh JSON lint',
      arguments: [document.uri]
    };

    if (pendingValidations.has(key)) {
      statusBar.text = '$(sync~spin) JSON';
      statusBar.color = undefined;
      statusBar.tooltip = 'Checking JSON syntax…';
      return;
    }

    const state = validationStates.get(key);
    statusBar.text = '$(circle-filled) JSON';
    if (!state) {
      statusBar.color = new vscode.ThemeColor('testing.iconFailed');
      statusBar.tooltip = 'JSON has not been linted. Click to refresh lint.';
      return;
    }
    if (state.version !== document.version) {
      statusBar.color = new vscode.ThemeColor('testing.iconFailed');
      statusBar.tooltip = 'JSON changed since the last lint. Click to refresh lint.';
      return;
    }
    if (!state.error) {
      statusBar.color = new vscode.ThemeColor('testing.iconPassed');
      statusBar.tooltip = 'No JSON syntax errors. Click to refresh lint.';
      return;
    }

    const position = document.positionAt(state.error.offset);
    const line = position.line + 1;
    const column = position.character + 1;
    statusBar.text = `$(circle-filled) JSON: ${formatStatusBarIssue(`Line ${line}, column ${column}: ${state.error.message}`)}`;
    statusBar.color = new vscode.ThemeColor('testing.iconFailed');
    statusBar.tooltip = `Line ${line}, column ${column}: ${state.error.message}\nClick to refresh lint.`;
  };

  const lintNow = (document) => {
    const key = document.uri.toString();
    const timer = validationTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      validationTimers.delete(key);
    }
    pendingValidations.delete(key);
    const error = lintDocument(document, diagnostics, validationStates);
    updateStatusBar();
    return error;
  };

  const scheduleLint = (document) => {
    if (!isJsonDocument(document)) return;
    const key = document.uri.toString();
    const existingTimer = validationTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    pendingValidations.add(key);
    updateStatusBar();
    validationTimers.set(key, setTimeout(() => {
      validationTimers.delete(key);
      pendingValidations.delete(key);
      lintDocument(document, diagnostics, validationStates);
      updateStatusBar();
    }, 500));
  };

  const runTransform = async (resource, minify) => {
    let document;
    try {
      document = await resolveJsonDocument(resource);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
      return;
    }
    if (!document) {
      void vscode.window.showWarningMessage('Select or open a JSON file before converting it.');
      return;
    }

    try {
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === document.uri.toString()
      ) ?? await vscode.window.showTextDocument(document);
      const version = document.version;
      const lineEnding = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const text = transformJson(document.getText(), minify, { ...getIndentOptions(), lineEnding });
      if (document.version !== version) {
        throw new Error('The JSON document changed while conversion was running. Run the command again.');
      }
      const applied = await editor.edit((edit) => edit.replace(fullDocumentRange(document), text));
      if (!applied) throw new Error('VS Code could not apply the JSON edits.');
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  };

  context.subscriptions.push(
    diagnostics,
    statusBar,
    vscode.languages.registerDocumentFormattingEditProvider('json', {
      provideDocumentFormattingEdits(document, options) {
        try {
          const lineEnding = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
          const formatted = transformJson(document.getText(), false, { ...getIndentOptions(), lineEnding });
          return [vscode.TextEdit.replace(fullDocumentRange(document), formatted)];
        } catch (error) {
          void vscode.window.showErrorMessage(errorMessage(error));
          return [];
        }
      }
    }),
    vscode.commands.registerCommand('anyajson.formatJson', (resource) => runTransform(resource, false)),
    vscode.commands.registerCommand('anyajson.minifyJson', (resource) => runTransform(resource, true)),
    vscode.commands.registerCommand('anyajson.previewJsonAsTable', previewJsonCommand),
    vscode.commands.registerCommand('anyajson.lintJson', async (resource) => {
      const sourceUri = resource || vscode.window.activeTextEditor?.document.uri;
      if (sourceUri?.scheme === 'file') {
        try {
          const fileStat = await fs.promises.stat(sourceUri.fsPath);
          if (fileStat.size > JSON_LARGE_FILE_THRESHOLD) {
            if (path.extname(sourceUri.fsPath).toLowerCase() !== '.json') {
              void vscode.window.showWarningMessage('Select a JSON file before linting it.');
              return;
            }
            const fileName = path.basename(sourceUri.fsPath);
            const result = await vscode.window.withProgress({
              location: vscode.ProgressLocation.Notification,
              title: `Linting ${fileName}`,
              cancellable: false
            }, progress => {
              let reportedBytes = 0;
              return validateLargeJsonFile(sourceUri, (read, total) => {
                const increment = total ? 100 * (read - reportedBytes) / total : 0;
                reportedBytes = read;
                progress.report({ increment, message: total ? `${Math.min(100, Math.round(100 * read / total))}%` : undefined });
              });
            });
            if (result.isValid) {
              void vscode.window.showInformationMessage(`${fileName} has no JSON syntax errors.`);
            } else {
              void vscode.window.showWarningMessage(
                `${fileName} has a JSON syntax error at line ${result.line}, column ${result.column}: ${result.message}`
              );
            }
            return;
          }
        } catch (error) {
          void vscode.window.showErrorMessage(errorMessage(error));
          return;
        }
      }

      let document;
      try {
        document = await resolveJsonDocument(resource);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
        return;
      }
      if (!document) {
        void vscode.window.showWarningMessage('Select or open a JSON file before linting.');
        return;
      }

      const error = lintNow(document);
      if (error) {
        void vscode.window.showWarningMessage(
          `JSON syntax error at line ${error.line}, column ${error.column}: ${error.message}. See the Problems panel for details.`
        );
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const previewUri = event.document.uri.toString();
      if (previewPanels.has(previewUri) && !largePreviewUris.has(previewUri)) {
        const previousPreviewTimer = previewTimers.get(previewUri);
        if (previousPreviewTimer) clearTimeout(previousPreviewTimer);
        previewTimers.set(previewUri, setTimeout(() => {
          previewTimers.delete(previewUri);
          refreshJsonPreview(event.document);
        }, 200));
      }
      if (vscode.workspace.getConfiguration('anyajson').get('lintOnChange', true)) {
        scheduleLint(event.document);
      } else {
        updateStatusBar();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.workspace.getConfiguration('anyajson').get('lintOnSave', true)) {
        scheduleLint(document);
      } else {
        updateStatusBar();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const timer = validationTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        validationTimers.delete(key);
      }
      const previewTimer = previewTimers.get(key);
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimers.delete(key);
      }
      diagnostics.delete(document.uri);
      validationStates.delete(key);
      pendingValidations.delete(key);
      updateStatusBar();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const document = editor?.document;
      if (isJsonDocument(document) && !validationStates.has(document.uri.toString())) {
        scheduleLint(document);
      } else {
        updateStatusBar();
      }
    }),
    {
      dispose() {
        for (const timer of validationTimers.values()) clearTimeout(timer);
        validationTimers.clear();
        for (const timer of previewTimers.values()) clearTimeout(timer);
        previewTimers.clear();
      }
    }
  );

  const activeDocument = vscode.window.activeTextEditor?.document;
  if (isJsonDocument(activeDocument) && !validationStates.has(activeDocument.uri.toString())) {
    scheduleLint(activeDocument);
  } else {
    updateStatusBar();
  }
}

function lintDocument(document, diagnostics, validationStates) {
  if (!isJsonDocument(document)) return undefined;
  const key = document.uri.toString();
  try {
    parseJson(document.getText());
    diagnostics.delete(document.uri);
    validationStates.set(key, { version: document.version });
    return undefined;
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    const start = document.positionAt(error.offset);
    const end = document.positionAt(Math.min(error.offset + 1, document.getText().length));
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(start, end),
      error.message,
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'AnyaJSON';
    diagnostic.code = 'syntax';
    diagnostics.set(document.uri, [diagnostic]);
    validationStates.set(key, { version: document.version, error: { offset: error.offset, message: error.message } });
    const position = document.positionAt(error.offset);
    return { line: position.line + 1, column: position.character + 1, message: error.message };
  }
}

async function resolveJsonDocument(resource) {
  const document = resource
    ? await vscode.workspace.openTextDocument(resource)
    : vscode.window.activeTextEditor?.document;
  return isJsonDocument(document) ? document : undefined;
}

function isJsonDocument(document) {
  return Boolean(document && (
    document.languageId === 'json' ||
    (document.uri.scheme === 'file' && path.extname(document.uri.fsPath).toLowerCase() === '.json')
  ));
}

function formatStatusBarIssue(message) {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
}

function resolveIndentOptions(indent) {
  if (indent === '2' || indent === '4') return { insertSpaces: true, tabSize: Number(indent) };
  return { insertSpaces: false };
}

function getIndentOptions() {
  return resolveIndentOptions(vscode.workspace.getConfiguration('anyajson').get('indent', 'tab'));
}

function fullDocumentRange(document) {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function errorMessage(error) {
  if (error instanceof JsonSyntaxError) {
    return `Cannot convert invalid JSON at offset ${error.offset}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function deactivate() {
  // VS Code disposes subscriptions registered during activation.
}

module.exports = { activate, deactivate, parseJson, transformJson, getFilteredJsonTableRows, validateLargeJsonFile, resolveIndentOptions, escapeExcelText };
