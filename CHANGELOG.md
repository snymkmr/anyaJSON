# Changelog

## 0.2.4

- Stream large JSON table previews from disk, avoiding VS Code's 50 MB text document synchronization limit. Partial previews are limited to 10,000 rows and disable Excel export.
- Validate JSON files larger than 50 MB directly from disk without opening them as editor documents.

## 0.2.1

- Add a Privacy section linking to the project privacy policy.

## 0.2.0

- Rename commands and settings to use the Anya namespace. Update any saved command references and setting keys to the new IDs.
