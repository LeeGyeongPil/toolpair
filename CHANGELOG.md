# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
