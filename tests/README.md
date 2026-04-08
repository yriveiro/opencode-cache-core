# Tests

This directory is reserved for automated tests, fixtures, and verification notes for the `opencode-cache-core` package.

## Intended testing strategy

The plugin should be covered at three levels:

- unit tests for cache parsing, configuration resolution, readiness/freshness checks, and search formatting helpers;
- integration-style tests for plugin construction, tool registration, and `permission.ask` compatibility behavior;
- fixture-driven tests for index loading and search results across representative cache scopes and file patterns.

## What should be tested

Priority scenarios for this plugin include:

- configuration precedence between plugin context values and environment variables;
- default path generation for `cacheDir`, `indexFile`, `readyPath`, and default sections;
- `cache_status` output for ready, stale, missing, and invalid index states;
- `cache_search` behavior for query matching, scope filtering, regex mode, case sensitivity, and result limiting;
- permission matching logic that allows only the configured cache directory through `permission.ask`;
- build/runtime coherence that ensures `src/index.ts` remains aligned with the published `dist/index.js` artifact.

## Current verification state

- This repository currently has no checked-in automated test suite in `tests/`.
- Verification today relies on source review, type checking, and manual build validation.
- Gaps remain around regression coverage for tool output, permission handling, and cache fixture variations.

## When tests are added

Keep fixtures small and representative, prefer deterministic cache/index inputs, and document any manual verification steps that still cannot be automated.
