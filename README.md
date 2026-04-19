# OpenCode Cache Core

Git-first cache runtime and search utilities for OpenCode plugins.

`@yriveiro/opencode-cache-core` is for plugins that keep a local cache of external projects in Git checkouts, build optional derived artifacts from those checkouts, and search that cache locally.

## Quick Start

```ts
import { createGitCachePlugin, defineGitCacheSpec } from "@yriveiro/opencode-cache-core";

const SPEC = defineGitCacheSpec({
  schemaVersion: 1,
  title: "Example Cache",
  service: "example-cache",
  envVar: "OPENCODE_EXAMPLE_CACHE_DIR",
  defaultCacheSubdir: "example",
  initMessage: "example cache plugin initialized",
  updateTool: {
    name: "example-cache-update",
    description: "Clone or refresh the local example cache.",
    failureLabel: "Failed to update example cache",
    successLogMessage: "example cache update completed",
  },
  statusTool: {
    name: "example-cache-status",
    description: "Report cache freshness and search corpus status.",
  },
  searchTool: {
    name: "example-cache-search",
    description: "Search cached example content locally.",
    missingMessage: "Example cache is not initialized. Run example-cache-update first.",
    failureLabel: "Failed to search example cache",
  },
  sources: [
    {
      id: "repo",
      url: "https://github.com/example/project.git",
      branch: "main",
      ready: true,
    },
  ],
  artifacts: [
    {
      id: "site",
      source: "repo",
      path: "dist/docs",
      readiness: "index.html",
    },
  ],
  sections: {
    docs: {
      label: "Docs",
      root: { kind: "source", id: "repo" },
      patterns: ["docs/**/*.md", "docs/**/*.mdx"],
    },
    built: {
      label: "Built docs",
      root: { kind: "artifact", id: "site" },
      patterns: ["**/*.html"],
    },
  },
});

export default createGitCachePlugin({
  spec: SPEC,
});
```

## What The Package Handles

- validate a cache spec
- resolve a local cache directory
- clone or update one or more Git sources
- track source and artifact state in `cache-state.json`
- build and persist `search-index.json`
- expose update, status, and search tools for OpenCode
- provide a runtime context for package-specific tools and status extensions

## Defining A Cache

### Top-level spec fields

- `title`: title used in notifications
- `service`: service name used for host logging
- `envVar`: environment variable that overrides the cache directory
- `defaultCacheSubdir`: default subdirectory under `~/.cache/opencode/skills`
- `initMessage`: initialization log message
- `updateTool`: name, description, failure label, and success log message
- `statusTool`: name and description
- `searchTool`: name, description, missing message, failure label, and optional scope description
- `readySource`: optional source ID used to decide whether the cache is initialized

### Sources

Each entry in `sources` describes one repository checkout.

- `id`: stable identifier used by artifacts and sections
- `url`: Git repository URL
- `branch`: branch to clone and refresh
- `directory`: optional directory name under the cache root; defaults to `id`
- `sparse`: optional sparse-checkout paths
- `ready`: optional marker used when selecting the source that gates initialization
- `label`: optional display name in status output

### Artifacts

Each entry in `artifacts` describes a build output rooted in a source checkout.

- `id`: stable identifier used by sections
- `source`: source ID that owns the artifact
- `path`: path relative to the source directory
- `readiness`: optional file or directory checked by `runtime.isArtifactReady()`
- `label`: optional display name in status output

### Sections

Each entry in `sections` becomes a search scope.

- `label`: display label used in status output
- `root`: either `{ kind: "source", id: "..." }` or `{ kind: "artifact", id: "..." }`
- `patterns`: file globs included in the search index for that scope

## Files On Disk

The cache directory resolves as:

- `process.env[spec.envVar]`, when set
- otherwise `~/.cache/opencode/skills/<spec.defaultCacheSubdir>`

Inside that directory, the runtime writes:

```text
<cacheDir>/
  <source.directory ?? source.id>/
  <source.directory ?? source.id>/<artifact.path>/
  cache-state.json
  search-index.json
```

`cache-state.json` contains:

- `updatedAt` and `indexedAt`
- one state record per source
- one state record per artifact
- per-source revision, sync timestamp, readiness, and message
- per-artifact build timestamp, readiness, and message
- warning strings collected by the runtime

`search-index.json` contains:

- the index creation timestamp
- the resolved cache directory
- one file list per section/scope

## Generated Plugin Behavior

### Update tool

The update tool:

- ensures the cache directory exists
- syncs every source defined in the spec
- updates `cache-state.json`
- rebuilds `search-index.json`
- sends a notification to the active session

If the ready source is already present and the cache is still fresh, the tool returns the current cache summary unless `force` is set.

### Status tool

The status tool reports:

- cache directory
- state file path
- search index path
- freshness and last update time
- source readiness and revisions
- artifact readiness and build times
- indexed file counts per section

`extendStatus(runtime)` can append package-specific lines.

### Search tool

The generated search tool supports:

- `query`
- `scope`
- `regex`
- `case_sensitive`
- `limit`

It loads the persisted index on demand, runs a scoped search, formats hits as text, and sends the same result back to the session as a notification.

The lower-level `searchGitCacheIndex()` helper returns structured search results when a plugin needs the raw data instead of the formatted tool output.

### Permission hook

The generated plugin also registers `permission.ask` for the resolved cache directory. It only allows `external_directory` requests whose title or patterns include that cache path.

## Runtime Context

`extraTools(runtime)` and `extendStatus(runtime)` receive a `GitCacheRuntimeContext`.

Useful properties and methods:

### State and index

- `cacheDir`
- `stateFile`
- `indexFile`
- `readState()`
- `writeState()`
- `updateState()`
- `loadIndex()`
- `refreshIndex()`
- `formatIndexCounts()`

### Paths and readiness

- `getSourceDir()`
- `getArtifactDir()`
- `getArtifactReadinessPath()`
- `isSourceReady()`
- `isArtifactReady()`
- `getSourceRevision()`
- `syncSources()`

### Host and subprocess helpers

- `notify()`
- `log()`
- `runCommand()`
- `formatCommandFailure()`

Typical downstream uses:

- run a docs build after updating sources
- mark an artifact as ready after generating output
- refresh the search index after a build step
- append extra revision/build details to the status tool

## Key Exports

High-level exports:

- `defineGitCacheSpec`
- `createGitCachePlugin`
- `buildGitCacheSearchIndex`
- `searchGitCacheIndex`

State helpers:

- `createInitialGitCacheState`
- `loadGitCacheState`
- `readGitCacheState`
- `writeGitCacheState`
- `getGitCacheFreshness`

Path helpers:

- `getGitSourceDir`
- `getGitArtifactDir`
- `getGitArtifactReadinessPath`
- `getGitSectionBaseDir`
- `getGitCacheIndexPath`

Tool helpers:

- `createStatusTool`
- `createSearchTool`
- `createPermissionHandler`
- `buildNotification`
- `createNotificationSender`

## Validation

Run the core checks with Bun:

```sh
bun run typecheck
bun test
bun run build
```

## Docs

- `README.md`: package guide
- `docs/index.html`: browsable docs page using the same content model
- `tests/git-cache-core.test.ts`: focused tests for spec validation, paths, freshness, search, and permission handling
