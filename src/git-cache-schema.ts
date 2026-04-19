import * as z from "zod";

const NonEmptyStringSchema = z.string().trim().min(1);

export interface GitCacheToolConfig {
	name: string;
	description: string;
}

export interface GitCacheUpdateToolConfig extends GitCacheToolConfig {
	failureLabel: string;
	successLogMessage: string;
}

export interface GitCacheSearchToolConfig extends GitCacheToolConfig {
	missingMessage: string;
	scopeDescription?: string;
	failureLabel: string;
}

export interface GitCacheSourceSpec {
	id: string;
	url: string;
	branch: string;
	directory?: string;
	sparse?: readonly string[];
	ready?: boolean;
	label?: string;
}

export interface GitCacheArtifactSpec {
	id: string;
	source: string;
	path: string;
	readiness?: string;
	label?: string;
}

export type GitCacheSectionRoot =
	| {
		kind: "source";
		id: string;
	}
	| {
		kind: "artifact";
		id: string;
	};

export interface GitCacheSectionSpec {
	label: string;
	root: GitCacheSectionRoot;
	patterns: readonly string[];
}

type BaseGitCacheSpec = {
	schemaVersion?: 1;
	title: string;
	service: string;
	envVar: string;
	defaultCacheSubdir: string;
	initMessage: string;
	updateTool: GitCacheUpdateToolConfig;
	statusTool: GitCacheToolConfig;
	searchTool: GitCacheSearchToolConfig;
	sources: readonly GitCacheSourceSpec[];
	artifacts?: readonly GitCacheArtifactSpec[];
	sections: Record<string, GitCacheSectionSpec>;
	readySource?: string;
};

export interface GitCacheSpec<TScope extends string = string>
	extends Omit<BaseGitCacheSpec, "sections"> {
	sections: Record<TScope, GitCacheSectionSpec>;
}

export const GitCacheToolConfigSchema = z.strictObject({
	name: NonEmptyStringSchema,
	description: NonEmptyStringSchema,
});

export const GitCacheUpdateToolConfigSchema = z.strictObject({
	...GitCacheToolConfigSchema.shape,
	failureLabel: NonEmptyStringSchema,
	successLogMessage: NonEmptyStringSchema,
});

export const GitCacheSearchToolConfigSchema = z.strictObject({
	...GitCacheToolConfigSchema.shape,
	missingMessage: NonEmptyStringSchema,
	scopeDescription: NonEmptyStringSchema.optional(),
	failureLabel: NonEmptyStringSchema,
});

export const GitCacheSourceSpecSchema = z.strictObject({
	id: NonEmptyStringSchema,
	url: z.url(),
	branch: NonEmptyStringSchema,
	directory: NonEmptyStringSchema.optional(),
	sparse: z.array(NonEmptyStringSchema).min(1).optional(),
	ready: z.boolean().optional(),
	label: NonEmptyStringSchema.optional(),
});

export const GitCacheArtifactSpecSchema = z.strictObject({
	id: NonEmptyStringSchema,
	source: NonEmptyStringSchema,
	path: NonEmptyStringSchema,
	readiness: NonEmptyStringSchema.optional(),
	label: NonEmptyStringSchema.optional(),
});

export const GitCacheSectionRootSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("source"),
		id: NonEmptyStringSchema,
	}),
	z.strictObject({
		kind: z.literal("artifact"),
		id: NonEmptyStringSchema,
	}),
]);

export const GitCacheSectionSpecSchema = z.strictObject({
	label: NonEmptyStringSchema,
	root: GitCacheSectionRootSchema,
	patterns: z.array(NonEmptyStringSchema).min(1),
});

export const GitCacheSpecSchema = z
	.strictObject({
		schemaVersion: z.literal(1).optional(),
		title: NonEmptyStringSchema,
		service: NonEmptyStringSchema,
		envVar: NonEmptyStringSchema,
		defaultCacheSubdir: NonEmptyStringSchema,
		initMessage: NonEmptyStringSchema,
		updateTool: GitCacheUpdateToolConfigSchema,
		statusTool: GitCacheToolConfigSchema,
		searchTool: GitCacheSearchToolConfigSchema,
		sources: z.array(GitCacheSourceSpecSchema).min(1),
		artifacts: z.array(GitCacheArtifactSpecSchema).optional(),
		sections: z.record(NonEmptyStringSchema, GitCacheSectionSpecSchema),
		readySource: NonEmptyStringSchema.optional(),
	})
	.superRefine((spec, context) => {
		const sourceIds = new Set<string>();
		for (const [index, source] of spec.sources.entries()) {
			if (sourceIds.has(source.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Duplicate source id '${source.id}'.`,
					path: ["sources", index, "id"],
				});
			}
			sourceIds.add(source.id);
		}

		const readySources = spec.sources.filter((source) => source.ready === true);
		if (readySources.length > 1) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Only one source can be marked as ready.",
				path: ["sources"],
			});
		}

		const artifacts = spec.artifacts ?? [];
		const artifactIds = new Set<string>();
		for (const [index, artifact] of artifacts.entries()) {
			if (!sourceIds.has(artifact.source)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Artifact '${artifact.id}' references missing source '${artifact.source}'.`,
					path: ["artifacts", index, "source"],
				});
			}

			if (artifactIds.has(artifact.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Duplicate artifact id '${artifact.id}'.`,
					path: ["artifacts", index, "id"],
				});
			}
			artifactIds.add(artifact.id);
		}

		const scopes = Object.keys(spec.sections);
		if (scopes.length === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "At least one section is required.",
				path: ["sections"],
			});
		}

		for (const scope of scopes) {
			const section = spec.sections[scope];
			if (section.root.kind === "source" && !sourceIds.has(section.root.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Section '${scope}' references missing source '${section.root.id}'.`,
					path: ["sections", scope, "root", "id"],
				});
			}

			if (section.root.kind === "artifact" && !artifactIds.has(section.root.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Section '${scope}' references missing artifact '${section.root.id}'.`,
					path: ["sections", scope, "root", "id"],
				});
			}
		}

		if (spec.readySource != null && !sourceIds.has(spec.readySource)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `readySource '${spec.readySource}' does not exist.`,
				path: ["readySource"],
			});
		}
	});

export function defineGitCacheSpec<const TScope extends string>(
	spec: GitCacheSpec<TScope>,
): GitCacheSpec<TScope> {
	return GitCacheSpecSchema.parse(spec) as GitCacheSpec<TScope>;
}

export function resolveReadySourceId<TScope extends string>(
	spec: GitCacheSpec<TScope>,
): string {
	if (spec.readySource != null) {
		return spec.readySource;
	}

	const markedReadySource = spec.sources.find((source) => source.ready === true);
	if (markedReadySource != null) {
		return markedReadySource.id;
	}

	return spec.sources[0]!.id;
}

export function getGitCacheScopes<const TScope extends string>(
	spec: GitCacheSpec<TScope>,
): TScope[] {
	return Object.keys(spec.sections) as TScope[];
}
