import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
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
