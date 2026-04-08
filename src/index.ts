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
export { createPluginHooks } from "./plugin";
export { default } from "./plugin";
