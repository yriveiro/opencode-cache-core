import { join } from "node:path";

import type {
	GitCacheArtifactSpec,
	GitCacheSourceSpec,
	GitCacheSpec,
} from "./git-cache-schema";
import { getGitCacheIndexFile as getStateIndexFile } from "./git-cache-state";

export function getGitSourceDirectoryName(
	source: Pick<GitCacheSourceSpec, "id" | "directory">,
): string {
	return source.directory ?? source.id;
}

export function getGitSourceDir<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
	sourceId: string,
): string {
	const source = spec.sources.find((entry) => entry.id === sourceId);
	if (source == null) {
		throw new Error(`Unknown source '${sourceId}'.`);
	}

	return join(cacheDir, getGitSourceDirectoryName(source));
}

export function getGitArtifact<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	artifactId: string,
): GitCacheArtifactSpec {
	const artifact = (spec.artifacts ?? []).find((entry) => entry.id === artifactId);
	if (artifact == null) {
		throw new Error(`Unknown artifact '${artifactId}'.`);
	}

	return artifact;
}

export function getGitArtifactDir<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
	artifactId: string,
): string {
	const artifact = getGitArtifact(spec, artifactId);
	return join(getGitSourceDir(spec, cacheDir, artifact.source), artifact.path);
}

export function getGitArtifactReadinessPath<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
	artifactId: string,
): string {
	const artifact = getGitArtifact(spec, artifactId);
	const artifactDir = getGitArtifactDir(spec, cacheDir, artifactId);
	return artifact.readiness == null ? artifactDir : join(artifactDir, artifact.readiness);
}

export function getGitSectionBaseDir<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
	scope: TScope,
): string {
	const section = spec.sections[scope];
	return section.root.kind === "source"
		? getGitSourceDir(spec, cacheDir, section.root.id)
		: getGitArtifactDir(spec, cacheDir, section.root.id);
}

export function getGitCacheIndexPath(cacheDir: string): string {
	return getStateIndexFile(cacheDir);
}
