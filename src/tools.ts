import {
	tool,
	type ToolContext,
	type ToolDefinition,
} from "@opencode-ai/plugin";

import { buildNotification } from "./notifications";
import { ALL_SCOPE, type SearchResult } from "./types";

function formatErrorMessage(prefix: string, error: unknown): string {
	const details = error instanceof Error ? error.message : String(error);
	return `${prefix}: ${details}`;
}

function buildSearchScopeDescription(input: {
	scopeValues: readonly string[];
	scopeDescription?: string;
}): string {
	return input.scopeDescription
		?? `Search scope: ${input.scopeValues.join(", ")}.`;
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
			lines.push(`- [${hit.scope}] ${hit.file}:${hit.line}: ${hit.excerpt}`);
		}
	}

	return lines.join("\n");
}

export function createStatusTool(input: {
	description: string;
	notificationTitle: string;
	buildOutput: () => Promise<string>;
	sendNotification: (sessionID: string, message: string) => Promise<void>;
}): ToolDefinition {
	return tool({
		description: input.description,
		args: {},
		async execute(_args, context: ToolContext) {
			const output = await input.buildOutput();
			await input.sendNotification(
				context.sessionID,
				buildNotification(input.notificationTitle, output),
			);
			return output;
		},
	});
}

export function createSearchTool<TIndex, TScope extends string>(input: {
	description: string;
	notificationTitle: string;
	missingOutput: string;
	scopeValues: readonly [typeof ALL_SCOPE, ...TScope[]];
	scopeDescription?: string;
	failureLabel?: string;
	loadIndex: () => Promise<TIndex | null>;
	search: (input: {
		index: TIndex;
		query: string;
		scope?: TScope | typeof ALL_SCOPE;
		regex?: boolean;
		caseSensitive?: boolean;
		limit?: number;
	}) => Promise<SearchResult<TScope>>;
	sendNotification: (sessionID: string, message: string) => Promise<void>;
}): ToolDefinition {
	return tool({
		description: input.description,
		args: {
			query: tool.schema
				.string()
				.describe("Substring or regular expression to search for."),
			scope: tool.schema
				.enum(input.scopeValues)
				.optional()
				.describe(
					buildSearchScopeDescription({
						scopeValues: input.scopeValues,
						scopeDescription: input.scopeDescription,
					}),
				),
			regex: tool.schema
				.boolean()
				.optional()
				.describe("Treat query as a regular expression."),
			case_sensitive: tool.schema
				.boolean()
				.optional()
				.describe("Use case-sensitive matching."),
			limit: tool.schema
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe("Maximum number of hits to return."),
		},
		async execute(args, context: ToolContext) {
			try {
				const index = await input.loadIndex();
				if (index == null) {
					await input.sendNotification(
						context.sessionID,
						buildNotification(input.notificationTitle, input.missingOutput),
					);
					return input.missingOutput;
				}

				const output = formatSearchOutput(
					args.query,
					await input.search({
						index,
						query: args.query,
						scope: args.scope,
						regex: args.regex,
						caseSensitive: args.case_sensitive,
						limit: args.limit,
					}),
				);

				await input.sendNotification(
					context.sessionID,
					buildNotification(input.notificationTitle, output),
				);
				return output;
			} catch (error: unknown) {
				const message = input.failureLabel == null
					? formatErrorMessage("Invalid search query", error)
					: formatErrorMessage(input.failureLabel, error);
				await input.sendNotification(
					context.sessionID,
					buildNotification(input.notificationTitle, message),
				);
				return message;
			}
		},
	});
}
