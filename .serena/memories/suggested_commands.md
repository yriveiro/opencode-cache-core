Package manager: Bun (v1.3.3). No lockfile present (peerDependencies only, no install needed).

Build scripts (all use bun to invoke tsc.ts):
- Build:     bun run tsc -p tsconfig.json         → writes dist/index.js
- Typecheck: bun run tsc --noEmit -p tsconfig.json → no output on success (exit 0)

tsc.ts is a custom build script that calls Bun.build() with @opencode-ai/plugin marked as external.
No lockfile; no node_modules; @opencode-ai/plugin is a peerDependency typed only via runtime-shims.d.ts.

Useful shell commands on Darwin for this repo:
- bun run tsc -p tsconfig.json
- bun run tsc --noEmit -p tsconfig.json
- ls dist/index.js
- git status --short
