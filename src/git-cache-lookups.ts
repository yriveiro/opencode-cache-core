import type {
	GitCacheArtifactSpec,
	GitCacheSectionSpec,
	GitCacheSourceSpec,
	GitCacheSpec,
} from "./git-cache-schema";

export interface GitCacheLookups<TScope extends string> {
	sourcesById: Map<string, GitCacheSourceSpec>;
	artifactsById: Map<string, GitCacheArtifactSpec>;
	sectionsByScope: Map<TScope, GitCacheSectionSpec>;
	readySourceId: string;
}

const lookupCache = new WeakMap<object, GitCacheLookups<string>>();

function createGitCacheLookups<TScope extends string>(
	spec: GitCacheSpec<TScope>,
): GitCacheLookups<TScope> {
	const sourcesById = new Map<string, GitCacheSourceSpec>();
	for (const source of spec.sources) {
		sourcesById.set(source.id, source);
	}

	const artifactsById = new Map<string, GitCacheArtifactSpec>();
	for (const artifact of spec.artifacts ?? []) {
		artifactsById.set(artifact.id, artifact);
	}

	const sectionsByScope = new Map<TScope, GitCacheSectionSpec>();
	for (const scope of Object.keys(spec.sections) as TScope[]) {
		sectionsByScope.set(scope, spec.sections[scope]);
	}

	let readySourceId = spec.readySource;
	if (readySourceId == null) {
		for (const source of spec.sources) {
			if (source.ready === true) {
				readySourceId = source.id;
				break;
			}
		}

		const firstSource = spec.sources[0];
		if (firstSource == null) {
			throw new Error("Git cache specs must define at least one source.");
		}

		readySourceId = firstSource.id;
	}

	return {
		sourcesById,
		artifactsById,
		sectionsByScope,
		readySourceId,
	};
}

export function getGitCacheLookups<TScope extends string>(
	spec: GitCacheSpec<TScope>,
): GitCacheLookups<TScope> {
	const cached = lookupCache.get(spec);
	if (cached != null) {
		return cached as GitCacheLookups<TScope>;
	}

	const lookups = createGitCacheLookups(spec);
	lookupCache.set(spec, lookups as GitCacheLookups<string>);
	return lookups;
}

export function resolveReadySourceId<TScope extends string>(
	spec: GitCacheSpec<TScope>,
): string {
	return getGitCacheLookups(spec).readySourceId;
}
