export const ALL_SCOPE = "all" as const;

export interface SectionDefinition {
	baseDir: string;
	patterns: readonly string[];
}

export interface Section {
	baseDir: string;
	files: string[];
}

export interface Index<TScope extends string = string> {
	createdAt: string;
	cacheDir: string;
	sections: Record<TScope, Section>;
}

export interface SearchHit<TScope extends string = string> {
	scope: TScope;
	file: string;
	line: number;
	excerpt: string;
}

export interface Freshness {
	ageSeconds: number;
	fresh: boolean;
	hoursAgo: number;
	timestamp: number | null;
}

export interface SearchOptions<TScope extends string = string> {
	scope?: TScope | typeof ALL_SCOPE;
	regex?: boolean;
	caseSensitive?: boolean;
	limit?: number;
}

export interface SearchResult<TScope extends string = string> {
	hits: SearchHit<TScope>[];
	scannedFiles: number;
	scope: TScope | typeof ALL_SCOPE;
}

export interface PermissionRequest {
	type: string;
	title: string;
	pattern?: string | string[];
}

export interface ClientLike {
	app: {
		log(input: unknown): Promise<unknown> | unknown;
	};
	session: {
		prompt(input: unknown): Promise<unknown> | unknown;
	};
}

export interface ToolContextLike {
	sessionID: string;
}

export interface ToolDefinitionLike {
	description: string;
	args: Readonly<Record<string, object>>;
	execute(
		args: Record<string, unknown>,
		context: ToolContextLike,
	): Promise<string>;
}

export interface PermissionOutputLike {
	status?: string;
}

export type PermissionAskLike = (
	input: PermissionRequest,
	output: PermissionOutputLike,
) => Promise<void>;

export interface HooksLike {
	tool?: Record<string, ToolDefinitionLike>;
	"permission.ask"?: PermissionAskLike;
}

export interface PluginInputLike {
	client: ClientLike;
	directory: string;
	config?: unknown;
	env?: unknown;
	cwd?: unknown;
}

export type PluginLike = (
	context: PluginInputLike,
	options?: unknown,
) => Promise<HooksLike>;
