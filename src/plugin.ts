import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import { buildIndex } from "./indexing";
import { createNotificationSender } from "./notifications";
import { createPermissionHandler } from "./permissions";
import { searchIndex } from "./search";
import {
	createIndexLoader,
	pathExists,
	readFreshness,
	writeIndex,
} from "./storage";
import { asToolDefinitionLike, createSearchTool, createStatusTool } from "./tools";
import {
	ALL_SCOPE,
	type ClientLike,
	type HooksLike,
	type Index,
	type PluginInputLike,
	type SearchResult,
	type SectionDefinition,
} from "./types";

interface PluginConfig {
	cacheDir?: string;
	indexFile?: string;
	readyPath?: string;
	sections?: Record<string, SectionDefinition>;
	maxAgeSeconds?: number;
	statusToolName?: string;
	searchToolName?: string;
}

interface ResolvedPluginConfig {
	cacheDir: string;
	indexFile: string;
	readyPath: string;
	sections: Record<string, SectionDefinition>;
	maxAgeSeconds: number;
	statusToolName: string;
	searchToolName: string;
}

type PluginContext = PluginInputLike & {
	config?: PluginOptions;
	env?: unknown;
	cwd?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const entries = value
		.map((entry) => readString(entry))
		.filter((entry): entry is string => entry != null);

	return entries.length > 0 ? entries : undefined;
}

function resolvePath(pathValue: string, baseDir: string): string {
	return isAbsolute(pathValue) ? pathValue : resolve(baseDir, pathValue);
}

function readSections(
	value: unknown,
	baseDir: string,
): Record<string, SectionDefinition> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const sections = Object.entries(value).reduce<
		Record<string, SectionDefinition>
	>((accumulator, [scope, definition]) => {
		if (!isRecord(definition)) {
			return accumulator;
		}

		const sectionBaseDir = readString(definition.baseDir);
		const patterns = readStringArray(definition.patterns);
		if (sectionBaseDir == null || patterns == null) {
			return accumulator;
		}

		accumulator[scope] = {
			baseDir: resolvePath(sectionBaseDir, baseDir),
			patterns,
		};

		return accumulator;
	}, {});

	return Object.keys(sections).length > 0 ? sections : undefined;
}

function readEnv(context: PluginContext): Record<string, string | undefined> {
	const merged = { ...process.env };
	if (!isRecord(context.env)) {
		return merged;
	}

	for (const [key, value] of Object.entries(context.env)) {
		const envValue = typeof value === "string" ? value : undefined;
		if (envValue !== undefined || value === undefined) {
			merged[key] = envValue;
		}
	}

	return merged;
}

function readConfig(
	context: PluginContext,
	workingDirectory: string,
): PluginConfig {
	if (!isRecord(context.config)) {
		return {};
	}

	const nestedConfig = isRecord(context.config.cache)
		? context.config.cache
		: {};

	return {
		cacheDir: readString(nestedConfig.cacheDir ?? context.config.cacheDir),
		indexFile: readString(nestedConfig.indexFile ?? context.config.indexFile),
		readyPath: readString(nestedConfig.readyPath ?? context.config.readyPath),
		sections: readSections(
			nestedConfig.sections ?? context.config.sections,
			workingDirectory,
		),
		maxAgeSeconds: readInteger(
			nestedConfig.maxAgeSeconds ?? context.config.maxAgeSeconds,
		),
		statusToolName: readString(
			nestedConfig.statusToolName ?? context.config.statusToolName,
		),
		searchToolName: readString(
			nestedConfig.searchToolName ?? context.config.searchToolName,
		),
	};
}

function readEnvValue(
	env: Record<string, string | undefined>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = readString(env[key]);
		if (value != null) {
			return value;
		}
	}

	return undefined;
}

function readEnvSections(
	env: Record<string, string | undefined>,
	baseDir: string,
): Record<string, SectionDefinition> | undefined {
	const rawSections = readEnvValue(
		env,
		"OPENCODE_CACHE_SECTIONS_JSON",
		"OC_CACHE_SECTIONS_JSON",
	);
	if (rawSections == null) {
		return undefined;
	}

	try {
		return readSections(JSON.parse(rawSections), baseDir);
	} catch {
		return undefined;
	}
}

function buildDefaultSections(
	cacheDir: string,
): Record<string, SectionDefinition> {
	return {
		cache: {
			baseDir: cacheDir,
			patterns: ["**/*"],
		},
	};
}

function buildScopeValues(scopes: string[]): [typeof ALL_SCOPE, ...string[]] {
	return [ALL_SCOPE, ...scopes];
}

function countIndexedFiles(index: Index<string>): number {
	return Object.values(index.sections).reduce(
		(total, section) => total + section.files.length,
		0,
	);
}

function buildStatusLines(
	config: ResolvedPluginConfig,
	ready: boolean,
	index: Index<string> | null,
	freshnessHours: number,
	freshnessText: string,
): string[] {
	const lines = [
		`Cache directory: ${config.cacheDir}`,
		`Index file: ${config.indexFile}`,
		`Ready marker: ${config.readyPath}`,
		`Ready marker present: ${ready ? "yes" : "no"}`,
		`Freshness: ${freshnessText}`,
		`Scopes: ${Object.keys(config.sections).join(", ")}`,
	];

	if (index == null) {
		lines.push("Index status: unavailable");
	} else {
		lines.push(`Index status: loaded (${countIndexedFiles(index)} files)`);
		lines.push(`Index created at: ${index.createdAt}`);
	}

	for (const [scope, section] of Object.entries(config.sections)) {
		lines.push(
			`- ${scope}: ${section.baseDir} [${section.patterns.join(", ")}]`,
		);
	}

	if (freshnessHours >= 0) {
		lines.push(`Freshness age hours: ${freshnessHours}`);
	}

	return lines;
}

function resolvePluginConfig(context: PluginContext): ResolvedPluginConfig {
	const env = readEnv(context);
	const workingDirectory = readString(context.cwd) ?? context.directory;
	const config = readConfig(context, workingDirectory);
	const defaultCacheDir = join(homedir(), ".cache", "opencode-cache");
	const cacheDir = resolvePath(
		config.cacheDir ??
			readEnvValue(env, "OPENCODE_CACHE_DIR", "OC_CACHE_DIR") ??
			defaultCacheDir,
		workingDirectory,
	);
	const indexFile = resolvePath(
		config.indexFile ??
			readEnvValue(env, "OPENCODE_CACHE_INDEX_FILE", "OC_CACHE_INDEX_FILE") ??
			join(cacheDir, ".opencode-plugin", "index.json"),
		workingDirectory,
	);
	const readyPath = resolvePath(
		config.readyPath ??
			readEnvValue(env, "OPENCODE_CACHE_READY_PATH", "OC_CACHE_READY_PATH") ??
			join(cacheDir, ".opencode-plugin", "ready"),
		workingDirectory,
	);
	const sections =
		config.sections ??
		readEnvSections(env, workingDirectory) ??
		buildDefaultSections(cacheDir);
	const maxAgeSeconds =
		config.maxAgeSeconds ??
		Number.parseInt(
			readEnvValue(
				env,
				"OPENCODE_CACHE_MAX_AGE_SECONDS",
				"OC_CACHE_MAX_AGE_SECONDS",
			) ?? "86400",
			10,
		);

	return {
		cacheDir,
		indexFile,
		readyPath,
		sections,
		maxAgeSeconds:
			Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0
				? maxAgeSeconds
				: 86400,
		statusToolName:
			config.statusToolName ??
			readEnvValue(
				env,
				"OPENCODE_CACHE_STATUS_TOOL_NAME",
				"OC_CACHE_STATUS_TOOL_NAME",
			) ??
			"cache_status",
		searchToolName:
			config.searchToolName ??
			readEnvValue(
				env,
				"OPENCODE_CACHE_SEARCH_TOOL_NAME",
				"OC_CACHE_SEARCH_TOOL_NAME",
			) ??
			"cache_search",
	};
}

function resolveClient(context: PluginContext): ClientLike {
	return context.client;
}

async function logInitialization(input: {
	client: ClientLike;
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

async function buildStatusOutput(
	config: ResolvedPluginConfig,
	loadIndex: () => Promise<Index<string> | null>,
): Promise<string> {
	const [ready, freshness, index] = await Promise.all([
		pathExists(config.readyPath),
		readFreshness(config.readyPath, config.maxAgeSeconds),
		loadIndex(),
	]);
	const freshnessText =
		freshness.timestamp == null
			? "missing"
			: freshness.fresh
				? `fresh (${freshness.ageSeconds}s old)`
				: `stale (${freshness.ageSeconds}s old)`;

	return buildStatusLines(
		config,
		ready,
		index,
		freshness.hoursAgo,
		freshnessText,
	).join("\n");
}

export function createPluginHooks(input: {
	client: ClientLike;
	service: string;
	initMessage: string;
	tools: HooksLike["tool"];
	permissionAsk?: HooksLike["permission.ask"];
}): HooksLike {
	void logInitialization({
		client: input.client,
		service: input.service,
		message: input.initMessage,
	});

	return {
		tool: input.tools,
		"permission.ask": input.permissionAsk,
	};
}

const createPlugin: Plugin = async (
	context: PluginInput,
	options?: PluginOptions,
): Promise<Hooks> => {
	const pluginContext: PluginContext = {
		...context,
		config: options,
	};
	const config = resolvePluginConfig(pluginContext);
	const client = resolveClient(pluginContext);
	const sendNotification = createNotificationSender({
		client,
		service: "opencode-cache-core-plugin",
	});
	const loadIndex = createIndexLoader<Index<string>>({
		indexFile: config.indexFile,
		readyPath: config.readyPath,
		createIndex: async () =>
			buildIndex({
				cacheDir: config.cacheDir,
				sections: config.sections,
			}),
		persistIndex: async (index) => writeIndex(config.indexFile, index),
	});
	const scopes = Object.keys(config.sections);
	const tools = {
		[config.statusToolName]: asToolDefinitionLike(createStatusTool({
			description:
				"Report cache index readiness, freshness, and configured scopes.",
			notificationTitle: "Cache status",
			buildOutput: async () => buildStatusOutput(config, loadIndex),
			sendNotification,
		})),
		[config.searchToolName]: asToolDefinitionLike(createSearchTool<Index<string>, string>({
			description:
				"Search the configured cache index by substring or regular expression.",
			notificationTitle: "Cache search",
			missingOutput:
				"Cache index is unavailable. Confirm the ready marker path or build the cache index.",
			scopeValues: buildScopeValues(scopes),
			loadIndex,
			search: async ({
				index,
				query,
				scope,
				regex,
				caseSensitive,
				limit,
			}): Promise<SearchResult<string>> =>
				searchIndex(index, query, {
					scope,
					regex,
					caseSensitive,
					limit,
				}),
			sendNotification,
		})),
	};

	return createPluginHooks({
		client,
		service: "opencode-cache-core-plugin",
		initMessage: `initialized cache plugin for ${config.cacheDir}`,
		permissionAsk: createPermissionHandler(config.cacheDir),
		tools,
	}) as unknown as Hooks;
};

export default createPlugin;
