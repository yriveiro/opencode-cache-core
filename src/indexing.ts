import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Index, Section, SectionDefinition } from "./types";

function normalizeRelativePath(value: string): string {
	return value.replaceAll("\\", "/");
}

function buildSegmentMatcher(patternSegment: string): RegExp {
	const escaped = patternSegment.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	const wildcardPattern = escaped
		.replaceAll("*", "[^/]*")
		.replaceAll("?", "[^/]");

	return new RegExp(`^${wildcardPattern}$`, "u");
}

function matchSegments(
	patternSegments: readonly string[],
	fileSegments: readonly string[],
	patternIndex = 0,
	fileIndex = 0,
): boolean {
	if (patternIndex === patternSegments.length) {
		return fileIndex === fileSegments.length;
	}

	const patternSegment = patternSegments[patternIndex];
	if (patternSegment === "**") {
		for (
			let nextFileIndex = fileIndex;
			nextFileIndex <= fileSegments.length;
			nextFileIndex += 1
		) {
			if (
				matchSegments(
					patternSegments,
					fileSegments,
					patternIndex + 1,
					nextFileIndex,
				)
			) {
				return true;
			}
		}

		return false;
	}

	if (fileIndex >= fileSegments.length) {
		return false;
	}

	return (
		buildSegmentMatcher(patternSegment).test(fileSegments[fileIndex]) &&
		matchSegments(
			patternSegments,
			fileSegments,
			patternIndex + 1,
			fileIndex + 1,
		)
	);
}

function matchesPattern(file: string, pattern: string): boolean {
	const normalizedFile = normalizeRelativePath(file);
	const normalizedPattern = normalizeRelativePath(pattern);

	return matchSegments(
		normalizedPattern.split("/").filter((segment) => segment.length > 0),
		normalizedFile.split("/").filter((segment) => segment.length > 0),
	);
}

async function listRelativeFiles(
	baseDir: string,
	currentDir = "",
): Promise<string[]> {
	const directoryPath =
		currentDir.length > 0 ? join(baseDir, currentDir) : baseDir;
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const relativePath =
			currentDir.length > 0 ? `${currentDir}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			files.push(...(await listRelativeFiles(baseDir, relativePath)));
			continue;
		}

		if (entry.isFile()) {
			files.push(normalizeRelativePath(relativePath));
		}
	}

	return files;
}

async function scanRelativeFiles(
	cwd: string,
	patterns: readonly string[],
): Promise<string[]> {
	try {
		const files = await listRelativeFiles(cwd);
		const matches = files.filter((file) =>
			patterns.some((pattern) => matchesPattern(file, pattern)),
		);

		return matches.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}

export async function buildIndex<TScope extends string>(input: {
	cacheDir: string;
	sections: Record<TScope, SectionDefinition>;
}): Promise<Index<TScope>> {
	const sections = {} as Record<TScope, Section>;
	const entries = Object.entries(input.sections) as Array<
		[TScope, SectionDefinition]
	>;

	for (const [scope, definition] of entries) {
		sections[scope] = {
			baseDir: definition.baseDir,
			files: await scanRelativeFiles(definition.baseDir, definition.patterns),
		};
	}

	return {
		createdAt: new Date().toISOString(),
		cacheDir: input.cacheDir,
		sections,
	};
}
