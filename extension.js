const vscode = require('vscode');
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

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('anyajson');
  const validationStates = new Map();
  const validationTimers = new Map();
  const pendingValidations = new Set();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'AnyaJSON JSON Lint';

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
