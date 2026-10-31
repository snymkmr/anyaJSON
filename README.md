# AnyJSON

AnyJSON formats, minifies, and lints JSON documents in Visual Studio Code.

## Commands

Run these from the Command Palette, the editor context menu, or the JSON file's Explorer context menu:

- **AnyJSON: Format JSON Document** formats the document using the editor's indentation settings. It also powers **Format Document** for JSON.
- **AnyJSON: Minify JSON Document** removes whitespace between JSON tokens. Strings and number spellings are preserved.
- **AnyJSON: Lint JSON Document** checks JSON syntax and reports the first error in the Problems panel.

AnyJSON also lints open JSON documents after edits (debounced by 500 ms) and when they are saved. The status bar shows the current lint result; click it to lint again.

## Settings

- `anyjson.lintOnChange`: lint after edits, default `true`.
- `anyjson.lintOnSave`: lint on save, default `true`.

AnyJSON accepts strict JSON syntax. Comments and trailing commas are not valid JSON.
