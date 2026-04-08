declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	exitCode?: number;
	stderr: {
		write(chunk: string): void;
	};
};

declare const Bun: {
	build(options: {
		entrypoints: string[];
		outdir: string;
		target: "node";
		format: "esm";
		external?: string[];
		sourcemap?: "none";
	}): Promise<{
		success: boolean;
		logs: Array<{
			message: string;
		}>;
	}>;
};

declare module "node:fs/promises" {
	export interface Dirent {
		name: string;
		isDirectory(): boolean;
		isFile(): boolean;
	}

	export interface Stats {
		isDirectory(): boolean;
	}

	export function access(path: string): Promise<void>;
	export function mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<string | undefined>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function readdir(
		path: string,
		options: { withFileTypes: true },
	): Promise<Dirent[]>;
	export function stat(path: string): Promise<Stats>;
	export function rm(
		path: string,
		options?: { force?: boolean; recursive?: boolean },
	): Promise<void>;
	export function writeFile(
		path: string,
		data: string,
		encoding: "utf8",
	): Promise<void>;
}

declare module "node:os" {
	export function homedir(): string;
}

declare module "node:path" {
	export function dirname(path: string): string;
	export function isAbsolute(path: string): boolean;
	export function join(...paths: string[]): string;
	export function resolve(...paths: string[]): string;
}
