# AnyaJSON

AnyaJSON formats, minifies, lints, and previews JSON documents in Visual Studio Code.

## Commands

Run these from the Command Palette, the editor context menu, or the JSON file's Explorer context menu:

- **AnyaJSON: Format JSON Document** formats the document with tab indentation by default (see `anyajson.indent`). It also powers **Format Document** for JSON. Keys, key order, duplicate keys, number spellings and string escapes are kept exactly as written.
- **AnyaJSON: Minify JSON Document** removes whitespace between JSON tokens. Everything else stays byte-for-byte as written, including number spellings such as `1.0` and `1e5`, large integers, `\u` escapes, key order and duplicate keys.
- **AnyaJSON: Lint JSON Document** checks JSON syntax and reports the first error in the Problems panel.
- **AnyaJSON: Preview JSON as Table** opens an interactive side-by-side table. It detects the most useful array of objects, flattens nested object fields into columns, and supports row filtering, page-size selection, and pop-out. If the JSON has no record array, it previews the root object or value instead. Use the exact-filter icon beside **Export** to switch between substring and exact-value matching. Use the green **Export** button to save all rows matching the current filter as a real Excel workbook (`.xlsx`); it exports the full filtered result, not only the visible page. Values are stored as text so Excel keeps identifiers, dates, and formula-like strings as shown. The export contains the flattened preview table; the JSON source is unchanged. The preview updates as you edit the source.

  For files larger than 50 MB, AnyaJSON streams a root array or arrays nested inside root objects from disk, so those files do not need to be opened as editor documents. Large-file previews load at most 10,000 rows. Filtering applies to the loaded rows, and Excel export is disabled when the preview is partial. Save the file before refreshing to include recent edits.

AnyaJSON also lints open JSON documents after edits (debounced by 500 ms) and when they are saved. The status bar shows the current lint result; click it to lint again.

For files larger than 50 MB, right-click the saved JSON file in Explorer and run **AnyaJSON: Lint JSON Document**. AnyaJSON validates it directly from disk and reports the first syntax error in a message; these files are not opened in the editor, so they do not receive Problems-panel diagnostics.

## Settings

- `anyajson.indent`: indentation for formatting, `tab` (default), `2` or `4` spaces, or `editor` to follow the file's editor indentation (tabs or spaces and tab size).
- `anyajson.lintOnChange`: lint after edits, default `true`.
- `anyajson.lintOnSave`: lint on save, default `true`.

AnyaJSON accepts strict JSON syntax. Comments and trailing commas are not valid JSON.

## Privacy

See the [Privacy Policy](https://privacy.sanyam.dev) for privacy information about my projects.
