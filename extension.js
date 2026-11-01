const vscode = require('vscode');
const crypto = require('node:crypto');
const path = require('node:path');

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
const JSON_NUMBER = Symbol('jsonNumber');

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

function queryJsonTable(preview, request = {}) {
  const filter = typeof request.filter === 'string' ? request.filter.trim().toLocaleLowerCase() : '';
  const filteredRows = filter
    ? preview.rows.filter(row => preview.columns.some(column => (row[column] ?? '').toLocaleLowerCase().includes(filter)))
    : preview.rows;
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
    sourceTotalRows: preview.totalRows
  };
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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(fileName)} JSON preview</title><style>*{box-sizing:border-box}body{color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:16px}.title-bar{display:flex;align-items:center;gap:12px}.title-bar h1{font-size:18px;margin:0}.title-actions{display:flex;gap:4px;margin-left:auto}.icon-button{display:inline-grid;place-items:center;width:30px;height:30px;padding:5px;color:var(--vscode-icon-foreground,var(--vscode-foreground));background:transparent;border:1px solid transparent;border-radius:4px;cursor:pointer}.icon-button:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}.icon-button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}p{color:var(--vscode-errorForeground);white-space:pre-wrap}</style></head><body><div class="title-bar"><h1>${escapeHtml(fileName)}</h1><div class="title-actions"><button id="refresh-preview" class="icon-button" type="button" title="Refresh preview" aria-label="Refresh preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/></svg></button><button id="pop-out" class="icon-button" type="button" title="Pop out preview" aria-label="Pop out preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg></button></div></div><p id="error-message">Could not preview this JSON file: ${escapeHtml(message)}</p><script nonce="${nonce}">(() => { const api = acquireVsCodeApi(); document.getElementById('refresh-preview').addEventListener('click', () => api.postMessage({ type: 'refresh' })); document.getElementById('pop-out').addEventListener('click', () => api.postMessage({ type: 'popout' })); window.addEventListener('message', event => { if (event.data?.type === 'refreshError') document.getElementById('error-message').textContent = 'Could not refresh JSON preview: ' + event.data.message; }); })();</script></body></html>`;
}

function renderJsonPreviewHtml(webview, fileName, preview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const contentSecurityPolicy = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const columnNote = preview.sourceColumnCount > JSON_PREVIEW_MAX_COLUMNS
    ? `<p class="description">Showing the first ${JSON_PREVIEW_MAX_COLUMNS} of ${preview.sourceColumnCount.toLocaleString()} columns.</p>`
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
    body { margin: 0; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
    .title-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .title-bar h1 { margin: 0; font-size: 1.15em; font-weight: 600; overflow-wrap: anywhere; }
    .title-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; flex: 0 0 auto; }
    .icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .toolbar, .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    input, select, button { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; padding: 5px 8px; font: inherit; }
    input { width: min(360px, 100%); }
    input:focus, select:focus, button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    button { cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    #result-count { margin-left: auto; opacity: .8; white-space: nowrap; }
    .description, .meta { margin: 0 0 10px; color: var(--vscode-descriptionForeground); }
    .meta { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
    #source-path { overflow-wrap: anywhere; }
    .table-scroll { max-width: 100%; max-height: calc(100vh - 155px); overflow: auto; border: 1px solid var(--vscode-panel-border); }
    table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; }
    th, td { min-width: 150px; max-width: 420px; padding: 7px 9px; text-align: left; vertical-align: top; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; white-space: pre-wrap; }
    th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorStickyScroll-background, var(--vscode-sideBar-background)); }
    th.row-number, td.row-number { min-width: 54px; width: 54px; text-align: right; color: var(--vscode-descriptionForeground); }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    #status { color: var(--vscode-descriptionForeground); padding: 12px; }
    .pagination { justify-content: flex-end; gap: 6px; }
    .pagination button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; }
    .pagination button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .pagination button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  </style>
</head>
<body>
  <div class="title-bar">
    <h1>${escapeHtml(fileName)}</h1>
    <div class="title-actions">
      <button id="refresh-preview" class="icon-button" type="button" title="Refresh preview" aria-label="Refresh preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/></svg></button>
      <button id="pop-out" class="icon-button" type="button" title="Pop out preview" aria-label="Pop out preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg></button>
    </div>
  </div>
  <div class="toolbar">
    <input id="filter" type="search" placeholder="Filter rows…" aria-label="Filter rows">
    <label for="page-size">Rows per page</label>
    <select id="page-size" aria-label="Rows per page">${JSON_PREVIEW_PAGE_SIZES.map(size => `<option value="${size}"${size === JSON_PREVIEW_PAGE_SIZE ? ' selected' : ''}>${size}</option>`).join('')}</select>
    <span id="result-count" aria-live="polite"></span>
  </div>
  <p class="description">${preview.totalRows.toLocaleString()} rows in this preview.</p>
  ${columnNote}
  <div class="meta"><span id="source-path">Path: ${escapeHtml(preview.sourcePath || '$')}</span><span id="page-info">Loading JSON data…</span></div>
  <div class="table-scroll"><table><thead id="table-head"></thead><tbody id="table-body"></tbody></table><div id="status">Loading JSON data…</div></div>
  <div class="controls pagination" aria-label="Table pagination">
    <button id="previous" type="button" title="Previous page" aria-label="Previous page" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 18l-6-6 6-6"/></svg></button>
    <button id="next" type="button" title="Next page" aria-label="Next page" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 18l6-6-6-6"/></svg></button>
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
      const popOut = document.getElementById('pop-out');
      let page = 0;
      let requestId = 0;
      let filterTimer;
      const request = () => {
        requestId += 1;
        status.textContent = 'Loading…';
        api.postMessage({ type: 'query', filter: filter.value, page, pageSize: Number(pageSize.value), requestId });
      };
      popOut.addEventListener('click', () => api.postMessage({ type: 'popout' }));
      document.getElementById('refresh-preview').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
      const makeCell = (tagName, value, className) => {
        const cell = document.createElement(tagName);
        if (className) cell.className = className;
        cell.textContent = value;
        return cell;
      };
      window.addEventListener('message', event => {
        const result = event.data;
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
          : 'Page ' + (page + 1).toLocaleString() + ' of ' + pages.toLocaleString();
        resultCount.textContent = result.totalRows.toLocaleString() + ' matching / ' + result.sourceTotalRows.toLocaleString() + ' rows';
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
      api.postMessage({ type: 'ready' });
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
  const previewModels = new Map();
  const previewTimers = new Map();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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
    let document;
    try {
      document = await resolveJsonDocument(resource);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
      return;
    }
    if (!document) {
      void vscode.window.showWarningMessage('Select or open a JSON file before previewing it as a table.');
      return;
    }

    const uri = document.uri.toString();
    const fileName = path.basename(document.uri.fsPath) || 'Untitled JSON';
    let preview;
    try {
      preview = buildJsonTablePreview(document.getText());
    } catch (error) {
      void vscode.window.showErrorMessage(`Cannot preview invalid JSON: ${errorMessage(error)}`);
      return;
    }
    previewModels.set(uri, preview);

    let panel = previewPanels.get(uri);
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'anyajson.tablePreview',
        `AnyaJSON: ${fileName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [] }
      );
      previewPanels.set(uri, panel);
      const messageListener = panel.webview.onDidReceiveMessage(message => {
        if (message?.type === 'popout') {
          void vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, error => {
            void vscode.window.showErrorMessage(`Could not pop out the JSON preview: ${errorMessage(error)}`);
          });
          return;
        }
        if (message?.type === 'refresh') {
          const sourceDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
          if (sourceDocument) refreshJsonPreview(sourceDocument);
          else void panel.webview.postMessage({ type: 'refreshError', message: 'The source document is no longer open.' });
          return;
        }
        if (message?.type === 'ready') {
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
      });
      context.subscriptions.push({ dispose: () => { messageListener.dispose(); disposeListener.dispose(); } });
    }

    panel.title = `AnyaJSON: ${fileName}`;
    panel.webview.html = renderJsonPreviewHtml(panel.webview, fileName, preview);
    panel.reveal(vscode.ViewColumn.Beside);
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
      title: 'Lint JSON',
      arguments: [document.uri]
    };

    if (pendingValidations.has(key)) {
      statusBar.text = '$(sync~spin) JSON: Linting';
      statusBar.color = undefined;
      statusBar.tooltip = 'Checking JSON syntax…';
      return;
    }

    const state = validationStates.get(key);
    if (!state) {
      statusBar.text = '$(question) JSON: Not linted';
      statusBar.color = undefined;
      statusBar.tooltip = 'Click to lint this JSON document.';
      return;
    }
    if (state.version !== document.version) {
      statusBar.text = '$(warning) JSON: Needs lint';
      statusBar.color = undefined;
      statusBar.tooltip = 'This document has changed since its last lint. Click to check it.';
      return;
    }
    if (!state.error) {
      statusBar.text = '$(check) JSON: Valid';
      statusBar.color = new vscode.ThemeColor('testing.iconPassed');
      statusBar.tooltip = 'JSON syntax is valid. Click to lint again.';
      return;
    }

    const position = document.positionAt(state.error.offset);
    const line = position.line + 1;
    const column = position.character + 1;
    statusBar.text = `$(error) JSON: syntax error at ${line}:${column}`;
    statusBar.color = new vscode.ThemeColor('testing.iconFailed');
    statusBar.tooltip = `Line ${line}, column ${column}: ${state.error.message}\nClick to lint again.`;
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
      const text = transformJson(document.getText(), minify, {
        insertSpaces: editor.options.insertSpaces,
        tabSize: editor.options.tabSize,
        lineEnding
      });
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
          const formatted = transformJson(document.getText(), false, {
            insertSpaces: options.insertSpaces,
            tabSize: options.tabSize,
            lineEnding
          });
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
      if (!error) {
        void vscode.window.showInformationMessage('JSON syntax is valid.');
      } else {
        void vscode.window.showWarningMessage(
          `JSON syntax error at line ${error.line}, column ${error.column}: ${error.message}. See the Problems panel for details.`
        );
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const previewUri = event.document.uri.toString();
      if (previewPanels.has(previewUri)) {
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

module.exports = { activate, deactivate, parseJson, transformJson };
