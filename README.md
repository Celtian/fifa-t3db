<div align="center">

# ⚽ FIFA t3db

**A portable, read-only-by-default TypeScript library for FIFA PC t3db databases.**

[![TypeScript 6](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun 1.3.14](https://img.shields.io/badge/Bun-1.3.14-000000?logo=bun&logoColor=white)](https://bun.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Binary format](docs/format.md) · [DLL parity audit](docs/dll-parity.md)

</div>

`fifa-t3db` reads and edits PC `fifa_ng_db.db` files that use t3db format version 8, together with their matching `fifa_ng_db-meta.xml` schemas. Game releases are not hard-coded: table and field layouts come from the supplied metadata. The library supports all 137 tables in the supplied fixture, including packed numeric fields and Huffman-compressed UTF-8 strings.

The core library only accepts `Uint8Array` and XML text. It has no filesystem dependency, so the same API works in browsers, Bun, and Node.js.

## ✨ Features

| Feature | Details |
| --- | --- |
| 📖 **Lazy table reading** | Parses table rows only when `readTable()` is called and memoizes the result. |
| ✏️ **Explicit editing** | Updates, inserts, and deletes rows without mutating the original database bytes. |
| 🔑 **Composite keys** | Uses XML keys and indices, then deterministic inference when metadata is insufficient. |
| 🗜️ **Huffman strings** | Reads and rebuilds both compressed-string encodings, including new UTF-8 bytes. |
| ✅ **Strict validation** | Checks signatures, offsets, schemas, field types, ranges, capacities, and record limits. |
| 🧮 **FIFA checksums** | Regenerates database, directory, table-header, and table-record CRC values. |
| 🌐 **Portable ESM** | Ships JavaScript, declarations, declaration maps, and source maps without Node-only imports. |

## 🚀 Install

```sh
bun add fifa-t3db
```

The package is ESM-only and includes its TypeScript declarations.

## 📖 Read a database

```ts
import { openFifaDatabase } from "fifa-t3db";

const database = openFifaDatabase({
  database: databaseBytes,
  metadataXml,
});

console.log(database.header);
console.table(database.listTables());

const players = database.readTable("players");
console.log(players.info.recordCount);
console.log(players.rows[0]?.playerid);
```

Tables can be selected by their XML name or four-character short name. Returned table metadata and rows are immutable. Integer fields include the XML `rangelow` adjustment, while date fields remain raw numbers.

### Browser input

```ts
const [databaseResponse, metadataResponse] = await Promise.all([
  fetch("/fifa_ng_db.db"),
  fetch("/fifa_ng_db-meta.xml"),
]);

const databaseBytes = new Uint8Array(await databaseResponse.arrayBuffer());
const metadataXml = await metadataResponse.text();
```

Browser bundlers only include the portable library. The Node filesystem import used by `demo.ts` is not part of the published `src` build.

### Bun or Node.js input

```ts
import { readFile } from "node:fs/promises";

const [databaseBytes, metadataXml] = await Promise.all([
  readFile("fifa_ng_db.db"),
  readFile("fifa_ng_db-meta.xml", "utf8"),
]);
```

Node buffers extend `Uint8Array`, so they can be passed to `openFifaDatabase()` directly.

## ✏️ Edit and serialize

Editing is opt-in through `openEditableFifaDatabase()`:

```ts
import { openEditableFifaDatabase } from "fifa-t3db";

const editor = openEditableFifaDatabase({ database: databaseBytes, metadataXml });

console.log(editor.getKeyDefinition("leaguerefereelinks"));

editor.updateRow("players", { playerid: 1 }, { overallrating: 87 });
editor.deleteRow("rivals", { teamid1: 1, teamid2: 2 });
editor.insertRow("playernames", {
  nameid: 28999,
  name: "New name",
  commentaryid: 900000,
});

const updatedBytes = editor.serialize();
```

`readTable()` reflects pending edits while continuing to return immutable snapshots. Inserts require complete rows. Key fields cannot be updated; change an identity by deleting the old row and inserting a new one.

### Composite-key behavior

The editor freezes a table's key definition the first time that table is edited:

1. Use all XML fields marked `key="True"`.
2. Prefer the shortest unique XML index containing those fields.
3. Add schema fields deterministically until existing row tuples are unique.

Callers must provide exactly the selected fields. Ambiguous duplicate tuples are rejected, as are inserts that reuse an existing tuple. `getKeyDefinition()` exposes the fields, their `xml`, `index`, or `inferred` source, and whether all existing tuples are unique.

## 🧱 Supported binary format

| Internal type | Decoded value |
| ---: | --- |
| `0` | Fixed-width, null-padded UTF-8 string |
| `3` | Least-significant-bit-first packed integer or raw numeric date |
| `4` | Aligned little-endian float32 |
| `13` | Huffman string with a one-byte decoded-length prefix |
| `14` | Huffman string with a two-byte big-endian decoded-length prefix |

The reader skips records carrying the final-byte invalid flag. The writer compacts deletions, appends inserts, rebuilds changed Huffman blocks deterministically, rewrites offsets and counts, and recalculates every stored FIFA CRC. Unchanged table byte ranges are copied exactly.

See [docs/format.md](docs/format.md) for the binary layout and [docs/dll-parity.md](docs/dll-parity.md) for the static audit against the supplied `FifaLibrary16.dll`.

## 📦 Public API

| Export | Purpose |
| --- | --- |
| `openFifaDatabase()` | Open a lazy, read-only database view. |
| `openEditableFifaDatabase()` | Open an editor with read-through pending changes. |
| `parseMetadataXml()` | Parse and validate a standalone FIFA metadata document. |
| `FifaDatabaseError` | Error type used for malformed data and invalid operations. |

Schema, header, table, field, row, key, and editor types are exported from the package root.

## ⚠️ Scope and limitations

- The PC encoding of t3db format version 8 is supported; Xbox byte order and other format versions are rejected.
- Compatibility depends on a database using that format and being paired with its matching metadata XML; individual game releases are not identified or restricted by the API.
- Metadata XML layouts are read but never rewritten.
- The library intentionally provides no filesystem helpers, CLI, archive handling, or career-mode business logic.
- Changed Huffman tables are logically equivalent to DLL output but are not guaranteed to be byte-identical.
- Stored CRCs are exposed while reading; serialization regenerates them for edited output.

## 🧪 Demo and development

Requirements:

- Bun 1.3.14
- Node.js 24 for Node-based development tools

Install the locked dependencies and print all 52 fixture leagues:

```sh
bun install --frozen-lockfile
bun run demo
```

Run the complete validation suite:

```sh
bun run validate
```

Individual commands are also available:

```sh
bun run lint
bun run lint:fix
bun run typecheck
bun run test
bun run test:coverage
bun run build
```

Generate `CHANGELOG.md` from semantic version tags and Conventional Commit history after the repository has an initial commit:

```sh
bun run changelog
```

The package `version` lifecycle runs `auto-changelog -p` and stages the updated changelog. Use Bun's version command for releases, for example `bun pm version patch`; the resulting `v*` tag is then handled by the publish workflow. Content below the `auto-changelog-above` marker is retained when the generated section is replaced.

Release helpers wrap Bun's version command and create Conventional Commit release messages:

```sh
bun run release:patch
bun run release:minor
bun run release:major
bun run release:beta
```

The version lifecycle updates and stages the changelog, while `postversion` pushes the release commit and tags. `bun run publish:beta` performs a frozen install, runs the complete validation suite, and publishes the staged `dist` package with npm's `beta` tag.

Every build runs `prepare-dist`, which writes a sanitized publish manifest and copies package documentation into `dist`. Stable release tags publish that package to npm, then `gpr:setup` scopes the staged manifest as `@celtian/fifa-t3db` for GitHub Packages. Root package metadata is never mutated.

The test suite materializes all 137 fixture tables and 109,169 valid rows, verifies original and regenerated CRCs, exercises reader/editor edge cases, and enforces 100% statement, branch, function, and line coverage.

Husky runs lint-staged before commits and quick-commitlint against commit messages. Generated output, coverage reports, the database fixture, metadata XML, and the audited DLL are excluded from the published package.

GitHub Actions validates pull requests and pushes to `master` on Ubuntu, publishes coverage artifacts and internal-PR coverage comments, verifies package contents, and runs the fixture demo. A `v*` tag must point at `master` and exactly match the package version before the release workflow publishes to npm. Publishing requires the `NPM_AUTH_TOKEN` repository secret.

## 🤝 Community

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing or submitting changes.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Follow the project [Code of Conduct](CODE_OF_CONDUCT.md) in all community spaces.
- See [SUPPORT.md](SUPPORT.md) for help and issue-reporting guidance.
- User-visible changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## 📄 License

Copyright &copy; 2026 [Dominik Hladík](https://github.com/Celtian).

Licensed under the [MIT License](LICENSE).
