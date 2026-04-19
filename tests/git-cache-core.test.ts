import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ALL_SCOPE,
	buildGitCacheSearchIndex,
	createPermissionHandler,
	defineGitCacheSpec,
	formatCommandFailure,
	getGitArtifactDir,
	getGitArtifactReadinessPath,
	getGitCacheFreshness,
	getGitSectionBaseDir,
	getGitSourceDir,
	resolveReadySourceId,
	searchGitCacheIndex,
} from "../src/index";

const tempDirs: string[] = [];

const TEST_SPEC = defineGitCacheSpec({
	schemaVersion: 1,
	title: "Test Cache",
	service: "test-cache",
	envVar: "TEST_CACHE_DIR",
	defaultCacheSubdir: "test-cache",
	initMessage: "test-cache plugin initialized",
	updateTool: {
		name: "test-cache-update",
		description: "Update the test cache.",
		failureLabel: "Failed to update test cache",
		successLogMessage: "test cache update completed",
	},
	statusTool: {
		name: "test-cache-status",
		description: "Report test cache status.",
	},
	searchTool: {
		name: "test-cache-search",
		description: "Search the test cache.",
		missingMessage: "Test cache is not initialized.",
		failureLabel: "Failed to search test cache",
	},
	sources: [
		{
			id: "repo",
			url: "https://github.com/example/repo.git",
			branch: "main",
			directory: "source",
			ready: true,
		},
	],
	artifacts: [
		{
			id: "site",
			source: "repo",
			path: "build",
			readiness: "index.html",
		},
	],
	sections: {
		docs: {
			label: "Docs",
			root: { kind: "source", id: "repo" },
			patterns: ["docs/**/*.md"],
		},
		built: {
			label: "Built",
			root: { kind: "artifact", id: "site" },
			patterns: ["**/*.html"],
		},
	},
});

async function createTempCacheDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opencode-cache-core-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((directory) => {
			return rm(directory, { recursive: true, force: true });
		}),
	);
});

describe("defineGitCacheSpec", () => {
	test("rejects duplicate source ids", () => {
		expect(() => {
			defineGitCacheSpec({
				schemaVersion: 1,
				title: "Broken Cache",
				service: "broken-cache",
				envVar: "BROKEN_CACHE_DIR",
				defaultCacheSubdir: "broken-cache",
				initMessage: "broken-cache plugin initialized",
				updateTool: {
					name: "broken-cache-update",
					description: "Update the broken cache.",
					failureLabel: "Failed to update broken cache",
					successLogMessage: "broken cache update completed",
				},
				statusTool: {
					name: "broken-cache-status",
					description: "Report broken cache status.",
				},
				searchTool: {
					name: "broken-cache-search",
					description: "Search the broken cache.",
					missingMessage: "Broken cache is not initialized.",
					failureLabel: "Failed to search broken cache",
				},
				sources: [
					{ id: "repo", url: "https://github.com/example/repo-a.git", branch: "main" },
					{ id: "repo", url: "https://github.com/example/repo-b.git", branch: "main" },
				],
				sections: {
					docs: {
						label: "Docs",
						root: { kind: "source", id: "repo" },
						patterns: ["README.md"],
					},
				},
			});
		}).toThrow(/Duplicate source id/);
	});

	test("prefers explicit readySource over implicit ready markers", () => {
		const spec = defineGitCacheSpec({
			schemaVersion: 1,
			title: "Ready Cache",
			service: "ready-cache",
			envVar: "READY_CACHE_DIR",
			defaultCacheSubdir: "ready-cache",
			initMessage: "ready-cache plugin initialized",
			updateTool: {
				name: "ready-cache-update",
				description: "Update the ready cache.",
				failureLabel: "Failed to update ready cache",
				successLogMessage: "ready cache update completed",
			},
			statusTool: {
				name: "ready-cache-status",
				description: "Report ready cache status.",
			},
			searchTool: {
				name: "ready-cache-search",
				description: "Search the ready cache.",
				missingMessage: "Ready cache is not initialized.",
				failureLabel: "Failed to search ready cache",
			},
			readySource: "secondary",
			sources: [
				{ id: "primary", url: "https://github.com/example/primary.git", branch: "main", ready: true },
				{ id: "secondary", url: "https://github.com/example/secondary.git", branch: "main" },
			],
			sections: {
				docs: {
					label: "Docs",
					root: { kind: "source", id: "secondary" },
					patterns: ["README.md"],
				},
			},
		});

		expect(resolveReadySourceId(spec)).toBe("secondary");
	});
});

describe("path helpers", () => {
	test("resolve source, artifact, readiness, and section paths", async () => {
		const cacheDir = await createTempCacheDir();

		expect(getGitSourceDir(TEST_SPEC, cacheDir, "repo")).toBe(join(cacheDir, "source"));
		expect(getGitArtifactDir(TEST_SPEC, cacheDir, "site")).toBe(join(cacheDir, "source", "build"));
		expect(getGitArtifactReadinessPath(TEST_SPEC, cacheDir, "site")).toBe(
			join(cacheDir, "source", "build", "index.html"),
		);
		expect(getGitSectionBaseDir(TEST_SPEC, cacheDir, "docs")).toBe(join(cacheDir, "source"));
		expect(getGitSectionBaseDir(TEST_SPEC, cacheDir, "built")).toBe(
			join(cacheDir, "source", "build"),
		);
	});
});

describe("getGitCacheFreshness", () => {
	test("reports fresh and stale timestamps", () => {
		const fresh = getGitCacheFreshness(
			new Date(Date.now() - 5 * 60 * 1000).toISOString(),
			3600,
		);
		const stale = getGitCacheFreshness(
			new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
			3600,
		);
		const missing = getGitCacheFreshness(null, 3600);

		expect(fresh.fresh).toBe(true);
		expect(fresh.timestamp).not.toBeNull();
		expect(stale.fresh).toBe(false);
		expect(stale.hoursAgo).toBeGreaterThanOrEqual(3);
		expect(missing).toEqual({
			ageSeconds: 0,
			fresh: false,
			hoursAgo: 0,
			timestamp: null,
		});
	});
});

describe("search index", () => {
	test("builds and searches source and artifact sections", async () => {
		const cacheDir = await createTempCacheDir();
		const sourceDir = join(cacheDir, "source");
		const docsDir = join(sourceDir, "docs");
		const buildDir = join(sourceDir, "build");

		await mkdir(docsDir, { recursive: true });
		await mkdir(buildDir, { recursive: true });
		await writeFile(join(docsDir, "guide.md"), "# Intro\nNeedle docs\n", "utf8");
		await writeFile(join(buildDir, "index.html"), "<html>Needle built</html>\n", "utf8");

		const index = await buildGitCacheSearchIndex(TEST_SPEC, cacheDir);
		expect(index.sections.docs.files).toEqual(["docs/guide.md"]);
		expect(index.sections.built.files).toEqual(["index.html"]);

		const allResults = await searchGitCacheIndex(index, "needle");
		expect(allResults.scope).toBe(ALL_SCOPE);
		expect(allResults.scannedFiles).toBe(2);
		expect(allResults.hits).toHaveLength(2);
		expect(allResults.hits.map((hit) => hit.scope)).toEqual(["docs", "built"]);

		const scopedResults = await searchGitCacheIndex(index, "Needle", {
			scope: "built",
			caseSensitive: true,
		});
		expect(scopedResults.scope).toBe("built");
		expect(scopedResults.hits).toHaveLength(1);
		expect(scopedResults.hits[0]).toMatchObject({
			scope: "built",
			file: "index.html",
			line: 1,
		});
	});
});

describe("createPermissionHandler", () => {
	test("allows matching cache-directory requests and ignores unrelated ones", async () => {
		const handler = createPermissionHandler("/tmp/example-cache");
		const allowed = { status: "ask" } as { status: string };
		const ignored = { status: "ask" } as { status: string };

		await handler(
			{
				type: "external_directory",
				title: "Access /tmp/example-cache for local docs",
				pattern: undefined,
			} as never,
			allowed as never,
		);

		await handler(
			{
				type: "external_directory",
				title: "Unrelated directory request",
				pattern: ["/tmp/elsewhere"],
			} as never,
			ignored as never,
		);

		expect(allowed.status).toBe("allow");
		expect(ignored.status).toBe("ask");
	});
});

describe("formatCommandFailure", () => {
	test("includes stdout and stderr when present", () => {
		expect(
			formatCommandFailure("Command failed", {
				exitCode: 1,
				stdout: "line one",
				stderr: "line two",
			}),
		).toBe("Command failed\nline one\nline two");
	});
});
