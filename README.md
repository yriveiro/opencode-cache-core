# OpenCode Cache Core

Concrete OpenCode local plugin package for cache indexing and search.

## Repository layout

- `src/`: plugin source files and type shims.
- `dist/`: generated build output.
- `docs/`: documentation source files.
- `docs-dist/`: generated documentation site.
- `tests/`: test modules and fixtures.

The package default export returns a plugin object with a `tools` map containing the cache tools and a compatibility `permission.ask` hook that auto-allows access to the configured cache directory.

## Tools

- `cache_status`: reports cache/index readiness, freshness, and configured scopes.
- `cache_search`: searches the cached files across all scopes or a selected scope.

## Compatibility permission hook

- `permission.ask`: compatibility hook that auto-allows permission requests for the configured cache directory when the host asks for external directory access.

## Configuration

The plugin reads configuration from the plugin context config object and from environment variables. Context config wins over env values.

Supported fields:

- `cacheDir` / `OPENCODE_CACHE_DIR`
- `indexFile` / `OPENCODE_CACHE_INDEX_FILE`
- `readyPath` / `OPENCODE_CACHE_READY_PATH`
- `sections` / `OPENCODE_CACHE_SECTIONS_JSON`
- `maxAgeSeconds` / `OPENCODE_CACHE_MAX_AGE_SECONDS`
- `statusToolName` / `OPENCODE_CACHE_STATUS_TOOL_NAME`
- `searchToolName` / `OPENCODE_CACHE_SEARCH_TOOL_NAME`

`sections` must be a JSON object whose keys are scope names:

```json
{
  "docs": {
    "baseDir": "/absolute/path/to/cache/docs",
    "patterns": ["**/*.md", "**/*.txt"]
  },
  "code": {
    "baseDir": "/absolute/path/to/cache/code",
    "patterns": ["**/*.ts", "**/*.tsx", "**/*.js"]
  }
}
```

Defaults:

- `cacheDir`: `~/.cache/opencode-cache`
- `indexFile`: `<cacheDir>/.opencode-plugin/index.json`
- `readyPath`: `<cacheDir>/.opencode-plugin/ready`
- `sections`: `{ cache: { baseDir: cacheDir, patterns: ["**/*"] } }`
- `maxAgeSeconds`: `86400`

## Build

```sh
bun run build
```

The source entrypoint is `src/index.ts`.
The compiled plugin entrypoint is `dist/index.js`, which matches `package.json#main`.

## Documentation site

The repo includes a static documentation site under `docs/`.

The documentation is provided as a pre-built HTML file (`docs/index.html`) and does not require a build process.

Documentation coverage includes:

- feature and architecture overview
- configuration and environment-variable mapping
- tool behavior and compatibility hooks
- a code walkthrough with explanation next to live source excerpts
- Mermaid diagrams for lifecycle and request flow
