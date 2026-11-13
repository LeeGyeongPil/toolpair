# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-11-13

### Fixed

- CI: `npm run smoke:pack` failed on Node 20 and 22. Their bundled npm 10 runs the `prepare` script during `npm pack --ignore-scripts --json` and mixes its output into the JSON on stdout, so parsing it failed. The packaging check no longer parses npm's stdout: it finds the tarball on disk and lists it with `tar`, and it calls the same npm that runs the script (`npm_execpath`).
- Build: the build progress line now goes to stderr, so `npm pack --json` output stays valid JSON with npm 10.
- CLI: when the output reader closes early (for example `toolpair lint big.json | head -3`), the exit code is the one the command already decided (1 if lint found problems) instead of always 0.
- Demo: a closed output pipe reported as `ECONNRESET` exits quietly like `EPIPE`.

### Changed

- CI runs Node 20, 22 and 24, covering both npm 10 and npm 11.

### Known issues

- The package is not on npm yet; install from GitHub (see the README).
- With npm 11, running `npm pack` prints a `prepare` script warning; it is harmless.
- Reading standard input has no regression test for the `EAGAIN` retry path, and empty input gives a generic error message.
- The 0.1.0 known issues (Korean demo rule texts, Korean in type declarations and example comments) remain.

## [0.1.1] - 2026-11-13

### Fixed

- CLI: reading standard input (`-`) no longer depends on `readFileSync(0)`, which can fail with `EAGAIN`/`EOF` on Linux when stdin is a non-blocking pipe; it now reads in a loop and retries.
- CLI: a closed output pipe reported as `ECONNRESET` (Linux socket pipes) now exits quietly like `EPIPE`.
- CI: the workflow now has least-privilege `permissions` and a job `timeout-minutes`.

### Known issues

- No regression test for the stdin `EAGAIN` retry path.
- Empty standard input gives a generic error message.
- If the output pipe closes early, `lint` can still exit 0 even when it found errors.
- The 0.1.0 known issues (Korean demo rule texts, Korean in type declarations and example comments) remain.

## [0.1.0] - 2026-11-13

First release.

### Added

- `detectFormat`, `validate`, `repair`, `trimToBudget` and `defaultCountTokens` for four chat history formats:
  OpenAI Chat Completions (`messages`), OpenAI Responses (`input` items), Anthropic Messages (`messages`) and Gemini (`contents`).
  Each accepts a bare array or the whole request body (`{messages}`, `{input}`, `{contents}`) and returns the same shape.
- Seven rules with JSON paths and call ids: `orphan-result`, `missing-result`, `open-call-at-end` (warning),
  `duplicate-call-id`, `result-not-adjacent`, `result-not-first` (Anthropic) and `empty-message`.
- Deterministic, idempotent repair with a change log (`drop-orphan-result`, `insert-synthetic-result`, `move-result`,
  `drop-call`, `drop-empty-message`, `merge-same-role`). Policies: `missingResults: "synthesize" | "drop-call"`,
  `openCallAtEnd: "keep" | "cancel"`, custom `syntheticResult`.
- Pair-preserving token budget trim: call + result groups are kept or dropped together, system messages and the first
  user message are pinned, and the kept window always opens on a real user turn. The output always validates.
- `toolpair` CLI with `lint`, `fix` and `trim`, exit codes 0/1/2, `--json`, standard input via `-`,
  and English/Korean screens (`--lang en|ko`, `TOOLPAIR_LANG`, `LC_ALL`/`LC_MESSAGES`/`LANG`).
- ESM + CommonJS builds with type declarations for both, zero runtime dependencies, Node.js 20+ and browsers (core).
- Offline demo (`npm run demo`) and fixtures for every format, including recorded provider error texts with sources.

### Known issues

- The Korean demo rule descriptions are shown in English on some screens.
- The published type declarations and the example comments contain Korean text.
