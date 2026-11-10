import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { BUILTIN_INTEGRATION_KEYS } from "../../apps/server/src/compose.js";
import { openExtensionPackage } from "../../apps/server/src/extensions/install.js";
import { packExtension } from "../pack-extension.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SDK_ROOT = join(REPO_ROOT, "packages/extension");
const SDK_NAME = "@bilibili-notify/extension";
const { packageManager } = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
const require = createRequire(import.meta.url);

async function installedVersion(name) {
	return JSON.parse(await readFile(require.resolve(`${name}/package.json`), "utf8")).version;
}

const CONSUMER_SOURCE = `
import type { ExtensionContext, SourceDef } from "@bilibili-notify/extension";
import { ok } from "@bilibili-notify/extension";
import type { ExtensionEntrySchemas } from "@bilibili-notify/extension/build";
import { z } from "zod";
// @ts-expect-error 宿主的设置不是公开SDK成员。
import type { GlobalSettings } from "@bilibili-notify/extension";

export const settingsSchema = z.object({
  message: z.string().default("Hello").meta({ label: "Message" }),
});
const schemas: ExtensionEntrySchemas = { settingsSchema };
export const source: SourceDef = {
  start() {},
  stop() {},
  async searchCreators() { return ok({ candidates: [] }); },
};
export default {
  activate(ctx: ExtensionContext) {
    ctx.settings(settingsSchema);
    ctx.registerSource(source);
  },
};
void schemas;
`;

const CONSUMER_CONFIG = `
import { defineConfig } from "vite-plus";
import { extensionPackageFiles } from "@bilibili-notify/extension/build";
export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    target: "node24",
    dts: false,
    sourcemap: false,
    deps: { alwaysBundle: [/^@bilibili-notify\\//, /^zod(\\/|$)/], onlyBundle: false },
    plugins: [extensionPackageFiles(process.cwd())],
  },
});
`;

function run(command, args, cwd) {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
			timeout: 30_000,
			maxBuffer: 8 * 1024 * 1024,
		});
	} catch (error) {
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`,
			{ cause: error },
		);
	}
}

describe("SDK的真实npm包可在仓外使用", () => {
	let root;
	let archive;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "bn-sdk-package-"));
		archive = join(root, "sdk.tgz");
		// 与真实发布使用相同的归档入口；需先构建SDK，测试不从源码造另一份假包。
		run("vp", ["pm", "pack", "--out", archive, "--json"], SDK_ROOT);
	}, 40_000);

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	async function createConsumer({ devDependencies = {}, dependencies = {} } = {}) {
		const cwd = await mkdtemp(join(root, "consumer-"));
		await writeFile(
			join(cwd, "package.json"),
			JSON.stringify({
				name: "bn-sdk-consumer",
				private: true,
				type: "module",
				packageManager,
				scripts: { typecheck: "tsc --noEmit", build: "vp pack" },
				dependencies: { [SDK_NAME]: `file:${archive}`, ...dependencies },
				devDependencies,
			}),
		);
		// 只用本地归档和本轮安装已有的公共依赖缓存，子进程也不访问注册表。
		run("vp", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], cwd);
		return cwd;
	}

	it("安装归档后可运行公开函数，无需主仓或私有包", async () => {
		const cwd = await createConsumer();
		await writeFile(
			join(cwd, "probe.mjs"),
			[
				`import * as sdk from "${SDK_NAME}";`,
				"console.log(JSON.stringify({",
				"  exports: Object.keys(sdk).sort(),",
				"  success: sdk.ok({ value: 7 }),",
				'  failure: sdk.fail("invalid", "Bad configuration"),',
				"}));",
			].join("\n"),
		);
		expect(JSON.parse(run(process.execPath, ["probe.mjs"], cwd))).toEqual({
			exports: ["fail", "neutralPlatformDescriptor", "ok"],
			success: { ok: true, value: 7 },
			failure: { ok: false, code: "invalid", message: "Bad configuration" },
		});
	}, 40_000);

	it("仓外编译公开类型并构建宿主能接收的最小来源包", async () => {
		const { version: zodVersion } = JSON.parse(
			await readFile(join(SDK_ROOT, "node_modules/zod/package.json"), "utf8"),
		);
		const cwd = await createConsumer({
			devDependencies: {
				typescript: await installedVersion("typescript"),
				"@types/node": await installedVersion("@types/node"),
				"vite-plus": await installedVersion("vite-plus"),
			},
			dependencies: { zod: zodVersion },
		});
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src/index.ts"), CONSUMER_SOURCE);
		await writeFile(join(cwd, "vite.config.ts"), CONSUMER_CONFIG);
		await writeFile(
			join(cwd, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2023",
					module: "NodeNext",
					strict: true,
					skipLibCheck: false,
					noEmit: true,
					types: ["node"],
				},
				include: ["src", "vite.config.ts"],
			}),
		);
		await writeFile(
			join(cwd, "extension.json"),
			JSON.stringify({
				id: "alice.example",
				name: "Example",
				description: "SDK consumer fixture",
				version: "0.1.0",
				apiVersion: 1,
				contributes: {
					subscription: {
						label: "Example",
						shortLabel: "E",
						color: "#123456",
						creatorNoun: "Creator",
						postNoun: "Post",
						searchAccepts: ["id"],
						supportedFeatures: ["post"],
					},
				},
			}),
		);
		run("vp", ["run", "typecheck"], cwd);
		run("vp", ["run", "build"], cwd);
		const files = Object.fromEntries(
			await Promise.all(
				["index.mjs", "extension.json"].map(async (name) => [
					name,
					new Uint8Array(await readFile(join(cwd, "dist", name))),
				]),
			),
		);
		const opened = openExtensionPackage(packExtension(files).zip, BUILTIN_INTEGRATION_KEYS);
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error(opened.message);
		expect(opened.pkg.manifest).toMatchObject({
			id: "alice.example",
			settings: {
				fields: [{ key: "message", type: "string", label: "Message", default: "Hello" }],
			},
		});
		const published = JSON.parse(
			await readFile(join(cwd, "node_modules", SDK_NAME, "package.json"), "utf8"),
		);
		expect(published.private).not.toBe(true);
		expect(published.dependencies).not.toHaveProperty("@bilibili-notify/internal");
	}, 90_000);
});
