import type { PermissionAskLike, PermissionRequest } from "./types";

function matchesPermission(
	cacheDir: string,
	request: PermissionRequest,
): boolean {
	if (request.type !== "external_directory") {
		return false;
	}

	const patterns = Array.isArray(request.pattern)
		? request.pattern
		: request.pattern
			? [request.pattern]
			: [];

	return (
		request.title.includes(cacheDir) ||
		patterns.some((pattern) => pattern.includes(cacheDir))
	);
}

export function createPermissionHandler(
	cacheDir: string,
): PermissionAskLike {
	return async (
		input,
		output,
	): Promise<void> => {
		if (
			matchesPermission(cacheDir, {
				type: input.type,
				title: input.title,
				pattern: input.pattern,
			})
		) {
			output.status = "allow";
		}
	};
}
