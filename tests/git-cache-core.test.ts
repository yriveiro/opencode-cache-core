import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";
import {
	getGitArtifactDir,
	getGitArtifactReadinessPath,
	getGitSectionBaseDir,
	getGitSourceDir,
} from "../src/git-cache-paths";
import {
	buildGitCacheSearchIndex,
	buildGitCacheUpdateProgressDisplay,
	createGitCachePlugin,
	formatCommandFailure,
	type GitCacheIndexProgress,
	type GitCacheUpdateProgress,
	publishGitCacheUpdateProgress,
	runCommand,
	searchGitCacheIndex,
	updateGitCache,
} from "../src/git-cache-plugin";
import {
	defineGitCacheSpec,
	resolveReadySourceId,
} from "../src/git-cache-schema";
import { getGitCacheFreshness } from "../src/git-cache-state";
import { createPermissionHandler } from "../src/permissions";
import { ALL_SCOPE } from "../src/types";

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

async function initializeGitRepository(directory: string): Promise<void> {
	const commands: Array<readonly [string, readonly string[]]> = [
		["git", ["init"]],
		["git", ["branch", "-M", "main"]],
		["git", ["add", "."]],
		[
			"git",
			[
				"-c",
				"commit.gpgsign=false",
				"-c",
				"user.name=Test User",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"Initial commit",
			],
		],
	];

	for (const [command, args] of commands) {
		const result = await runCommand(command, args, directory);
		expect(result.exitCode).toBe(0);
	}
}

function createMockClient(notifications: string[]): PluginInput["client"] {
	return {
		app: {
			log: async () => true,
		},
		session: {
			prompt: async (input: { body: { parts: Array<{ text: string }> } }) => {
				notifications.push(input.body.parts[0].text);
				return {};
			},
		},
	} as PluginInput["client"];
}

function createMockToolContext(
	cacheDir: string,
	metadataUpdates: Array<{
		title?: string;
		metadata?: Record<string, unknown>;
	}>,
): ToolContext {
	return {
		sessionID: "session-1",
		messageID: "message-1",
		agent: "build",
		directory: cacheDir,
		worktree: cacheDir,
		abort: new AbortController().signal,
		metadata(input) {
			metadataUpdates.push(input);
		},
		ask: async () => {},
	};
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
					{
						id: "repo",
						url: "https://github.com/example/repo-a.git",
						branch: "main",
					},
					{
						id: "repo",
						url: "https://github.com/example/repo-b.git",
						branch: "main",
					},
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
				{
					id: "primary",
					url: "https://github.com/example/primary.git",
					branch: "main",
					ready: true,
				},
				{
					id: "secondary",
					url: "https://github.com/example/secondary.git",
					branch: "main",
				},
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

		expect(getGitSourceDir(TEST_SPEC, cacheDir, "repo")).toBe(
			join(cacheDir, "source"),
		);
		expect(getGitArtifactDir(TEST_SPEC, cacheDir, "site")).toBe(
			join(cacheDir, "source", "build"),
		);
		expect(getGitArtifactReadinessPath(TEST_SPEC, cacheDir, "site")).toBe(
			join(cacheDir, "source", "build", "index.html"),
		);
		expect(getGitSectionBaseDir(TEST_SPEC, cacheDir, "docs")).toBe(
			join(cacheDir, "source"),
		);
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
		await writeFile(
			join(docsDir, "guide.md"),
			"# Intro\nNeedle docs\n",
			"utf8",
		);
		await writeFile(
			join(buildDir, "index.html"),
			"<html>Needle built</html>\n",
			"utf8",
		);

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

	test("reports section progress while building the search index", async () => {
		const cacheDir = await createTempCacheDir();
		const sourceDir = join(cacheDir, "source");
		const docsDir = join(sourceDir, "docs");
		const buildDir = join(sourceDir, "build");

		await mkdir(docsDir, { recursive: true });
		await mkdir(buildDir, { recursive: true });
		await writeFile(join(docsDir, "guide.md"), "Needle docs\n", "utf8");
		await writeFile(join(buildDir, "index.html"), "Needle built\n", "utf8");

		const progress: Array<{
			phase: GitCacheIndexProgress<"docs" | "built">["phase"];
			scope: "docs" | "built";
			index: number;
			total: number;
			fileCount: number | null;
		}> = [];

		await buildGitCacheSearchIndex(TEST_SPEC, cacheDir, {
			onProgress: (event) => {
				progress.push({
					phase: event.phase,
					scope: event.scope,
					index: event.index,
					total: event.total,
					fileCount: event.fileCount ?? null,
				});
			},
		});

		expect(progress).toEqual([
			{ phase: "start", scope: "docs", index: 1, total: 2, fileCount: null },
			{
				phase: "complete",
				scope: "docs",
				index: 1,
				total: 2,
				fileCount: 1,
			},
			{ phase: "start", scope: "built", index: 2, total: 2, fileCount: null },
			{
				phase: "complete",
				scope: "built",
				index: 2,
				total: 2,
				fileCount: 1,
			},
		]);
	});

	test(
		"update tool emits progress notifications and metadata",
		async () => {
			const originDir = await createTempCacheDir();
			const cacheDir = await createTempCacheDir();
			const docsDir = join(originDir, "docs");
			const buildDir = join(originDir, "build");

			await mkdir(docsDir, { recursive: true });
			await mkdir(buildDir, { recursive: true });
			await writeFile(join(docsDir, "guide.md"), "Needle docs\n", "utf8");
			await writeFile(join(buildDir, "index.html"), "Needle built\n", "utf8");
			await initializeGitRepository(originDir);

			const envVar = "TEST_PROGRESS_CACHE_DIR";
			const previousEnv = process.env[envVar];
			process.env[envVar] = cacheDir;

			try {
				const spec = defineGitCacheSpec({
					schemaVersion: 1,
					title: "Progress Cache",
					service: "progress-cache",
					envVar,
					defaultCacheSubdir: "progress-cache",
					initMessage: "progress cache plugin initialized",
					updateTool: {
						name: "progress-cache-update",
						description: "Update the progress cache.",
						failureLabel: "Failed to update progress cache",
						successLogMessage: "progress cache update completed",
					},
					statusTool: {
						name: "progress-cache-status",
						description: "Report progress cache status.",
					},
					searchTool: {
						name: "progress-cache-search",
						description: "Search the progress cache.",
						missingMessage: "Progress cache is not initialized.",
						failureLabel: "Failed to search progress cache",
					},
					sources: [
						{
							id: "repo",
							url: pathToFileURL(originDir).href,
							branch: "main",
							directory: "source",
							ready: true,
						},
					],
					artifacts: TEST_SPEC.artifacts,
					sections: TEST_SPEC.sections,
				});

				const notifications: string[] = [];
				const metadataUpdates: Array<{
					title?: string;
					metadata?: Record<string, unknown>;
				}> = [];

				const plugin = createGitCachePlugin({ spec });
				const hooks = await plugin({
					client: createMockClient(notifications),
				} as PluginInput);

				const updateTool = (hooks.tool as Hooks["tool"])?.[
					spec.updateTool.name
				];
				expect(updateTool).toBeDefined();
				if (updateTool == null) {
					throw new Error("Expected update tool to be defined");
				}

				const output = await updateTool.execute(
					{},
					createMockToolContext(cacheDir, metadataUpdates),
				);

				expect(output).toContain("State file:");
				expect(output).toContain("Search index:");
				expect(notifications).toHaveLength(5);
				expect(
					notifications.some((message) => message.includes("Update started")),
				).toBe(true);
				expect(
					notifications.some((message) =>
						message.includes("Synced source 1/1: repo"),
					),
				).toBe(true);
				expect(
					notifications.some((message) =>
						message.includes("Indexed section 1/2: Docs"),
					),
				).toBe(true);
				expect(
					notifications.some((message) =>
						message.includes("Indexed section 2/2: Built"),
					),
				).toBe(true);
				expect(
					metadataUpdates.some(
						(update) =>
							update.title === "Updating Progress Cache: syncing 1/1 (repo)",
					),
				).toBe(true);
				expect(
					metadataUpdates.some(
						(update) =>
							update.title === "Updating Progress Cache: indexing 1/2 (Docs)",
					),
				).toBe(true);
				expect(
					metadataUpdates.some(
						(update) => update.title === "Updating Progress Cache: complete",
					),
				).toBe(true);
			} finally {
				if (previousEnv == null) {
					delete process.env[envVar];
				} else {
					process.env[envVar] = previousEnv;
				}
			}
		},
		{ timeout: 15000 },
	);

	test("consumers can publish update progress with the shared helper", () => {
		const metadataUpdates: Array<{
			title?: string;
			metadata?: Record<string, unknown>;
		}> = [];
		const progress: GitCacheUpdateProgress<"docs" | "built"> = {
			phase: "index",
			progress: {
				phase: "complete",
				scope: "docs",
				index: 1,
				total: 2,
				baseDir: "/tmp/cache/source",
				patterns: ["docs/**/*.md"],
				fileCount: 3,
			},
			sources: 1,
			sections: 2,
		};

		const display = buildGitCacheUpdateProgressDisplay({
			spec: TEST_SPEC,
			progress,
			cacheDir: "/tmp/cache",
		});

		expect(display).toEqual({
			title: "Updating Test Cache: indexed 1/2 (Docs)",
			metadata: {
				phase: "index",
				status: "complete",
				sources: 1,
				sections: 2,
				scope: "docs",
				current: 1,
				total: 2,
				fileCount: 3,
			},
			message: "Indexed section 1/2: Docs\nFiles: 3",
		});

		const published = publishGitCacheUpdateProgress(
			createMockToolContext("/tmp/cache", metadataUpdates),
			{
				spec: TEST_SPEC,
				progress: {
					phase: "start",
					sources: 1,
					sections: 2,
				},
				cacheDir: "/tmp/cache",
			},
		);

		expect(published.message).toBe(
			"Update started\nCache directory: /tmp/cache\nSources: 1\nSections: 2",
		);
		expect(metadataUpdates).toEqual([
			{
				title: "Updating Test Cache: starting",
				metadata: {
					phase: "start",
					sources: 1,
					sections: 2,
				},
			},
		]);
	});

	test("consumers can run updateGitCache with one progress stream", async () => {
		const cacheDir = await createTempCacheDir();
		const sourceDir = join(cacheDir, "source");
		const docsDir = join(sourceDir, "docs");
		const buildDir = join(sourceDir, "build");

		await mkdir(docsDir, { recursive: true });
		await mkdir(buildDir, { recursive: true });
		await writeFile(join(docsDir, "guide.md"), "Needle docs\n", "utf8");
		await writeFile(join(buildDir, "index.html"), "Needle built\n", "utf8");

		const updates: GitCacheUpdateProgress<"docs" | "built">[] = [];
		const runtime = {
			cacheDir,
			stateFile: join(cacheDir, "cache-state.json"),
			indexFile: join(cacheDir, "search-index.json"),
			maxAgeSeconds: 3600,
			readState: async () => ({ updatedAt: null }),
			loadIndex: async () => null,
			refreshIndex: async (options?: {
				onProgress?: (
					progress: GitCacheIndexProgress<"docs" | "built">,
				) => Promise<void> | void;
			}) => {
				return buildGitCacheSearchIndex(TEST_SPEC, cacheDir, options);
			},
			formatIndexCounts: (
				index: Awaited<ReturnType<typeof buildGitCacheSearchIndex>>,
			) => [
				`Docs files: ${index.sections.docs.files.length}`,
				`Built files: ${index.sections.built.files.length}`,
			],
			syncSources: async (options?: {
				onProgress?: (progress: {
					phase: "start" | "complete";
					sourceId: string;
					label: string;
					current: number;
					total: number;
					revision?: string | null;
					ready?: boolean;
					message?: string | null;
				}) => Promise<void> | void;
			}) => {
				await options?.onProgress?.({
					phase: "start",
					sourceId: "repo",
					label: "repo",
					current: 1,
					total: 1,
				});
				await options?.onProgress?.({
					phase: "complete",
					sourceId: "repo",
					label: "repo",
					current: 1,
					total: 1,
					revision: "abc123",
					ready: true,
					message: null,
				});
				return ["  Updated repo"];
			},
			isSourceReady: async () => false,
		};

		const result = await updateGitCache({
			runtime,
			spec: TEST_SPEC,
			options: {
				onProgress: (progress) => {
					updates.push(progress);
				},
			},
		});

		expect(updates.map((event) => event.phase)).toEqual([
			"start",
			"sync",
			"sync",
			"index",
			"index",
			"index",
			"index",
			"complete",
		]);
		expect(result.lines).toContain(`State file: ${runtime.stateFile}`);
		expect(result.lines).toContain(`Search index: ${runtime.indexFile}`);
		expect(result.fresh).toBe(false);
	});
});

describe("createPermissionHandler", () => {
	test("allows matching cache-directory requests and ignores unrelated ones", async () => {
		const handler = createPermissionHandler("/tmp/example-cache");
		const allowed = { status: "ask" } as const satisfies {
			status: "ask" | "deny" | "allow";
		};
		const ignored = { status: "ask" } as const satisfies {
			status: "ask" | "deny" | "allow";
		};

		await handler(
			{
				type: "external_directory",
				title: "Access /tmp/example-cache for local docs",
				pattern: undefined,
			} as Parameters<typeof handler>[0],
			allowed as Parameters<typeof handler>[1],
		);

		await handler(
			{
				type: "external_directory",
				title: "Unrelated directory request",
				pattern: ["/tmp/elsewhere"],
			} as Parameters<typeof handler>[0],
			ignored as Parameters<typeof handler>[1],
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
