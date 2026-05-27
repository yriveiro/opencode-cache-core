import { join } from "node:path";
import { getGitCacheLookups } from "./git-cache-lookups";
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
	const source = getGitCacheLookups(spec).sourcesById.get(sourceId);
	if (source == null) {
		throw new Error(`Unknown source '${sourceId}'.`);
	}

	return join(cacheDir, getGitSourceDirectoryName(source));
}

export function getGitArtifact<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	artifactId: string,
): GitCacheArtifactSpec {
	const artifact = getGitCacheLookups(spec).artifactsById.get(artifactId);
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
	return artifact.readiness == null
		? artifactDir
		: join(artifactDir, artifact.readiness);
}

export function getGitSectionBaseDir<TScope extends string>(
	spec: GitCacheSpec<TScope>,
	cacheDir: string,
	scope: TScope,
): string {
	const section = getGitCacheLookups(spec).sectionsByScope.get(scope);
	if (section == null) {
		throw new Error(`Unknown section '${String(scope)}'.`);
	}

	return section.root.kind === "source"
		? getGitSourceDir(spec, cacheDir, section.root.id)
		: getGitArtifactDir(spec, cacheDir, section.root.id);
}

export function getGitCacheIndexPath(cacheDir: string): string {
	return getStateIndexFile(cacheDir);
}
