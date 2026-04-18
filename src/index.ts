export {
	ALL_SCOPE,
	type Freshness,
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
	createIndexLoader,
	loadIndex,
	pathExists,
	readFreshness,
	readIndex,
	writeIndex,
	writeTimestamp,
} from "./storage";
export { searchIndex } from "./search";
export { buildNotification, createNotificationSender } from "./notifications";
export { createPermissionHandler } from "./permissions";
export { createSearchTool, createStatusTool } from "./tools";
export {
	DEFAULT_MAX_AGE_SECONDS,
	MARKER_FILE,
	SEARCH_INDEX_FILE,
	buildSearchIndex as buildRepositorySearchIndex,
	createRepositoryCachePlugin,
	createRepositoryCacheSearchTool,
	formatCommandFailure,
	formatIndexCounts as formatRepositoryIndexCounts,
	getMarkerFile,
	getRepositoryDir,
	getSearchIndexFile,
	readSearchIndex as readRepositorySearchIndex,
	refreshSearchIndex as refreshRepositorySearchIndex,
	resolveCacheDir,
	runCommand,
	searchCacheIndex,
	syncRepository,
	writeSearchIndex as writeRepositorySearchIndex,
	type CommandResult,
	type RepositoryConfig,
	type SearchToolConfig,
	type SectionConfig,
	type SectionInfo,
	type ThinCachePluginConfig,
	type ToolConfig,
	type UpdateToolConfig,
} from "./repository-cache";
export { createPluginHooks } from "./plugin";
export { default } from "./plugin";
