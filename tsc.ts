import { spawn } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";

function cacheReadFlag(flag: string): boolean {
	return process.argv.includes(flag);
}

async function cacheEnsureTsconfig(path: string): Promise<void> {
	await access(path);
}

async function cacheRunTypecheck(projectFile: string): Promise<void> {
	const child = spawn("bun", ["x", "tsc", "--noEmit", "-p", projectFile], {
		stdio: "inherit",
		env: process.env,
	});

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});

	if (exitCode !== 0) {
		throw new Error(`typecheck failed for ${projectFile}`);
	}
}

function cacheBuildOutputDirectory(noEmit: boolean): string {
	return noEmit ? ".typecheck-dist" : "dist";
}

async function cacheRunBuild(noEmit: boolean): Promise<void> {
	const outdir = cacheBuildOutputDirectory(noEmit);
	await mkdir(outdir, { recursive: true });

	const result = await Bun.build({
		entrypoints: ["./src/index.ts"],
		outdir,
		target: "node",
		format: "esm",
		external: ["@opencode-ai/plugin"],
		sourcemap: "none",
	});

	if (noEmit) {
		await rm(outdir, { force: true, recursive: true });
	}

	if (!result.success) {
		const message = result.logs.map((entry) => entry.message).join("\n");
		throw new Error(message.length > 0 ? message : "build failed");
	}
}

async function main(): Promise<void> {
	const projectFlagIndex = process.argv.indexOf("-p");
	const projectFile =
		projectFlagIndex >= 0 && projectFlagIndex + 1 < process.argv.length
			? process.argv[projectFlagIndex + 1]
			: "tsconfig.json";

	await cacheEnsureTsconfig(projectFile);

	if (cacheReadFlag("--noEmit")) {
		await cacheRunTypecheck(projectFile);
		return;
	}

	await cacheRunBuild(false);
}

await main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
