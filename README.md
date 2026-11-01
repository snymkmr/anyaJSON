# AnyaJSON

AnyaJSON formats, minifies, lints, and previews JSON documents in Visual Studio Code.

## Commands

Run these from the Command Palette, the editor context menu, or the JSON file's Explorer context menu:

- **AnyaJSON: Format JSON Document** formats the document using the editor's indentation settings. It also powers **Format Document** for JSON.
- **AnyaJSON: Minify JSON Document** removes whitespace between JSON tokens. Strings and number spellings are preserved.
- **AnyaJSON: Lint JSON Document** checks JSON syntax and reports the first error in the Problems panel.
- **AnyaJSON: Preview JSON as Table** opens an interactive side-by-side table. It detects the most useful array of objects, flattens nested object fields into columns, and supports row filtering, page-size selection, and pop-out. If the JSON has no record array, it previews the root object or value instead. Use the exact-filter icon beside **Export** to switch between substring and exact-value matching. Use the green **Export** button to save all rows matching the current filter as a real Excel workbook (`.xlsx`); it exports the full filtered result, not only the visible page. Values are stored as text so Excel keeps identifiers, dates, and formula-like strings as shown. The export contains the flattened preview table; the JSON source is unchanged. The preview updates as you edit the source.

AnyaJSON also lints open JSON documents after edits (debounced by 500 ms) and when they are saved. The status bar shows the current lint result; click it to lint again.

## Settings

- `anyajson.lintOnChange`: lint after edits, default `true`.
- `anyajson.lintOnSave`: lint on save, default `true`.

AnyaJSON accepts strict JSON syntax. Comments and trailing commas are not valid JSON.

## Privacy

See the [Privacy Policy](https://sanyam.dev/privacy) for privacy information about my projects.
