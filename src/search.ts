import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	ALL_SCOPE,
	type Index,
	type SearchHit,
	type SearchOptions,
	type SearchResult,
} from "./types";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(
	query: string,
	regex: boolean,
	caseSensitive: boolean,
): RegExp {
	const flags = caseSensitive ? "g" : "gi";

	return new RegExp(regex ? query : escapeRegExp(query), flags);
}

function trimExcerpt(value: string, maxLength = 200): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}

	return `${singleLine.slice(0, Math.max(maxLength - 3, 0))}...`;
}

export async function searchIndex<TScope extends string>(
	index: Index<TScope>,
	query: string,
	options?: SearchOptions<TScope>,
): Promise<SearchResult<TScope>> {
	const scope = options?.scope ?? ALL_SCOPE;
	const regex = options?.regex ?? false;
	const caseSensitive = options?.caseSensitive ?? false;
	const limit = options?.limit ?? 20;
	const matcher = buildMatcher(query, regex, caseSensitive);
	const scopes =
		scope === ALL_SCOPE ? (Object.keys(index.sections) as TScope[]) : [scope];
	const hits: SearchHit<TScope>[] = [];
	let scannedFiles = 0;

	for (const selectedScope of scopes) {
		const section = index.sections[selectedScope];

		for (const relativeFile of section.files) {
			scannedFiles += 1;

			let content: string;

			try {
				content = await readFile(join(section.baseDir, relativeFile), "utf8");
			} catch {
				continue;
			}

			const lines = content.split(/\r?\n/u);

			for (const [lineIndex, line] of lines.entries()) {
				matcher.lastIndex = 0;
				if (!matcher.test(line)) {
					continue;
				}

				hits.push({
					scope: selectedScope,
					file: relativeFile,
					line: lineIndex + 1,
					excerpt: trimExcerpt(line),
				});

				if (hits.length >= limit) {
					return {
						hits,
						scannedFiles,
						scope,
					};
				}
			}
		}
	}

	return {
		hits,
		scannedFiles,
		scope,
	};
}
