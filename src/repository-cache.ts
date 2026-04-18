import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { tool } from "@opencode-ai/plugin";

import { buildIndex } from "./indexing";
import { buildNotification, createNotificationSender } from "./notifications";
import { createPermissionHandler } from "./permissions";
import { createPluginHooks } from "./plugin";
import { searchIndex } from "./search";
import {
	pathExists,
	readFreshness,
	readIndex,
	writeIndex,
	writeTimestamp,
} from "./storage";
import { createStatusTool } from "./tools";
import {
	type HooksLike,
	ALL_SCOPE,
	type Index,
	type PluginLike,
	type SearchOptions,
	type SearchResult,
	type ToolDefinitionLike,
} from "./types";

export const DEFAULT_MAX_AGE_SECONDS = 86_400;
export const SEARCH_INDEX_FILE = "search-index.json";
export const MARKER_FILE = ".last_update";

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface RepositoryConfig {
	name: string;
	url: string;
	branch: string;
	sparse?: readonly string[];
}

export interface SectionInfo {
	label: string;
}

export interface SectionConfig extends SectionInfo {
	baseDir: (cacheDir: string) => string;
	patterns: readonly string[];
}

export interface ToolConfig {
	name: string;
	description: string;
}

export interface SearchToolConfig extends ToolConfig {
	missingMessage: string;
	scopeDescription?: string;
	failureLabel: string;
}

export interface UpdateToolConfig extends ToolConfig {
	failureLabel: string;
	successLogMessage: string;
}

export interface ThinCachePluginConfig<TScope extends string> {
	title: string;
	service: string;
	envVar: string;
	defaultCacheSubdir: string;
	scopes: readonly [typeof ALL_SCOPE, ...TScope[]];
	repositories: readonly RepositoryConfig[];
	sections: Record<TScope, SectionConfig>;
	initMessage: string;
	updateTool: UpdateToolConfig;
	statusTool: ToolConfig;
	searchTool: SearchToolConfig;
	readyRepository?: string;
}

function typedEntries<TKey extends string, TValue>(
	value: Record<TKey, TValue>,
): Array<[TKey, TValue]> {
	return Object.entries(value) as Array<[TKey, TValue]>;
}

function buildErrorMessage(prefix: string, error: unknown): string {
	const details = error instanceof Error ? error.message : String(error);
	return `${prefix}: ${details}`;
}

function buildSearchScopeDescription<TScope extends string>(input: {
	scopeValues: readonly [typeof ALL_SCOPE, ...TScope[]];
	scopeDescription?: string;
}): string {
	return input.scopeDescription ?? `Search scope: ${input.scopeValues.join(", ")}.`;
}

function formatSearchOutput<TScope extends string>(
	query: string,
	result: SearchResult<TScope>,
): string {
	const lines = [
		`Query: ${query}`,
		`Scope: ${result.scope}`,
		`Files scanned: ${result.scannedFiles}`,
		`Matches: ${result.hits.length}`,
	];

	if (result.hits.length > 0) {
		lines.push("");
		for (const hit of result.hits) {
			lines.push(`- ${hit.file}:${hit.line}: ${hit.excerpt}`);
		}
	}

	return lines.join("\n");
}

function getSparseEntries(repository: RepositoryConfig): string[] {
	return repository.sparse == null ? [] : [...repository.sparse];
}

export function resolveCacheDir(
	envVar: string,
	defaultCacheSubdir: string,
	homeDirectory = homedir(),
): string {
	const configuredCacheDir = process.env[envVar];
	if (configuredCacheDir != null && configuredCacheDir.length > 0) {
		return configuredCacheDir;
	}

	return join(homeDirectory, `.cache/opencode/skills/${defaultCacheSubdir}`);
}

export function getRepositoryDir(
	cacheDir: string,
	repository: Pick<RepositoryConfig, "name"> | string,
): string {
	const repositoryName = typeof repository === "string" ? repository : repository.name;
	return join(cacheDir, repositoryName);
}

export function getMarkerFile(cacheDir: string): string {
	return join(cacheDir, MARKER_FILE);
}

export function getSearchIndexFile(cacheDir: string): string {
	return join(cacheDir, SEARCH_INDEX_FILE);
}

export async function buildSearchIndex<TScope extends string>(
	cacheDir: string,
	sections: Record<TScope, SectionConfig>,
): Promise<Index<TScope>> {
	const definitions = {} as Record<TScope, { baseDir: string; patterns: readonly string[] }>;

	for (const [scope, section] of typedEntries(sections)) {
		definitions[scope] = {
			baseDir: section.baseDir(cacheDir),
			patterns: section.patterns,
		};
	}

	return buildIndex({
		cacheDir,
		sections: definitions,
	});
}

export async function readSearchIndex<TScope extends string>(
	cacheDir: string,
): Promise<Index<TScope> | null> {
	return readIndex<Index<TScope>>(getSearchIndexFile(cacheDir));
}

export async function writeSearchIndex<TScope extends string>(
	cacheDir: string,
	index: Index<TScope>,
): Promise<void> {
	await writeIndex(getSearchIndexFile(cacheDir), index);
}

export async function refreshSearchIndex<TScope extends string>(
	cacheDir: string,
	sections: Record<TScope, SectionConfig>,
): Promise<Index<TScope>> {
	const index = await buildSearchIndex(cacheDir, sections);
	await writeSearchIndex(cacheDir, index);
	return index;
}

export async function searchCacheIndex<TScope extends string>(
	index: Index<TScope>,
	query: string,
	options?: SearchOptions<TScope>,
): Promise<SearchResult<TScope>> {
	return searchIndex(index, query, options);
}

export function formatIndexCounts<TScope extends string>(
	index: Index<TScope>,
	sections: Record<TScope, SectionInfo>,
): string[] {
	return typedEntries(sections).map(([scope, section]) => {
		return `${section.label} files: ${index.sections[scope].files.length}`;
	});
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

export async function syncRepository(
	cacheDir: string,
	repository: RepositoryConfig,
): Promise<string[]> {
	const repositoryDir = getRepositoryDir(cacheDir, repository);
	const gitDir = join(repositoryDir, ".git");
	const installed = await pathExists(gitDir);
	const lines: string[] = [];

	if (!installed) {
		lines.push(`Cloning ${repository.name}...`);

		let result: CommandResult;
		if (repository.sparse != null) {
			result = await runCommand("git", [
				"clone",
				"--filter=blob:none",
				"--no-checkout",
				"--depth",
				"1",
				"--branch",
				repository.branch,
				repository.url,
				repositoryDir,
			]);
			if (result.exitCode !== 0) {
				throw new Error(formatCommandFailure(`Failed to clone ${repository.name}.`, result));
			}

			result = await runCommand("git", ["-C", repositoryDir, "sparse-checkout", "init", "--cone"]);
			if (result.exitCode !== 0) {
				throw new Error(
					formatCommandFailure(`Failed to initialize sparse checkout for ${repository.name}.`, result),
				);
			}

			result = await runCommand("git", [
				"-C",
				repositoryDir,
				"sparse-checkout",
				"set",
				...getSparseEntries(repository),
			]);
			if (result.exitCode !== 0) {
				throw new Error(
					formatCommandFailure(`Failed to configure sparse checkout for ${repository.name}.`, result),
				);
			}

			result = await runCommand("git", ["-C", repositoryDir, "checkout", repository.branch]);
			if (result.exitCode !== 0) {
				throw new Error(formatCommandFailure(`Failed to checkout ${repository.branch}.`, result));
			}
		} else {
			result = await runCommand("git", [
				"clone",
				"--depth",
				"1",
				"--branch",
				repository.branch,
				repository.url,
				repositoryDir,
			]);
			if (result.exitCode !== 0) {
				throw new Error(formatCommandFailure(`Failed to clone ${repository.name}.`, result));
			}
		}

		lines.push(`  Cloned ${repository.name}`);
		return lines;
	}

	lines.push(`Updating ${repository.name}...`);

	let result = await runCommand("git", [
		"-C",
		repositoryDir,
		"fetch",
		"--depth",
		"1",
		"origin",
		repository.branch,
	]);
	if (result.exitCode !== 0) {
		throw new Error(formatCommandFailure(`Failed to fetch ${repository.name}.`, result));
	}

	result = await runCommand("git", [
		"-C",
		repositoryDir,
		"reset",
		"--hard",
		`origin/${repository.branch}`,
	]);
	if (result.exitCode !== 0) {
		throw new Error(formatCommandFailure(`Failed to reset ${repository.name}.`, result));
	}

	if (repository.sparse != null) {
		result = await runCommand("git", [
			"-C",
			repositoryDir,
			"sparse-checkout",
			"set",
			...getSparseEntries(repository),
		]);
		if (result.exitCode !== 0) {
			throw new Error(
				formatCommandFailure(`Failed to refresh sparse checkout for ${repository.name}.`, result),
			);
		}
	}

	lines.push(`  Updated ${repository.name}`);
	return lines;
}

async function buildRepositoryCacheStatusOutput<TScope extends string>(input: {
	cacheDir: string;
	markerFile: string;
	repositories: readonly RepositoryConfig[];
	sections: Record<TScope, SectionConfig>;
}): Promise<string> {
	const lines: string[] = [`Cache directory: ${input.cacheDir}`];
	const freshness = await readFreshness(input.markerFile, DEFAULT_MAX_AGE_SECONDS);
	const index = await readSearchIndex<TScope>(input.cacheDir);

	if (freshness.timestamp == null) {
		lines.push("Cache status: not initialized");
	} else {
		lines.push(`Cache status: ${freshness.fresh ? "fresh" : "stale"} (${freshness.hoursAgo}h old)`);
		lines.push(`Last updated: ${new Date(freshness.timestamp * 1000).toISOString()}`);
	}

	lines.push("\nRepositories:");
	for (const repository of input.repositories) {
		const installed = await pathExists(join(getRepositoryDir(input.cacheDir, repository), ".git"));
		lines.push(`  ${repository.name}: ${installed ? "installed" : "missing"}`);
	}

	if (index == null) {
		lines.push("\nSearch corpus: missing");
	} else {
		lines.push(`\nSearch corpus: ${getSearchIndexFile(input.cacheDir)}`);
		lines.push(...formatIndexCounts(index, input.sections));
	}

	return lines.join("\n");
}

export function createRepositoryCacheSearchTool<TScope extends string>(input: {
	description: string;
	notificationTitle: string;
	scopeValues: readonly [typeof ALL_SCOPE, ...TScope[]];
	missingOutput: string;
	failureLabel: string;
	scopeDescription?: string;
	loadIndex: () => Promise<Index<TScope> | null>;
	search: (input: {
		index: Index<TScope>;
		query: string;
		scope?: TScope | typeof ALL_SCOPE;
		regex?: boolean;
		caseSensitive?: boolean;
		limit?: number;
	}) => Promise<SearchResult<TScope>>;
	sendNotification: (sessionID: string, message: string) => Promise<void>;
}) {
	return tool({
		description: input.description,
		args: {
			query: tool.schema.string().describe("Substring or regular expression to search for."),
			scope: tool.schema
				.enum(input.scopeValues)
				.optional()
				.describe(
					buildSearchScopeDescription({
						scopeValues: input.scopeValues,
						scopeDescription: input.scopeDescription,
					}),
				),
			regex: tool.schema.boolean().optional().describe("Treat query as a regular expression."),
			case_sensitive: tool.schema.boolean().optional().describe("Use case-sensitive matching."),
			limit: tool.schema
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe("Maximum number of hits to return."),
		},
		async execute(args, context) {
			try {
				const index = await input.loadIndex();
				if (index == null) {
					await input.sendNotification(
						context.sessionID,
						buildNotification(input.notificationTitle, input.missingOutput),
					);
					return input.missingOutput;
				}

				let result: SearchResult<TScope>;
				try {
					result = await input.search({
						index,
						query: args.query,
						scope: args.scope,
						regex: args.regex,
						caseSensitive: args.case_sensitive,
						limit: args.limit,
					});
				} catch (error: unknown) {
					const message = buildErrorMessage("Invalid search query", error);
					await input.sendNotification(
						context.sessionID,
						buildNotification(input.notificationTitle, message),
					);
					return message;
				}

				const output = formatSearchOutput(args.query, result);
				await input.sendNotification(
					context.sessionID,
					buildNotification(input.notificationTitle, output),
				);
				return output;
			} catch (error: unknown) {
				const message = buildErrorMessage(input.failureLabel, error);
				await input.sendNotification(
					context.sessionID,
					buildNotification(input.notificationTitle, message),
				);
				return message;
			}
		},
	}) as unknown as ToolDefinitionLike;
}

export function createRepositoryCachePlugin<TScope extends string>(
	config: ThinCachePluginConfig<TScope>,
): PluginLike {
	return async ({ client }) => {
		const cacheDir = resolveCacheDir(config.envVar, config.defaultCacheSubdir);
		const markerFile = getMarkerFile(cacheDir);
		const readyRepositoryName = config.readyRepository ?? config.repositories[0]?.name;

		if (readyRepositoryName == null) {
			throw new Error(`${config.service} requires at least one repository.`);
		}

		const readyPath = join(getRepositoryDir(cacheDir, readyRepositoryName), ".git");
		const sendNotification = createNotificationSender({
			client,
			service: config.service,
		});

		const loadIndex = async (): Promise<Index<TScope> | null> => {
			if (!(await pathExists(readyPath))) {
				return null;
			}

			return (await readSearchIndex<TScope>(cacheDir))
				?? (await refreshSearchIndex(cacheDir, config.sections));
		};

		const tools: NonNullable<HooksLike["tool"]> = {
			[config.updateTool.name]: tool({
				description: config.updateTool.description,
				args: {
					force: tool.schema
						.boolean()
						.optional()
						.describe("Force update even if cache is fresh (< 24h old)"),
				},
				async execute(args, context) {
					try {
						const freshness = await readFreshness(markerFile, DEFAULT_MAX_AGE_SECONDS);

						if (!args.force && freshness.fresh) {
							const index = (await readSearchIndex<TScope>(cacheDir))
								?? (await refreshSearchIndex(cacheDir, config.sections));
							const message = [
								`Cache is fresh (${freshness.hoursAgo}h old).`,
								`Cache directory: ${cacheDir}`,
								...formatIndexCounts(index, config.sections),
								"Use force=true to refresh anyway.",
							].join("\n");
							await sendNotification(
								context.sessionID,
								buildNotification(config.title, message),
							);
							return message;
						}

						await mkdir(cacheDir, { recursive: true });

						const results: string[] = [];
						for (const repository of config.repositories) {
							try {
								results.push(...(await syncRepository(cacheDir, repository)));
							} catch (error: unknown) {
								const details = error instanceof Error ? error.message : String(error);
								results.push(`  Error with ${repository.name}: ${details}`);
							}
						}

						await writeTimestamp(markerFile);
						const index = await refreshSearchIndex(cacheDir, config.sections);
						results.push(`\nCache updated at: ${cacheDir}`);
						results.push(`Search index: ${getSearchIndexFile(cacheDir)}`);
						results.push(...formatIndexCounts(index, config.sections));
						const output = results.join("\n");

						await sendNotification(
							context.sessionID,
							buildNotification(config.title, output),
						);
						await client.app.log({
							body: {
								service: config.service,
								level: "info",
								message: config.updateTool.successLogMessage,
							},
						});

						return output;
					} catch (error: unknown) {
						const message = buildErrorMessage(config.updateTool.failureLabel, error);
						await sendNotification(
							context.sessionID,
							buildNotification(config.title, message),
						);
						return message;
					}
				},
			}) as unknown as ToolDefinitionLike,
			[config.statusTool.name]: createStatusTool({
				description: config.statusTool.description,
				notificationTitle: config.title,
				sendNotification,
				buildOutput: async () =>
					buildRepositoryCacheStatusOutput({
						cacheDir,
						markerFile,
						repositories: config.repositories,
						sections: config.sections,
					}),
			}) as unknown as ToolDefinitionLike,
			[config.searchTool.name]: createRepositoryCacheSearchTool({
				description: config.searchTool.description,
				notificationTitle: config.title,
				scopeValues: config.scopes,
				missingOutput: config.searchTool.missingMessage,
				failureLabel: config.searchTool.failureLabel,
				scopeDescription: config.searchTool.scopeDescription,
				loadIndex,
				search: async ({ index, query, scope, regex, caseSensitive, limit }) => {
					return searchCacheIndex(index, query, {
						scope,
						regex,
						caseSensitive,
						limit,
					});
				},
				sendNotification,
			}),
		};

		return createPluginHooks({
			client,
			service: config.service,
			initMessage: config.initMessage,
			permissionAsk: createPermissionHandler(cacheDir),
			tools,
		});
	};
}
