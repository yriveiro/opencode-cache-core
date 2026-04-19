import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import * as z from "zod";

import type { GitCacheSpec } from "./git-cache-schema";

const NullableIsoDateTimeSchema = z.iso.datetime().nullable();

export const GIT_CACHE_STATE_FILE = "cache-state.json";
export const GIT_CACHE_INDEX_FILE = "search-index.json";

export const GitCacheSourceStateSchema = z.strictObject({
	directory: z.string(),
	revision: z.string().nullable(),
	syncedAt: NullableIsoDateTimeSchema,
	ready: z.boolean(),
	message: z.string().nullable(),
});

export const GitCacheArtifactStateSchema = z.strictObject({
	directory: z.string(),
	builtAt: NullableIsoDateTimeSchema,
	ready: z.boolean(),
	message: z.string().nullable(),
});

export const GitCacheStateSchema = z.strictObject({
	schemaVersion: z.literal(1),
	cacheDir: z.string(),
	stateFile: z.string(),
	indexFile: z.string(),
	updatedAt: NullableIsoDateTimeSchema,
	indexedAt: NullableIsoDateTimeSchema,
	sources: z.record(z.string(), GitCacheSourceStateSchema),
	artifacts: z.record(z.string(), GitCacheArtifactStateSchema),
	warnings: z.array(z.string()),
});

export type GitCacheState = z.infer<typeof GitCacheStateSchema>;
export type GitCacheSourceState = z.infer<typeof GitCacheSourceStateSchema>;
export type GitCacheArtifactState = z.infer<typeof GitCacheArtifactStateSchema>;

export interface GitCacheFreshness {
	ageSeconds: number;
	fresh: boolean;
	hoursAgo: number;
	timestamp: number | null;
}

export function getGitCacheIndexFile(cacheDir: string): string {
	return `${cacheDir}/${GIT_CACHE_INDEX_FILE}`;
}

export function getGitCacheStateFile(cacheDir: string): string {
	return `${cacheDir}/${GIT_CACHE_STATE_FILE}`;
}

export function createInitialGitCacheState<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
	input: {
		getSourceDir: (sourceId: string) => string;
		getArtifactDir: (artifactId: string) => string;
	},
): GitCacheState {
	const stateFile = getGitCacheStateFile(cacheDir);
	const indexFile = getGitCacheIndexFile(cacheDir);

	const sources = Object.fromEntries(
		spec.sources.map((source) => [
			source.id,
			{
				directory: input.getSourceDir(source.id),
				revision: null,
				syncedAt: null,
				ready: false,
				message: null,
			},
		]),
	);

	const artifacts = Object.fromEntries(
		(spec.artifacts ?? []).map((artifact) => [
			artifact.id,
			{
				directory: input.getArtifactDir(artifact.id),
				builtAt: null,
				ready: false,
				message: null,
			},
		]),
	);

	return {
		schemaVersion: 1,
		cacheDir,
		stateFile,
		indexFile,
		updatedAt: null,
		indexedAt: null,
		sources,
		artifacts,
		warnings: [],
	};
}

export async function readGitCacheState(stateFile: string): Promise<GitCacheState | null> {
	try {
		const content = await readFile(stateFile, "utf8");
		const parsed = JSON.parse(content);
		const result = GitCacheStateSchema.safeParse(parsed);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

export async function writeGitCacheState(stateFile: string, state: GitCacheState): Promise<void> {
	await mkdir(dirname(stateFile), { recursive: true });
	await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

export async function loadGitCacheState<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
	input: {
		getSourceDir: (sourceId: string) => string;
		getArtifactDir: (artifactId: string) => string;
	},
): Promise<GitCacheState> {
	const stateFile = getGitCacheStateFile(cacheDir);
	return (await readGitCacheState(stateFile))
		?? createInitialGitCacheState(spec, cacheDir, input);
}

export function getGitCacheFreshness(
	timestamp: string | null,
	maxAgeSeconds: number,
): GitCacheFreshness {
	if (timestamp == null) {
		return {
			ageSeconds: 0,
			fresh: false,
			hoursAgo: 0,
			timestamp: null,
		};
	}

	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) {
		return {
			ageSeconds: 0,
			fresh: false,
			hoursAgo: 0,
			timestamp: null,
		};
	}

	const ageSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
	return {
		ageSeconds,
		fresh: ageSeconds < maxAgeSeconds,
		hoursAgo: Math.floor(ageSeconds / 3600),
		timestamp: Math.floor(parsed / 1000),
	};
}
