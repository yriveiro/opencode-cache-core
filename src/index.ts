export {
	ALL_SCOPE,
	type Index,
	type PermissionRequest,
	type SearchHit,
	type SearchOptions,
	type SearchResult,
	type Section,
	type SectionDefinition,
} from "./types";
export { buildIndex } from "./indexing";
export {
	pathExists,
	readIndex,
	writeIndex,
} from "./storage";
export { searchIndex } from "./search";
export {
	type CommandResult,
	DEFAULT_GIT_CACHE_MAX_AGE_SECONDS,
	buildGitCacheSearchIndex,
	createGitCachePlugin,
	formatCommandFailure,
	formatGitCacheIndexCounts,
	searchGitCacheIndex,
	type GitCachePluginOptions,
	type GitCacheRuntimeContext,
} from "./git-cache-plugin";
export {
	defineGitCacheSpec,
	getGitCacheScopes,
	resolveReadySourceId,
	GitCacheSpecSchema,
	GitCacheSourceSpecSchema,
	GitCacheArtifactSpecSchema,
	GitCacheSectionSpecSchema,
	type GitCacheArtifactSpec,
	type GitCacheSearchToolConfig,
	type GitCacheSectionRoot,
	type GitCacheSectionSpec,
	type GitCacheSourceSpec,
	type GitCacheSpec,
	type GitCacheToolConfig,
	type GitCacheUpdateToolConfig,
} from "./git-cache-schema";
export {
	GIT_CACHE_INDEX_FILE,
	GIT_CACHE_STATE_FILE,
	GitCacheArtifactStateSchema,
	GitCacheSourceStateSchema,
	GitCacheStateSchema,
	createInitialGitCacheState,
	getGitCacheFreshness,
	getGitCacheIndexFile,
	getGitCacheStateFile,
	loadGitCacheState,
	readGitCacheState,
	writeGitCacheState,
	type GitCacheArtifactState,
	type GitCacheFreshness,
	type GitCacheSourceState,
	type GitCacheState,
} from "./git-cache-state";
export {
	getGitArtifactDir,
	getGitArtifactReadinessPath,
	getGitCacheIndexPath,
	getGitSectionBaseDir,
	getGitSourceDir,
	getGitSourceDirectoryName,
} from "./git-cache-paths";
export { buildNotification, createNotificationSender } from "./notifications";
export { createPermissionHandler } from "./permissions";
export { createSearchTool, createStatusTool } from "./tools";
