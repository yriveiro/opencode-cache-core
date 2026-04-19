# Tests

This directory contains automated verification for the Git-first cache core.

## Current Coverage

- `tests/git-cache-core.test.ts`

The checked-in test suite currently covers:

- Git cache spec validation and ready-source resolution
- source, artifact, and section path resolution
- cache freshness calculation from persisted timestamps
- search-index construction and scoped search behavior
- permission handling for cache-directory access requests
- command failure formatting

## Current Gaps

The suite does not yet cover:

- end-to-end Git subprocess execution against real repositories
- full OpenCode host integration for tool registration and notifications
- artifact build flows implemented by downstream plugins

## Running Tests

```sh
bun test
```
