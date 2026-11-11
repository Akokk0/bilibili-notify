#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
	ExtensionIdSchema,
	extensionNamespaceOf,
	normalizeMarketplaceSourceUrl,
} from "@bilibili-notify/internal";
import { run } from "./process";

function extensionId(input: string | undefined) {
	const parsed = ExtensionIdSchema.safeParse(input);
	const namespace = parsed.success ? extensionNamespaceOf(parsed.data) : undefined;
	if (!parsed.success || !namespace || namespace.length > 32)
		throw new Error(
			"Use a third-party extension id: namespace.extension (namespace <= 32 characters).",
		);
	return { id: parsed.data, namespace };
}

function githubRepository(input: string | undefined): string {
	const repository = input
		?.trim()
		.replace(/\.git$/i, "")
		.toLowerCase();
	if (!repository || repository.includes(":") || !normalizeMarketplaceSourceUrl(repository).ok)
		throw new Error("Provide a GitHub repository as owner/repo.");
	return repository;
}

function displayName(name: string): string {
	if (!name.trim() || name.length > 64) throw new Error("Name must contain 1–64 characters.");
	return name;
}

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
			interactive: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(
			"create-bn-ext [directory] [--id namespace.extension --repository owner/repo] [--name Name] [--interactive] [--offline] [--no-git]\nMissing values are prompted for in a terminal. Use --interactive to enable prompts explicitly.\nUse --sdk / --tools to test local npm archives before publishing.",
		);
		return;
	}
	if (positionals.length > 1) throw new Error("Provide one new project directory.");
	const missing = !positionals[0] || !values.id || !values.repository;
	if (values.interactive || (missing && process.stdin.isTTY && !process.env.CI)) {
		const prompt = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: process.stdin.isTTY === true,
		});
		const answers = prompt[Symbol.asyncIterator]();
		prompt.on("SIGINT", () => prompt.close());
		const ask = async (
			label: string,
			initial = "",
			validate?: (value: string) => unknown,
		): Promise<string> => {
			while (true) {
				process.stdout.write(`${label}${initial ? ` [${initial}]` : ""}: `);
				const answer = await answers.next();
				if (answer.done)
					throw new Error("Setup cancelled: input ended before all values were provided.");
				const value = answer.value.trim() || initial;
				try {
					validate?.(value);
					return value;
				} catch (error) {
					console.log(error instanceof Error ? error.message : String(error));
				}
			}
		};
		try {
			if (!positionals[0]) positionals.push(await ask("Project directory", "my-extension"));
			if (!values.id) values.id = await ask("Extension ID (namespace.extension)", "", extensionId);
			if (!values.repository)
				values.repository = await ask("GitHub repository (owner/repo)", "", githubRepository);
			if (values.name === undefined)
				values.name = await ask("Display name", values.id, displayName);
		} finally {
			prompt.close();
		}
	}
	if (positionals.length !== 1) throw new Error("Provide one new project directory.");
	const { id, namespace } = extensionId(values.id);
	const repository = githubRepository(values.repository);
	const name = displayName(values.name ?? id);
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
			"create-bn-ext": values.tools ?? versions.tools,
			"@commitlint/cli": versions.commitlint,
			"@commitlint/config-conventional": versions.commitlintConfig,
			"@types/node": versions.nodeTypes,
			typescript: versions.typescript,
			"vite-plus": versions.vitePlus,
		},
	});
	const vitePlusMajor = versions.vitePlus.split(".")[0];
	await writeFile(
		join(target, "pnpm-workspace.yaml"),
		`# Vite+ exposes Vite under the core's version; keep exceptions consumer-specific.
packages:
  - "."
peerDependencyRules:
  allowedVersions:
    "vitest>vite": "${vitePlusMajor}"
    "@vitest/mocker>vite": "${vitePlusMajor}"
`,
	);
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
	console.error(`create-bn-ext: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
