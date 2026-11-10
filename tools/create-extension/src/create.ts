#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	ExtensionIdSchema,
	extensionNamespaceOf,
	normalizeMarketplaceSourceUrl,
} from "@bilibili-notify/internal";
import { run } from "./process";

async function create(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			id: { type: "string" },
			repository: { type: "string" },
			name: { type: "string" },
			sdk: { type: "string" },
			tools: { type: "string" },
			offline: { type: "boolean" },
			"no-git": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(
			"create-extension <directory> --id namespace.extension --repository owner/repo [--name Name] [--offline] [--no-git]\nUse --sdk / --tools to test local npm archives before publishing.",
		);
		return;
	}
	if (positionals.length !== 1) throw new Error("Provide one new project directory.");
	const id = ExtensionIdSchema.parse(values.id);
	const namespace = extensionNamespaceOf(id);
	if (!namespace || namespace.length > 32)
		throw new Error(
			"Use a third-party extension id: namespace.extension (namespace <= 32 characters).",
		);
	const repository = values.repository?.replace(/\.git$/i, "").toLowerCase();
	if (!repository || repository.includes(":") || !normalizeMarketplaceSourceUrl(repository).ok)
		throw new Error("Provide a GitHub repository as owner/repo.");
	const name = values.name ?? id;
	if (!name.trim() || name.length > 64) throw new Error("Name must contain 1–64 characters.");
	const versions = JSON.parse(await readFile(new URL("./versions.json", import.meta.url), "utf8"));
	const target = resolve(positionals[0] as string);
	await mkdir(target);
	await cp(new URL("./templates/project/", import.meta.url), target, { recursive: true });
	async function unwrapTemplates(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await unwrapTemplates(path);
			if (entry.name.endsWith(".tmpl")) await rename(path, path.slice(0, -5));
		}
	}
	await unwrapTemplates(target);
	await mkdir(join(target, ".bn"), { recursive: true });
	const json = (path: string, value: unknown) =>
		writeFile(join(target, path), `${JSON.stringify(value, null, 2)}\n`);
	const packageName = basename(target)
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-");
	await json("package.json", {
		name: packageName || "bn-extension",
		version: "0.1.0",
		private: true,
		type: "module",
		packageManager: versions.packageManager,
		engines: { node: `>=${versions.node}` },
		scripts: {
			prepare: "vp exec bn-extension hooks",
			dev: "vp pack --watch",
			lint: "vp lint --deny-warnings",
			format: "vp fmt",
			"format:check": "vp fmt --check",
			typecheck: "tsc --noEmit",
			test: "vp test",
			build: "vp pack",
			"pack:extension": "vp exec bn-extension pack",
			release: "vp exec bn-extension release",
			verify:
				"vp run lint && vp run format:check && vp run typecheck && vp run test && vp run build && vp run pack:extension",
			"commitlint:range": "commitlint",
		},
		dependencies: { "@bilibili-notify/extension": values.sdk ?? versions.sdk, zod: versions.zod },
		devDependencies: {
			"@bilibili-notify/create-extension": values.tools ?? versions.tools,
			"@commitlint/cli": versions.commitlint,
			"@commitlint/config-conventional": versions.commitlintConfig,
			"@types/node": versions.nodeTypes,
			typescript: versions.typescript,
			"vite-plus": versions.vitePlus,
		},
	});
	await json("extension.json", {
		id,
		name,
		description: "Example subscription source",
		version: "0.1.0",
		apiVersion: 1,
		contributes: {
			subscription: { label: name, searchAccepts: ["id", "name"], supportedFeatures: ["post"] },
		},
	});
	await json(".bn/marketplace.json", {
		schemaVersion: 1,
		repository,
		name,
		namespace,
		owner: { name: repository.split("/")[0] },
	});
	await writeFile(join(target, ".node-version"), `${versions.node}\n`);
	if (!values["no-git"]) {
		run("git", ["init", "--initial-branch=main"], target);
		run("git", ["remote", "add", "origin", `https://github.com/${repository}.git`], target);
	}
	run("vp", ["install", "--no-frozen-lockfile", ...(values.offline ? ["--offline"] : [])], target);
	run("vp", ["run", "format"], target);
	console.log(
		`Created ${id} in ${target}. Run vp run verify, then commit the generated lockfile and hooks.`,
	);
}

create().catch((error: unknown) => {
	console.error(`create-extension: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
