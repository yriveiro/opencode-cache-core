import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { tool, type Hooks, type Plugin, type ToolDefinition } from "@opencode-ai/plugin";

import { buildIndex } from "./indexing";
import {
	defineGitCacheSpec,
	getGitCacheScopes,
	resolveReadySourceId,
	type GitCacheSourceSpec,
	type GitCacheSpec,
} from "./git-cache-schema";
import {
	getGitArtifactDir,
	getGitArtifactReadinessPath,
	getGitCacheIndexPath,
	getGitSectionBaseDir,
	getGitSourceDir,
	getGitSourceDirectoryName,
} from "./git-cache-paths";
import {
	createInitialGitCacheState,
	getGitCacheFreshness,
	getGitCacheStateFile,
	loadGitCacheState,
	type GitCacheArtifactState,
	type GitCacheState,
	writeGitCacheState,
} from "./git-cache-state";
import { buildNotification, createNotificationSender } from "./notifications";
import { createPermissionHandler } from "./permissions";
import { searchIndex } from "./search";
import { pathExists, readIndex, writeIndex } from "./storage";
import { createSearchTool, createStatusTool } from "./tools";
import { ALL_SCOPE, type Index, type SearchResult } from "./types";

export const DEFAULT_GIT_CACHE_MAX_AGE_SECONDS = 86_400;

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function formatErrorMessage(prefix: string, error: unknown): string {
	const details = error instanceof Error ? error.message : String(error);
	return `${prefix}: ${details}`;
}

async function logInitialization(input: {
	client: Parameters<Plugin>[0]["client"];
	service: string;
	message: string;
}): Promise<void> {
	await input.client.app.log({
		body: {
			service: input.service,
			level: "info",
			message: input.message,
		},
	});
}

function createEmptyArtifactState(directory: string): GitCacheArtifactState {
	return {
		directory,
		builtAt: null,
		ready: false,
		message: null,
	};
}

function getSparseEntries(source: Pick<GitCacheSourceSpec, "sparse">): string[] {
	return source.sparse == null ? [] : [...source.sparse];
}

function resolveGitCacheDir(
	envVar: string,
	defaultCacheSubdir: string,
	homeDirectory = homedir(),
): string {
	const configuredCacheDir = process.env[envVar];
	if (configuredCacheDir != null && configuredCacheDir.length > 0) {
		return configuredCacheDir;
	}

	return join(homeDirectory, ".cache", "opencode", "skills", defaultCacheSubdir);
}

export function formatCommandFailure(title: string, result: CommandResult): string {
	const details = [result.stdout, result.stderr]
		.filter((value) => value.length > 0)
		.join("\n");

	return details.length > 0 ? `${title}\n${details}` : title;
}

export async function runCommand(
	command: string,
	args: readonly string[],
	cwd?: string,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			reject(error);
		});

		child.on("close", (code) => {
			resolve({
				exitCode: code ?? -1,
				stdout: stdout.trimEnd(),
				stderr: stderr.trimEnd(),
			});
		});
	});
}

async function syncGitSource(
	sourceDir: string,
	source: GitCacheSourceSpec,
): Promise<string[]> {
	const sourceName = getGitSourceDirectoryName(source);
	const installed = await pathExists(join(sourceDir, ".git"));
	const lines: string[] = [];

	if (!installed) {
		lines.push(`Cloning ${sourceName}...`);

		let result: CommandResult;
		if (source.sparse != null) {
			result = await runCommand("git", [
				"clone",
				"--filter=blob:none",
				"--no-checkout",
				"--depth",
				"1",
				"--branch",
				source.branch,
				source.url,
				sourceDir,
			]);
			if (result.exitCode !== 0) {
				throw new Error(formatCommandFailure(`Failed to clone ${sourceName}.`, result));
			}

			result = await runCommand("git", ["sparse-checkout", "init", "--cone"], sourceDir);
			if (result.exitCode !== 0) {
				throw new Error(
					formatCommandFailure(
						`Failed to initialize sparse checkout for ${sourceName}.`,
						result,
					),
				);
			}

			result = await runCommand(
				"git",
				["sparse-checkout", "set", ...getSparseEntries(source)],
				sourceDir,
			);
			if (result.exitCode !== 0) {
				throw new Error(
					formatCommandFailure(
						`Failed to configure sparse checkout for ${sourceName}.`,
						result,
					),
				);
			}

			result = await runCommand("git", ["checkout", source.branch], sourceDir);
			if (result.exitCode !== 0) {
				throw new Error(
					formatCommandFailure(`Failed to checkout ${source.branch}.`, result),
				);
			}
		} else {
			result = await runCommand("git", [
				"clone",
				"--depth",
				"1",
				"--branch",
				source.branch,
				source.url,
				sourceDir,
			]);
			if (result.exitCode !== 0) {
				throw new Error(formatCommandFailure(`Failed to clone ${sourceName}.`, result));
			}
		}

		lines.push(`  Cloned ${sourceName}`);
		return lines;
	}

	lines.push(`Updating ${sourceName}...`);

	let result = await runCommand(
		"git",
		["fetch", "--depth", "1", "origin", source.branch],
		sourceDir,
	);
	if (result.exitCode !== 0) {
		throw new Error(formatCommandFailure(`Failed to fetch ${sourceName}.`, result));
	}

	result = await runCommand(
		"git",
		["reset", "--hard", `origin/${source.branch}`],
		sourceDir,
	);
	if (result.exitCode !== 0) {
		throw new Error(formatCommandFailure(`Failed to reset ${sourceName}.`, result));
	}

	if (source.sparse != null) {
		result = await runCommand(
			"git",
			["sparse-checkout", "set", ...getSparseEntries(source)],
			sourceDir,
		);
		if (result.exitCode !== 0) {
			throw new Error(
				formatCommandFailure(
					`Failed to refresh sparse checkout for ${sourceName}.`,
					result,
				),
			);
		}
	}

	lines.push(`  Updated ${sourceName}`);
	return lines;
}

async function readGitRevision(directory: string): Promise<string | null> {
	const result = await runCommand("git", ["rev-parse", "--short", "HEAD"], directory);
	return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : null;
}

function isIndexForScopes<TScope extends string>(
	value: unknown,
	scopes: readonly TScope[],
): value is Index<TScope> {
	if (typeof value !== "object" || value == null) {
		return false;
	}

	const sections = (value as { sections?: unknown }).sections;
	if (typeof sections !== "object" || sections == null) {
		return false;
	}

	for (const scope of scopes) {
		const section = (sections as Record<string, unknown>)[scope];
		if (typeof section !== "object" || section == null) {
			return false;
		}

		const files = (section as { files?: unknown }).files;
		if (!Array.isArray(files)) {
			return false;
		}
	}

	return true;
}

export async function buildGitCacheSearchIndex<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
): Promise<Index<TScope>> {
	const sections = {} as Record<TScope, { baseDir: string; patterns: readonly string[] }>;

	for (const scope of getGitCacheScopes(spec)) {
		sections[scope] = {
			baseDir: getGitSectionBaseDir(spec, cacheDir, scope),
			patterns: spec.sections[scope].patterns,
		};
	}

	return buildIndex({
		cacheDir,
		sections,
	});
}

export async function searchGitCacheIndex<TScope extends string>(
	index: Index<TScope>,
	query: string,
	options?: {
		scope?: TScope | typeof ALL_SCOPE;
		regex?: boolean;
		caseSensitive?: boolean;
		limit?: number;
	},
): Promise<SearchResult<TScope>> {
	return searchIndex(index, query, options);
}

export function formatGitCacheIndexCounts<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	index: Index<TScope>,
): string[] {
	return getGitCacheScopes(spec).map((scope) => {
		return `${spec.sections[scope].label} files: ${index.sections[scope].files.length}`;
	});
}

export interface GitCacheRuntimeContext<TScope extends string> {
	client: Parameters<Plugin>[0]["client"];
	spec: GitCacheSpec<TScope>;
	cacheDir: string;
	indexFile: string;
	stateFile: string;
	maxAgeSeconds: number;
	buildNotification(output: string): string;
	notify(sessionID: string, output: string): Promise<void>;
	log(message: string, level?: "debug" | "error" | "info" | "warn"): Promise<void>;
	getSourceDir(sourceId: string): string;
	getArtifactDir(artifactId: string): string;
	getArtifactReadinessPath(artifactId: string): string;
	isSourceReady(sourceId: string): Promise<boolean>;
	isArtifactReady(artifactId: string): Promise<boolean>;
	getSourceRevision(sourceId: string): Promise<string | null>;
	readState(): Promise<GitCacheState>;
	writeState(state: GitCacheState): Promise<void>;
	updateState(mutator: (state: GitCacheState) => void): Promise<GitCacheState>;
	loadIndex(): Promise<Index<TScope> | null>;
	refreshIndex(): Promise<Index<TScope>>;
	formatIndexCounts(index: Index<TScope>): string[];
	syncSources(): Promise<string[]>;
	runCommand: typeof runCommand;
	formatCommandFailure: typeof formatCommandFailure;
}

export interface GitCachePluginOptions<TScope extends string> {
	spec: GitCacheSpec<TScope>;
	maxAgeSeconds?: number;
	extendStatus?: (context: GitCacheRuntimeContext<TScope>) => Promise<readonly string[]>;
	extraTools?: (context: GitCacheRuntimeContext<TScope>) => Record<string, ToolDefinition>;
}

function createRuntimeContext<TScope extends string>(input: {
	client: Parameters<Plugin>[0]["client"];
	spec: GitCacheSpec<TScope>;
	cacheDir: string;
	sendNotification: (sessionID: string, message: string) => Promise<void>;
	maxAgeSeconds: number;
}): GitCacheRuntimeContext<TScope> {
	const indexFile = getGitCacheIndexPath(input.cacheDir);
	const stateFile = getGitCacheStateFile(input.cacheDir);
	const scopes = getGitCacheScopes(input.spec);
	const readySourceId = resolveReadySourceId(input.spec);

	const readState = async (): Promise<GitCacheState> => {
		return loadGitCacheState(input.spec, input.cacheDir, {
			getSourceDir: (sourceId) => getGitSourceDir(input.spec, input.cacheDir, sourceId),
			getArtifactDir: (artifactId) => getGitArtifactDir(input.spec, input.cacheDir, artifactId),
		});
	};

	const writeState = async (state: GitCacheState): Promise<void> => {
		await writeGitCacheState(stateFile, state);
	};

	const updateState = async (
		mutator: (state: GitCacheState) => void,
	): Promise<GitCacheState> => {
		const currentState = await readState();
		mutator(currentState);
		await writeState(currentState);
		return currentState;
	};

	const refreshIndex = async (): Promise<Index<TScope>> => {
		const index = await buildGitCacheSearchIndex(input.spec, input.cacheDir);
		await writeIndex(indexFile, index);
		await updateState((state) => {
			state.indexedAt = index.createdAt;
			state.indexFile = indexFile;
		});
		return index;
	};

	const loadIndex = async (): Promise<Index<TScope> | null> => {
		if (!(await pathExists(join(getGitSourceDir(input.spec, input.cacheDir, readySourceId), ".git")))) {
			return null;
		}

		const storedIndex = await readIndex<Index<TScope>>(indexFile);
		return isIndexForScopes(storedIndex, scopes) ? storedIndex : refreshIndex();
	};

	const syncSources = async (): Promise<string[]> => {
		const now = new Date().toISOString();
		const state = await readState();
		const lines: string[] = [];

		for (const source of input.spec.sources) {
			const sourceDir = getGitSourceDir(input.spec, input.cacheDir, source.id);

			try {
				lines.push(...(await syncGitSource(sourceDir, source)));
				const revision = await readGitRevision(sourceDir);
				state.sources[source.id] = {
					directory: sourceDir,
					revision,
					syncedAt: now,
					ready: await pathExists(join(sourceDir, ".git")),
					message: null,
				};
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				state.sources[source.id] = {
					directory: sourceDir,
					revision: await readGitRevision(sourceDir),
					syncedAt: state.sources[source.id]?.syncedAt ?? null,
					ready: await pathExists(join(sourceDir, ".git")),
					message,
				};
				lines.push(`  Error with ${source.id}: ${message}`);
			}
		}

		state.updatedAt = now;
		state.warnings = [];
		await writeState(state);
		return lines;
	};

	return {
		client: input.client,
		spec: input.spec,
		cacheDir: input.cacheDir,
		indexFile,
		stateFile,
		maxAgeSeconds: input.maxAgeSeconds,
		buildNotification(output: string): string {
			return buildNotification(input.spec.title, output);
		},
		async notify(sessionID: string, output: string): Promise<void> {
			await input.sendNotification(sessionID, buildNotification(input.spec.title, output));
		},
		async log(
			message: string,
			level: "debug" | "error" | "info" | "warn" = "info",
		): Promise<void> {
			await input.client.app.log({
				body: {
					service: input.spec.service,
					level,
					message,
				},
			});
		},
		getSourceDir(sourceId: string): string {
			return getGitSourceDir(input.spec, input.cacheDir, sourceId);
		},
		getArtifactDir(artifactId: string): string {
			return getGitArtifactDir(input.spec, input.cacheDir, artifactId);
		},
		getArtifactReadinessPath(artifactId: string): string {
			return getGitArtifactReadinessPath(input.spec, input.cacheDir, artifactId);
		},
		async isSourceReady(sourceId: string): Promise<boolean> {
			return pathExists(join(getGitSourceDir(input.spec, input.cacheDir, sourceId), ".git"));
		},
		async isArtifactReady(artifactId: string): Promise<boolean> {
			return pathExists(getGitArtifactReadinessPath(input.spec, input.cacheDir, artifactId));
		},
		async getSourceRevision(sourceId: string): Promise<string | null> {
			return readGitRevision(getGitSourceDir(input.spec, input.cacheDir, sourceId));
		},
		readState,
		writeState,
		updateState,
		loadIndex,
		refreshIndex,
		formatIndexCounts(index: Index<TScope>): string[] {
			return formatGitCacheIndexCounts(input.spec, index);
		},
		syncSources,
		runCommand,
		formatCommandFailure,
	};
}

function buildSourceRepositoryLines<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	state: GitCacheState,
): string[] {
	const lines = ["Sources:"];
	for (const source of spec.sources) {
		const sourceState = state.sources[source.id]
			?? createInitialGitCacheState(spec, state.cacheDir, {
				getSourceDir: (sourceId) => getGitSourceDir(spec, state.cacheDir, sourceId),
				getArtifactDir: (artifactId) => getGitArtifactDir(spec, state.cacheDir, artifactId),
			}).sources[source.id];
		const label = source.label ?? source.id;
		const revision = sourceState.revision ?? "unknown";
		const syncedAt = sourceState.syncedAt ?? "never";
		lines.push(`  ${label}: ${sourceState.ready ? "ready" : "missing"} (${revision}, synced ${syncedAt})`);
		if (sourceState.message != null) {
			lines.push(`    ${sourceState.message}`);
		}
	}
	return lines;
}

function buildArtifactLines<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	state: GitCacheState,
): string[] {
	const artifacts = spec.artifacts ?? [];
	if (artifacts.length === 0) {
		return [];
	}

	const lines = ["Artifacts:"];
	for (const artifact of artifacts) {
		const artifactState = state.artifacts[artifact.id]
			?? createEmptyArtifactState(getGitArtifactDir(spec, state.cacheDir, artifact.id));
		const label = artifact.label ?? artifact.id;
		const builtAt = artifactState.builtAt ?? "never";
		lines.push(`  ${label}: ${artifactState.ready ? "ready" : "missing"} (built ${builtAt})`);
		if (artifactState.message != null) {
			lines.push(`    ${artifactState.message}`);
		}
	}
	return lines;
}

export function createGitCachePlugin<TScope extends string>(
	input: GitCachePluginOptions<TScope>,
): Plugin {
	return async ({ client }) => {
		const spec = defineGitCacheSpec(input.spec);
		const cacheDir = resolveGitCacheDir(spec.envVar, spec.defaultCacheSubdir);
		const sendNotification = createNotificationSender({
			client,
			service: spec.service,
		});
		const runtime = createRuntimeContext({
			client,
			spec,
			cacheDir,
			sendNotification,
			maxAgeSeconds: input.maxAgeSeconds ?? DEFAULT_GIT_CACHE_MAX_AGE_SECONDS,
		});
		const scopeValues = [ALL_SCOPE, ...getGitCacheScopes(spec)] as const;

		const tools: Hooks["tool"] = {
			[spec.updateTool.name]: tool({
				description: spec.updateTool.description,
				args: {
					force: tool.schema.boolean().optional().describe("Force refresh even when the cache is fresh."),
				},
				async execute(args, context) {
					try {
						await mkdir(runtime.cacheDir, { recursive: true });

						const state = await runtime.readState();
						const freshness = getGitCacheFreshness(state.updatedAt, runtime.maxAgeSeconds);
						const readySourceId = resolveReadySourceId(spec);

						if (!args.force && (await runtime.isSourceReady(readySourceId)) && freshness.fresh) {
							const index = (await runtime.loadIndex()) ?? (await runtime.refreshIndex());
							const message = [
								`Cache is fresh (${freshness.hoursAgo}h old).`,
								`Cache directory: ${runtime.cacheDir}`,
								`State file: ${runtime.stateFile}`,
								...runtime.formatIndexCounts(index),
								"Use force=true to refresh anyway.",
							].join("\n");
							await runtime.notify(context.sessionID, message);
							return message;
						}

						const lines = await runtime.syncSources();
						const index = await runtime.refreshIndex();
						lines.push(`\nState file: ${runtime.stateFile}`);
						lines.push(`Search index: ${runtime.indexFile}`);
						lines.push(...runtime.formatIndexCounts(index));
						const output = lines.join("\n");
						await runtime.notify(context.sessionID, output);
						await runtime.log(spec.updateTool.successLogMessage);
						return output;
					} catch (error: unknown) {
						const message = formatErrorMessage(spec.updateTool.failureLabel, error);
						await runtime.notify(context.sessionID, message);
						return message;
					}
				},
			}),
			[spec.statusTool.name]: createStatusTool({
				description: spec.statusTool.description,
				notificationTitle: spec.title,
				sendNotification,
				buildOutput: async () => {
					const state = await runtime.readState();
					const index = await runtime.loadIndex();
					const freshness = getGitCacheFreshness(state.updatedAt, runtime.maxAgeSeconds);
					const lines = [
						`Cache directory: ${runtime.cacheDir}`,
						`State file: ${runtime.stateFile}`,
						`Search index: ${runtime.indexFile}`,
					];

					if (freshness.timestamp == null) {
						lines.push("Cache status: not initialized");
					} else {
						lines.push(`Cache status: ${freshness.fresh ? "fresh" : "stale"} (${freshness.hoursAgo}h old)`);
						lines.push(`Last update: ${new Date(freshness.timestamp * 1000).toISOString()}`);
					}

					lines.push("");
					lines.push(...buildSourceRepositoryLines(spec, state));

					const artifactLines = buildArtifactLines(spec, state);
					if (artifactLines.length > 0) {
						lines.push("");
						lines.push(...artifactLines);
					}

					if (input.extendStatus != null) {
						const extraLines = [...(await input.extendStatus(runtime))];
						if (extraLines.length > 0) {
							lines.push("");
							lines.push(...extraLines);
						}
					}

					lines.push("");
					if (index == null) {
						lines.push("Search corpus: missing");
					} else {
						lines.push(`Search corpus: ${runtime.indexFile}`);
						lines.push(...runtime.formatIndexCounts(index));
					}

					return lines.join("\n");
				},
			}),
			[spec.searchTool.name]: createSearchTool<Index<TScope>, TScope>({
				description: spec.searchTool.description,
				notificationTitle: spec.title,
				scopeValues,
				scopeDescription: spec.searchTool.scopeDescription,
				missingOutput: spec.searchTool.missingMessage,
				failureLabel: spec.searchTool.failureLabel,
				loadIndex: runtime.loadIndex,
				search: async ({
					index,
					query,
					scope,
					regex,
					caseSensitive,
					limit,
				}: {
					index: Index<TScope>;
					query: string;
					scope?: TScope | typeof ALL_SCOPE;
					regex?: boolean;
					caseSensitive?: boolean;
					limit?: number;
				}): Promise<SearchResult<TScope>> => {
					return searchIndex(index, query, {
						scope,
						regex,
						caseSensitive,
						limit,
					});
				},
				sendNotification,
			}),
		};

		if (input.extraTools != null) {
			Object.assign(tools, input.extraTools(runtime));
		}

		void logInitialization({
			client,
			service: spec.service,
			message: spec.initMessage,
		});

		return {
			tool: tools,
			"permission.ask": createPermissionHandler(runtime.cacheDir),
		};
	};
}
