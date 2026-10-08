# deckrun

## Goal

deckrun is a local-first presentation tool, published to npm as a CLI. You write slides in Markdown or bring a self-contained HTML document. deckrun serves it on a local server so you can edit, present and export it in the browser.

- Two formats: Markdown decks presented slide by slide, or self-contained HTML documents with continuous scrolling.
- A live editor with preview, autosave and a library of decks and docs. A file passed on the CLI is edited in place and saved back to disk. Changes made to the file on disk reload the editor.
- 14 themes, custom heading and body fonts, four composition templates and five transitions.
- KaTeX equations and Mermaid diagrams, incremental reveals, and presenter tools (laser pointer, drawing pen, blank canvas, blackout mode, highlights and comments).
- `deckrun lint` checks decks for empty slides, broken fences or math, dense content, image issues and invalid reveal markers. It runs locally or in CI and supports `--format json`.
- Export to Markdown, HTML, headless-rendered PDF, or a standalone presenter-ready HTML page.

## Stack

- TypeScript, ESM (`"type": "module"`), compiled with `tsc` to `dist/`. The bin is `deckrun` -> `dist/index.js`.
- Node >= 26 (confirmed: `engines.node = ">=26"`). The floor moved from Node 24 to Node 26 in a recent commit.
- Runtime deps: `commander` ^15 (CLI), `marked` ^18 (Markdown), `katex` ^0.18.7, `mermaid` ^11.17.2, `sanitize-html` ^2.17.7 and `open` ^11 (launches the browser).
- Dev: TypeScript ^7, `tsx` (for `npm run dev`), `@types/node` ^26. Tests use the built-in `node --test`, run after a build.
- License MIT. Third-party licenses are listed in `THIRD-PARTY-NOTICES.md`, which ships in the npm package.

## Repo

- `dustfeather/deckrun` (confirmed: `git@github.com:dustfeather/deckrun.git`). The README's raw install links point at the `master` branch.
- Layout: source in `src/`, build output in `dist/`, tests in `test/`, sample decks in `examples/` (e.g. `example-2.md`).
- Installers: `install.sh` for Linux/macOS (installs Node >= 26 if it is missing) and `install.ps1` for Windows (installs Node LTS through winget or a download).
- `.githooks/` is enabled by the `prepare` script (`core.hooksPath`). The pre-commit hook includes a dependency audit.
- `.github/workflows/` holds CI and npm publishing. `PUBLISHING.md` documents the release process.
- `graphify-out/` has Graphify snapshots dated 2026-09-07, 2026-09-12 and 2026-09-18. `.serena/` holds Serena memories.

## Deploy

Published to npm as the public package `@dustfeather/deckrun`. CI builds the package once and publishes that exact tarball. Publishing runs on a GitHub-hosted runner so npm provenance verifies, and it uses no stored token. Users run it on their own machine with `npx @dustfeather/deckrun`, `npm i -g`, or the curl/irm one-line installers. It is not hosted on the homelab cluster: the server runs locally and binds only to `127.0.0.1` (default port 7890).

## Status

active, at v2.0.1. Recent work:

- Moved the Node floor from 24 to 26 and upgraded to commander 15 and TypeScript 7.
- Changed where CI runs: from GitHub-hosted runners to the repo's own ARC pool, with publishing going back to a GitHub-hosted runner for provenance.
- Switched to build-once publishing, token-less publishing and a dependency audit on every commit.
- Pinned the KaTeX CDN asset to the installed package version.
- Documented why Mermaid is held at 11.

## Notes

- Security model: the server binds to `127.0.0.1` only. It answers only requests whose `Host` header is `127.0.0.1`, `localhost` or `[::1]` on its port, which defends against DNS rebinding. Anything else running on the same machine can still reach it.
- Storage: library decks are kept in browser local storage until you export them, and nothing is uploaded. Highlights and comments last only for the browser session. A document opened from a URL is read-only toward its source: nothing is written back to it.
- CDN pins: KaTeX and Mermaid are both npm dependencies and are also loaded from a CDN. Their CDN versions have to stay in step with the installed packages. A recent commit records why Mermaid is held at 11 and how to move a CDN pin.
- Area: Software Engineering

## Log

- **2026-09-29** — Note created from repo scan.
