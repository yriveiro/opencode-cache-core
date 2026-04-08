import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Freshness } from "./types";

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function readFreshness(
	markerFile: string,
	maxAgeSeconds: number,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Freshness> {
	try {
		const content = await readFile(markerFile, "utf8");
		const timestamp = Number.parseInt(content.trim(), 10);
		if (!Number.isFinite(timestamp)) {
			throw new Error("Invalid cache timestamp");
		}

		const ageSeconds = nowSeconds - timestamp;

		return {
			ageSeconds,
			fresh: ageSeconds < maxAgeSeconds,
			hoursAgo: Math.floor(ageSeconds / 3600),
			timestamp,
		};
	} catch {
		return {
			ageSeconds: -1,
			fresh: false,
			hoursAgo: -1,
			timestamp: null,
		};
	}
}

export async function writeTimestamp(
	markerFile: string,
	timestamp = Math.floor(Date.now() / 1000),
): Promise<void> {
	await mkdir(dirname(markerFile), { recursive: true });
	await writeFile(markerFile, `${timestamp}\n`, "utf8");
}

export async function readIndex<TIndex>(
	indexFile: string,
): Promise<TIndex | null> {
	try {
		const content = await readFile(indexFile, "utf8");

		return JSON.parse(content) as TIndex;
	} catch {
		return null;
	}
}

export async function writeIndex<TIndex>(
	indexFile: string,
	index: TIndex,
): Promise<void> {
	await mkdir(dirname(indexFile), { recursive: true });
	await writeFile(indexFile, JSON.stringify(index, null, 2), "utf8");
}

export async function loadIndex<TIndex>(input: {
	indexFile: string;
	readyPath: string;
	createIndex: () => Promise<TIndex>;
	persistIndex?: (index: TIndex) => Promise<void>;
}): Promise<TIndex | null> {
	const storedIndex = await readIndex<TIndex>(input.indexFile);
	if (storedIndex != null) {
		return storedIndex;
	}

	const ready = await pathExists(input.readyPath);
	if (!ready) {
		return null;
	}

	const index = await input.createIndex();
	if (input.persistIndex != null) {
		await input.persistIndex(index);
	} else {
		await writeIndex(input.indexFile, index);
	}

	return index;
}

export function createIndexLoader<TIndex>(input: {
	indexFile: string;
	readyPath: string;
	createIndex: () => Promise<TIndex>;
	persistIndex?: (index: TIndex) => Promise<void>;
}): () => Promise<TIndex | null> {
	return async (): Promise<TIndex | null> => loadIndex(input);
}
