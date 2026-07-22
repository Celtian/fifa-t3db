# Contributing

Thank you for helping improve `fifa-t3db`. Contributions should preserve the library's strict validation, browser portability, and FIFA 16 PC binary compatibility.

## Before you start

- Search existing issues before opening a new report or proposal.
- Report suspected vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.
- Do not submit proprietary or personal database contents. Reduce binary failures to the smallest safe reproduction possible.
- Discuss large API changes, new platforms, or format assumptions before implementing them.

## Development setup

Requirements:

- Bun 1.3.14
- Node.js 24 for Node-based development tools

Install the exact dependency graph:

```sh
bun install --frozen-lockfile
```

Run the complete validation suite before submitting a pull request:

```sh
bun run validate
```

The individual lint, typecheck, test, coverage, build, and demo commands are documented in [README.md](README.md#-demo-and-development).

## Making changes

- Keep the public API browser-compatible. Files under `src/` must not import Node-only modules.
- Add tests for behavior changes and malformed-input boundaries. Coverage must remain at 100% for statements, branches, functions, and lines.
- Update [README.md](README.md) for public API or user-visible behavior changes.
- Keep commit subjects meaningful because `bun run changelog` derives release notes from Git history. Do not manually edit generated content above the `auto-changelog-above` marker in [CHANGELOG.md](CHANGELOG.md).
- Update [docs/format.md](docs/format.md) when binary layout assumptions change.
- Update [docs/dll-parity.md](docs/dll-parity.md) when DLL-derived behavior changes. A different DLL requires a new hash audit.
- Preserve `example/fifa_ng_db.db`, `example/fifa_ng_db-meta.xml`, and `FifaLibrary16.dll` byte-for-byte unless the contribution explicitly replaces and re-audits a fixture.
- Do not commit `dist/`, `coverage/`, dependency directories, or generated package archives.

Use Conventional Commit messages such as `fix(reader): reject truncated field descriptors`. The repository's commit hook validates this format.

## Pull requests

Keep pull requests focused and explain:

1. What behavior changes and why.
2. Whether the public API or serialized format changes.
3. How the change was tested.
4. Any intentional difference from `FifaLibrary16.dll`.

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).
