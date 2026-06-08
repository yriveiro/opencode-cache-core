import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	type Hooks,
	type Plugin,
	type PluginInput,
	type ToolContext,
	type ToolDefinition,
	tool,
} from "@opencode-ai/plugin";
import { getGitCacheLookups } from "./git-cache-lookups";
import {
	getGitArtifactDir,
	getGitArtifactReadinessPath,
	getGitCacheIndexPath,
	getGitSourceDir,
	getGitSourceDirectoryName,
} from "./git-cache-paths";
import {
	defineGitCacheSpec,
	type GitCacheSourceSpec,
	type GitCacheSpec,
	getGitCacheScopes,
} from "./git-cache-schema";
import {
	type GitCacheState,
	getGitCacheFreshness,
	getGitCacheStateFile,
	loadGitCacheState,
	writeGitCacheState,
} from "./git-cache-state";
import { buildIndex, type IndexBuildProgress } from "./indexing";
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
	client: PluginInput["client"];
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

function createEmptyArtifactState(
	directory: string,
): GitCacheState["artifacts"][string] {
	return {
		directory,
		builtAt: null,
		ready: false,
		message: null,
	};
}

function getSparseEntries(
	source: Pick<GitCacheSourceSpec, "sparse">,
): string[] {
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

	return join(
		homeDirectory,
		".cache",
		"opencode",
		"plugins",
		"cache-core",
		defaultCacheSubdir,
	);
}

export function formatCommandFailure(
	title: string,
	result: CommandResult,
): string {
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
				throw new Error(
					formatCommandFailure(`Failed to clone ${sourceName}.`, result),
				);
			}

			result = await runCommand(
				"git",
				["sparse-checkout", "init", "--cone"],
				sourceDir,
			);
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
				throw new Error(
					formatCommandFailure(`Failed to clone ${sourceName}.`, result),
				);
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
		throw new Error(
			formatCommandFailure(`Failed to fetch ${sourceName}.`, result),
		);
	}

	result = await runCommand(
		"git",
		["reset", "--hard", `origin/${source.branch}`],
		sourceDir,
	);
	if (result.exitCode !== 0) {
		throw new Error(
			formatCommandFailure(`Failed to reset ${sourceName}.`, result),
		);
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
	const result = await runCommand(
		"git",
		["rev-parse", "--short", "HEAD"],
		directory,
	);
	return result.exitCode === 0 && result.stdout.length > 0
		? result.stdout
		: null;
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

export type GitCacheIndexStartProgress<TScope extends string> = Extract<
	IndexBuildProgress<TScope>,
	{ phase: "start" }
>;

export type GitCacheIndexCompleteProgress<TScope extends string> = Extract<
	IndexBuildProgress<TScope>,
	{ phase: "complete" }
>;

export type GitCacheIndexProgress<TScope extends string> =
	| GitCacheIndexStartProgress<TScope>
	| GitCacheIndexCompleteProgress<TScope>;

interface GitCacheSyncProgressBase {
	sourceId: string;
	label: string;
	current: number;
	total: number;
}

export interface GitCacheSyncStartProgress extends GitCacheSyncProgressBase {
	phase: "start";
}

export interface GitCacheSyncCompleteProgress extends GitCacheSyncProgressBase {
	phase: "complete";
	revision: string | null;
	ready: boolean;
	message: string | null;
}

export type GitCacheSyncProgress =
	| GitCacheSyncStartProgress
	| GitCacheSyncCompleteProgress;

export interface GitCacheIndexProgressOptions<TScope extends string> {
	onProgress?: (
		progress: GitCacheIndexProgress<TScope>,
	) => Promise<void> | void;
}

export interface GitCacheSyncProgressOptions {
	onProgress?: (progress: GitCacheSyncProgress) => Promise<void> | void;
}

export interface GitCacheUpdateStartProgress {
	phase: "start";
	sources: number;
	sections: number;
}

export interface GitCacheUpdateFreshProgress {
	phase: "fresh";
	sources: number;
	sections: number;
}

export interface GitCacheUpdateCompleteProgress {
	phase: "complete";
	sources: number;
	sections: number;
}

export interface GitCacheUpdateSyncProgress {
	phase: "sync";
	progress: GitCacheSyncProgress;
	sources: number;
	sections: number;
}

export interface GitCacheUpdateIndexProgress<TScope extends string> {
	phase: "index";
	progress: GitCacheIndexProgress<TScope>;
	sources: number;
	sections: number;
}

export type GitCacheUpdateProgress<TScope extends string> =
	| GitCacheUpdateStartProgress
	| GitCacheUpdateFreshProgress
	| GitCacheUpdateCompleteProgress
	| GitCacheUpdateSyncProgress
	| GitCacheUpdateIndexProgress<TScope>;

export interface GitCacheUpdateProgressOptions<TScope extends string> {
	onProgress?: (
		progress: GitCacheUpdateProgress<TScope>,
	) => Promise<void> | void;
}

export interface GitCacheUpdateResult<TScope extends string> {
	lines: string[];
	index: Index<TScope>;
	fresh: boolean;
	freshnessHoursAgo: number | null;
}

export interface GitCacheUpdateProgressMetadata {
	phase: "start" | "sync" | "index" | "complete";
	status?: "start" | "complete";
	sources?: number;
	sections?: number;
	sourceId?: string;
	scope?: string;
	current?: number;
	total?: number;
	revision?: string | null;
	ready?: boolean;
	fileCount?: number;
}

export interface GitCacheUpdateProgressDisplay {
	title: string;
	metadata: GitCacheUpdateProgressMetadata;
	message: string | null;
}

export function buildGitCacheUpdateProgressMetadata<TScope extends string>(
	progress: GitCacheUpdateProgress<TScope>,
): GitCacheUpdateProgressMetadata {
	switch (progress.phase) {
		case "start":
			return {
				phase: "start",
				sources: progress.sources,
				sections: progress.sections,
			};
		case "fresh":
			return {
				phase: "complete",
				status: "complete",
				sources: progress.sources,
				sections: progress.sections,
			};
		case "complete":
			return {
				phase: "complete",
				status: "complete",
				sources: progress.sources,
				sections: progress.sections,
			};
		case "sync": {
			const metadata: GitCacheUpdateProgressMetadata = {
				phase: "sync",
				status: progress.progress.phase,
				sources: progress.sources,
				sections: progress.sections,
				sourceId: progress.progress.sourceId,
				current: progress.progress.current,
				total: progress.progress.total,
			};

			if (progress.progress.phase === "complete") {
				metadata.revision = progress.progress.revision;
				metadata.ready = progress.progress.ready;
			}

			return metadata;
		}
		case "index": {
			const metadata: GitCacheUpdateProgressMetadata = {
				phase: "index",
				status: progress.progress.phase,
				sources: progress.sources,
				sections: progress.sections,
				scope: progress.progress.scope,
				current: progress.progress.index,
				total: progress.progress.total,
			};

			if (progress.progress.phase === "complete") {
				metadata.fileCount = progress.progress.fileCount;
			}

			return metadata;
		}
	}
}

export async function buildGitCacheSearchIndex<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
	options?: GitCacheIndexProgressOptions<TScope>,
): Promise<Index<TScope>> {
	const lookups = getGitCacheLookups(spec);
	const sections = {} as Record<
		TScope,
		{ baseDir: string; patterns: readonly string[] }
	>;

	for (const scope of getGitCacheScopes(spec)) {
		const section = lookups.sectionsByScope.get(scope);
		if (section == null) {
			throw new Error(`Unknown section '${String(scope)}'.`);
		}

		sections[scope] = {
			baseDir:
				section.root.kind === "source"
					? getGitSourceDir(spec, cacheDir, section.root.id)
					: getGitArtifactDir(spec, cacheDir, section.root.id),
			patterns: section.patterns,
		};
	}

	return buildIndex({
		cacheDir,
		sections,
		onProgress: options?.onProgress,
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
	const lookups = getGitCacheLookups(spec);
	return getGitCacheScopes(spec).map((scope) => {
		const section = lookups.sectionsByScope.get(scope);
		if (section == null) {
			throw new Error(`Unknown section '${String(scope)}'.`);
		}

		return `${section.label} files: ${index.sections[scope].files.length}`;
	});
}

export interface GitCachePluginContext<TScope extends string> {
	client: PluginInput["client"];
	spec: GitCacheSpec<TScope>;
	cacheDir: string;
	indexFile: string;
	stateFile: string;
	maxAgeSeconds: number;
	buildNotification(output: string): string;
	notify(sessionID: string, output: string): Promise<void>;
	log(
		message: string,
		level?: "debug" | "error" | "info" | "warn",
	): Promise<void>;
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
	refreshIndex(
		options?: GitCacheIndexProgressOptions<TScope>,
	): Promise<Index<TScope>>;
	formatIndexCounts(index: Index<TScope>): string[];
	syncSources(options?: GitCacheSyncProgressOptions): Promise<string[]>;
	runCommand: typeof runCommand;
	formatCommandFailure: typeof formatCommandFailure;
}

export interface GitCachePluginOptions<TScope extends string> {
	spec: GitCacheSpec<TScope>;
	maxAgeSeconds?: number;
	extendStatus?: (
		context: GitCachePluginContext<TScope>,
	) => Promise<readonly string[]>;
	extraTools?: (
		context: GitCachePluginContext<TScope>,
	) => Record<string, ToolDefinition>;
}

function createPluginContext<TScope extends string>(input: {
	client: PluginInput["client"];
	spec: GitCacheSpec<TScope>;
	cacheDir: string;
	sendNotification: (sessionID: string, message: string) => Promise<void>;
	maxAgeSeconds: number;
}): GitCachePluginContext<TScope> {
	const lookups = getGitCacheLookups(input.spec);
	const indexFile = getGitCacheIndexPath(input.cacheDir);
	const stateFile = getGitCacheStateFile(input.cacheDir);
	const readySourceId = lookups.readySourceId;
	const scopes = getGitCacheScopes(input.spec);

	const readState = async (): Promise<GitCacheState> => {
		return loadGitCacheState(input.spec, input.cacheDir, {
			getSourceDir: (sourceId) =>
				getGitSourceDir(input.spec, input.cacheDir, sourceId),
			getArtifactDir: (artifactId) =>
				getGitArtifactDir(input.spec, input.cacheDir, artifactId),
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

	const refreshIndex = async (
		options?: GitCacheIndexProgressOptions<TScope>,
	): Promise<Index<TScope>> => {
		const index = await buildGitCacheSearchIndex(input.spec, input.cacheDir, {
			onProgress: options?.onProgress,
		});
		await writeIndex(indexFile, index);
		await updateState((state) => {
			state.indexedAt = index.createdAt;
			state.indexFile = indexFile;
		});
		return index;
	};

	const loadIndex = async (): Promise<Index<TScope> | null> => {
		if (
			!(await pathExists(
				join(
					getGitSourceDir(input.spec, input.cacheDir, readySourceId),
					".git",
				),
			))
		) {
			return null;
		}

		const storedIndex = await readIndex<Index<TScope>>(indexFile);
		return isIndexForScopes(storedIndex, scopes) ? storedIndex : refreshIndex();
	};

	const syncSources = async (
		options?: GitCacheSyncProgressOptions,
	): Promise<string[]> => {
		const now = new Date().toISOString();
		const state = await readState();
		const lines: string[] = [];
		const totalSources = input.spec.sources.length;

		for (const [sourceIndex, source] of input.spec.sources.entries()) {
			const sourceDir = getGitSourceDir(input.spec, input.cacheDir, source.id);
			const previousState = state.sources[source.id];
			const sourceLabel = source.label ?? source.id;
			let revision = previousState?.revision ?? null;
			let syncedAt = previousState?.syncedAt ?? null;
			let ready = previousState?.ready ?? false;
			let message = previousState?.message ?? null;

			await options?.onProgress?.({
				phase: "start",
				sourceId: source.id,
				label: sourceLabel,
				current: sourceIndex + 1,
				total: totalSources,
			});

			try {
				lines.push(...(await syncGitSource(sourceDir, source)));
				revision = await readGitRevision(sourceDir);
				syncedAt = now;
				message = null;
			} catch (error: unknown) {
				message = error instanceof Error ? error.message : String(error);
				revision = await readGitRevision(sourceDir);
				lines.push(`  Error with ${source.id}: ${message}`);
			}

			ready = await pathExists(join(sourceDir, ".git"));
			state.sources[source.id] = {
				directory: sourceDir,
				revision,
				syncedAt,
				ready,
				message,
			};

			await options?.onProgress?.({
				phase: "complete",
				sourceId: source.id,
				label: sourceLabel,
				current: sourceIndex + 1,
				total: totalSources,
				revision,
				ready,
				message,
			});
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
			await input.sendNotification(
				sessionID,
				buildNotification(input.spec.title, output),
			);
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
			return getGitArtifactReadinessPath(
				input.spec,
				input.cacheDir,
				artifactId,
			);
		},
		async isSourceReady(sourceId: string): Promise<boolean> {
			return pathExists(
				join(getGitSourceDir(input.spec, input.cacheDir, sourceId), ".git"),
			);
		},
		async isArtifactReady(artifactId: string): Promise<boolean> {
			return pathExists(
				getGitArtifactReadinessPath(input.spec, input.cacheDir, artifactId),
			);
		},
		async getSourceRevision(sourceId: string): Promise<string | null> {
			return readGitRevision(
				getGitSourceDir(input.spec, input.cacheDir, sourceId),
			);
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
		const sourceState = state.sources[source.id] ?? {
			directory: getGitSourceDir(spec, state.cacheDir, source.id),
			revision: null,
			syncedAt: null,
			ready: false,
			message: null,
		};
		const label = source.label ?? source.id;
		const revision = sourceState.revision ?? "unknown";
		const syncedAt = sourceState.syncedAt ?? "never";
		lines.push(
			`  ${label}: ${sourceState.ready ? "ready" : "missing"} (${revision}, synced ${syncedAt})`,
		);
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
		const artifactState =
			state.artifacts[artifact.id] ??
			createEmptyArtifactState(
				getGitArtifactDir(spec, state.cacheDir, artifact.id),
			);
		const label = artifact.label ?? artifact.id;
		const builtAt = artifactState.builtAt ?? "never";
		lines.push(
			`  ${label}: ${artifactState.ready ? "ready" : "missing"} (built ${builtAt})`,
		);
		if (artifactState.message != null) {
			lines.push(`    ${artifactState.message}`);
		}
	}
	return lines;
}

function buildUpdateProgressTitle(cacheTitle: string, detail: string): string {
	return `Updating ${cacheTitle}: ${detail}`;
}

export function formatGitCacheUpdateProgressTitle<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	progress: GitCacheUpdateProgress<TScope>,
): string {
	switch (progress.phase) {
		case "start":
			return buildUpdateProgressTitle(spec.title, "starting");
		case "fresh":
			return buildUpdateProgressTitle(spec.title, "fresh");
		case "complete":
			return buildUpdateProgressTitle(spec.title, "complete");
		case "sync":
			return buildUpdateProgressTitle(
				spec.title,
				progress.progress.phase === "start"
					? `syncing ${progress.progress.current}/${progress.progress.total} (${progress.progress.label})`
					: `synced ${progress.progress.current}/${progress.progress.total} (${progress.progress.label})`,
			);
		case "index": {
			const label = spec.sections[progress.progress.scope].label;
			return buildUpdateProgressTitle(
				spec.title,
				progress.progress.phase === "start"
					? `indexing ${progress.progress.index}/${progress.progress.total} (${label})`
					: `indexed ${progress.progress.index}/${progress.progress.total} (${label})`,
			);
		}
	}
}

function buildSourceProgressMessage(progress: GitCacheSyncProgress): string {
	const lines = [
		`Synced source ${progress.current}/${progress.total}: ${progress.label}`,
	];

	if (progress.phase === "start") {
		return lines.join("\n");
	}

	if (progress.revision != null) {
		lines.push(`Revision: ${progress.revision}`);
	}

	lines.push(`Ready: ${progress.ready ? "yes" : "no"}`);

	if (progress.message != null) {
		lines.push(`Status: ${progress.message}`);
	}

	return lines.join("\n");
}

export function formatGitCacheUpdateProgressMessage<
	TScope extends string,
>(input: {
	spec: GitCacheSpec<TScope>;
	progress: GitCacheUpdateProgress<TScope>;
	cacheDir?: string;
}): string | null {
	switch (input.progress.phase) {
		case "start":
			return [
				"Update started",
				`Cache directory: ${input.cacheDir ?? input.spec.defaultCacheSubdir}`,
				`Sources: ${input.progress.sources}`,
				`Sections: ${input.progress.sections}`,
			].join("\n");
		case "fresh":
			return null;
		case "complete":
			return null;
		case "sync":
			return input.progress.progress.phase === "complete"
				? buildSourceProgressMessage(input.progress.progress)
				: null;
		case "index":
			return input.progress.progress.phase === "complete"
				? buildIndexProgressMessage(input.spec, input.progress.progress)
				: null;
	}
}

export function buildGitCacheUpdateProgressDisplay<
	TScope extends string,
>(input: {
	spec: GitCacheSpec<TScope>;
	progress: GitCacheUpdateProgress<TScope>;
	cacheDir?: string;
}): GitCacheUpdateProgressDisplay {
	return {
		title: formatGitCacheUpdateProgressTitle(input.spec, input.progress),
		metadata: buildGitCacheUpdateProgressMetadata(input.progress),
		message: formatGitCacheUpdateProgressMessage(input),
	};
}

export function publishGitCacheUpdateProgress<TScope extends string>(
	context: ToolContext,
	input: {
		spec: GitCacheSpec<TScope>;
		progress: GitCacheUpdateProgress<TScope>;
		cacheDir?: string;
	},
): GitCacheUpdateProgressDisplay {
	const display = buildGitCacheUpdateProgressDisplay(input);
	context.metadata({
		title: display.title,
		metadata: display.metadata,
	});
	return display;
}

export async function updateGitCache<TScope extends string>(input: {
	runtime: Pick<
		GitCachePluginContext<TScope>,
		| "cacheDir"
		| "stateFile"
		| "indexFile"
		| "maxAgeSeconds"
		| "readState"
		| "loadIndex"
		| "refreshIndex"
		| "formatIndexCounts"
		| "syncSources"
		| "isSourceReady"
	>;
	spec: GitCacheSpec<TScope>;
	force?: boolean;
	readySourceId?: string;
	options?: GitCacheUpdateProgressOptions<TScope>;
}): Promise<GitCacheUpdateResult<TScope>> {
	const sectionScopes = getGitCacheScopes(input.spec);
	const sources = input.spec.sources.length;
	const sections = sectionScopes.length;
	const readySourceId =
		input.readySourceId ?? getGitCacheLookups(input.spec).readySourceId;

	await input.options?.onProgress?.({ phase: "start", sources, sections });

	const state = await input.runtime.readState();
	const freshness = getGitCacheFreshness(
		state.updatedAt,
		input.runtime.maxAgeSeconds,
	);

	if (
		!input.force &&
		(await input.runtime.isSourceReady(readySourceId)) &&
		freshness.fresh
	) {
		const index =
			(await input.runtime.loadIndex()) ?? (await input.runtime.refreshIndex());
		await input.options?.onProgress?.({
			phase: "fresh",
			sources,
			sections,
		});
		return {
			lines: [
				`Cache is fresh (${freshness.hoursAgo}h old).`,
				`Cache directory: ${input.runtime.cacheDir}`,
				`State file: ${input.runtime.stateFile}`,
				...input.runtime.formatIndexCounts(index),
				"Use force=true to refresh anyway.",
			],
			index,
			fresh: true,
			freshnessHoursAgo: freshness.hoursAgo,
		};
	}

	const lines = await input.runtime.syncSources({
		onProgress: async (progress) => {
			await input.options?.onProgress?.({
				phase: "sync",
				progress,
				sources,
				sections,
			});
		},
	});

	const index = await input.runtime.refreshIndex({
		onProgress: async (progress) => {
			await input.options?.onProgress?.({
				phase: "index",
				progress,
				sources,
				sections,
			});
		},
	});

	lines.push("");
	lines.push(`State file: ${input.runtime.stateFile}`);
	lines.push(`Search index: ${input.runtime.indexFile}`);
	lines.push(...input.runtime.formatIndexCounts(index));

	await input.options?.onProgress?.({ phase: "complete", sources, sections });

	return {
		lines,
		index,
		fresh: false,
		freshnessHoursAgo: freshness.timestamp == null ? null : freshness.hoursAgo,
	};
}

function buildIndexProgressMessage<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	progress: GitCacheIndexProgress<TScope>,
): string {
	const label = spec.sections[progress.scope].label;
	if (progress.phase === "start") {
		return `Indexing section ${progress.index}/${progress.total}: ${label}`;
	}

	return [
		`Indexed section ${progress.index}/${progress.total}: ${label}`,
		`Files: ${progress.fileCount}`,
	].join("\n");
}

export function createGitCachePlugin<TScope extends string>(
	input: GitCachePluginOptions<TScope>,
): Plugin {
	return async ({ client }) => {
		const spec = defineGitCacheSpec(input.spec);
		const lookups = getGitCacheLookups(spec);
		const cacheDir = resolveGitCacheDir(spec.envVar, spec.defaultCacheSubdir);
		const sendNotification = createNotificationSender({
			client,
			service: spec.service,
		});
		const runtime = createPluginContext({
			client,
			spec,
			cacheDir,
			sendNotification,
			maxAgeSeconds: input.maxAgeSeconds ?? DEFAULT_GIT_CACHE_MAX_AGE_SECONDS,
		});
		const sectionScopes = getGitCacheScopes(spec);
		const scopeValues = [ALL_SCOPE, ...sectionScopes] as const;

		const tools: Hooks["tool"] = {
			[spec.updateTool.name]: tool({
				description: spec.updateTool.description,
				args: {
					force: tool.schema
						.boolean()
						.optional()
						.describe("Force refresh even when the cache is fresh."),
				},
				async execute(args, context) {
					try {
						await mkdir(runtime.cacheDir, { recursive: true });

						const result = await updateGitCache({
							runtime,
							spec,
							force: args.force,
							readySourceId: lookups.readySourceId,
							options: {
								onProgress: async (progress) => {
									const display = publishGitCacheUpdateProgress(context, {
										spec,
										progress,
										cacheDir: runtime.cacheDir,
									});
									if (display.message != null) {
										await runtime.notify(context.sessionID, display.message);
									}
								},
							},
						});

						const output = result.lines.join("\n");
						await runtime.notify(context.sessionID, output);
						await runtime.log(spec.updateTool.successLogMessage);
						return output;
					} catch (error: unknown) {
						const message = formatErrorMessage(
							spec.updateTool.failureLabel,
							error,
						);
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
					const freshness = getGitCacheFreshness(
						state.updatedAt,
						runtime.maxAgeSeconds,
					);
					const lines = [
						`Cache directory: ${runtime.cacheDir}`,
						`State file: ${runtime.stateFile}`,
						`Search index: ${runtime.indexFile}`,
					];

					if (freshness.timestamp == null) {
						lines.push("Cache status: not initialized");
					} else {
						lines.push(
							`Cache status: ${freshness.fresh ? "fresh" : "stale"} (${freshness.hoursAgo}h old)`,
						);
						lines.push(
							`Last update: ${new Date(freshness.timestamp * 1000).toISOString()}`,
						);
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
