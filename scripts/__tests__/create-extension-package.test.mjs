import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { BUILTIN_INTEGRATION_KEYS } from "../../apps/server/src/compose.js";
import {
	installExtensionPackage,
	openExtensionPackage,
} from "../../apps/server/src/extensions/install.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { parse: parseYaml } = createRequire(join(REPO, "apps/server/package.json"))("yaml");
const { packageManager } = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
const { name: toolsName } = JSON.parse(
	await readFile(join(REPO, "tools/create-extension/package.json"), "utf8"),
);

function run(command, args, cwd, env = {}, input) {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
			input,
			timeout: 90_000,
			maxBuffer: 8 * 1024 * 1024,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.test",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.test",
				...env,
			},
		});
	} catch (error) {
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`,
			{ cause: error },
		);
	}
}

describe("创建器的实际npm包在仓外生成可开发的拓展工程", () => {
	let root;
	let tools;
	let sdk;
	let host;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "bn-create-package-"));
		sdk = join(root, "sdk.tgz");
		tools = join(root, "tools.tgz");
		run("vp", ["pm", "pack", "--out", sdk, "--json"], join(REPO, "packages/extension"));
		run("vp", ["pm", "pack", "--out", tools, "--json"], join(REPO, "tools/create-extension"));
		host = join(root, "host");
		await mkdir(host);
		await writeFile(
			join(host, "package.json"),
			JSON.stringify({
				private: true,
				packageManager,
				devDependencies: { [toolsName]: `file:${tools}` },
			}),
		);
		run("vp", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], host);
	}, 120_000);

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	}, 60_000);

	it("npm create bn-ext能找到创建器并生成使用同一发布工具的工程", async () => {
		const manifest = JSON.parse(
			await readFile(join(host, "node_modules", toolsName, "package.json"), "utf8"),
		);
		expect(manifest.name).toBe("create-bn-ext");
		const project = join(root, "short-entry");
		run(
			"vp",
			[
				"exec",
				"npm",
				"--offline",
				"create",
				`bn-ext@${manifest.version}`,
				"--",
				project,
				"--id",
				"example.short",
				"--sdk",
				`file:${sdk}`,
				"--tools",
				`file:${tools}`,
				"--offline",
			],
			host,
		);
		const generated = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
		expect(generated.devDependencies["create-bn-ext"]).toBe(`file:${tools}`);
		expect(generated.scripts).not.toHaveProperty("dev");
		expect(generated.scripts).not.toHaveProperty("start");
		run("vp", ["run", "verify"], project);
	}, 120_000);

	it("交互向导只收集目录、ID 和显示名，无远端也能通过工程门禁", async () => {
		const project = join(root, "wizard");
		run(
			"vp",
			[
				"exec",
				"create-bn-ext",
				"--interactive",
				"--sdk",
				`file:${sdk}`,
				"--tools",
				`file:${tools}`,
				"--offline",
			],
			host,
			{},
			`${project}\nexample.wizard\nWizard extension\n`,
		);
		expect(JSON.parse(await readFile(join(project, "extension.json"), "utf8"))).toMatchObject({
			id: "example.wizard",
			name: "Wizard extension",
		});
		expect(
			JSON.parse(await readFile(join(project, ".bn-extension/marketplace.json"), "utf8")),
		).toEqual({
			schemaVersion: 1,
			name: "Wizard extension",
			namespace: "example",
			owner: { name: "example" },
		});
		expect(run("git", ["remote"], project).trim()).toBe("");
		for (const oldPath of [".bn/marketplace.json", "bn-extension/marketplace.json"])
			await expect(access(join(project, oldPath))).rejects.toMatchObject({ code: "ENOENT" });
		run("vp", ["run", "verify"], project);
	}, 120_000);

	it("向导在当前字段纠正无效ID，空显示名使用ID默认值", async () => {
		const project = join(host, "my-extension");
		run(
			"vp",
			[
				"exec",
				"create-bn-ext",
				"--interactive",
				"--sdk",
				`file:${sdk}`,
				"--tools",
				`file:${tools}`,
				"--offline",
			],
			host,
			{},
			"\nbad id\nexample.corrected\n\n",
		);
		expect(JSON.parse(await readFile(join(project, "extension.json"), "utf8"))).toMatchObject({
			id: "example.corrected",
			name: "example.corrected",
		});
	}, 120_000);

	it("参数可与向导混用，输入中断不会写入半个工程", async () => {
		const project = join(root, "wizard-cancelled");
		expect(() =>
			run(
				"vp",
				["exec", "create-bn-ext", project, "--id", "example.cancelled", "--interactive"],
				host,
				{},
				"",
			),
		).toThrow(/Setup cancelled/);
		await expect(access(project)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("非终端缺少参数时退出而不等待交互输入", async () => {
		const project = join(root, "missing-input");
		expect(() => run("vp", ["exec", "create-bn-ext", project], host)).toThrow(
			/namespace.extension/,
		);
		await expect(access(project)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("生成后以冻结锁安装，vp门禁通过，宿主安装ZIP后可以调用动态导入的查询", async () => {
		const project = join(root, "example");
		run(
			"vp",
			[
				"exec",
				"create-bn-ext",
				project,
				"--id",
				"example.demo",
				"--repository",
				"Owner/Tools",
				"--name",
				"Example",
				"--sdk",
				`file:${sdk}`,
				"--tools",
				`file:${tools}`,
				"--offline",
			],
			host,
		);
		run("vp", ["install", "--offline", "--frozen-lockfile"], project);
		expect(run("git", ["remote", "get-url", "origin"], project).trim()).toBe(
			"https://github.com/owner/tools.git",
		);
		const market = JSON.parse(
			await readFile(join(project, ".bn-extension/marketplace.json"), "utf8"),
		);
		expect(market.owner.name).toBe("owner");
		expect(market).not.toHaveProperty("repository");
		run("vp", ["exec", "pnpm", "peers", "check"], project);
		const src = join(project, "src");
		await rename(join(src, "index.ts"), join(src, "example.ts"));
		await writeFile(
			join(src, "index.ts"),
			`import type { ExtensionContext } from "@bilibili-notify/extension";
export { settingsSchema } from "./example";
export function activate(ctx: ExtensionContext) {
  ctx.registerSource({
    start() {},
    stop() {},
    async searchCreators(name) {
      const { candidate } = await import("./lookup");
      return { ok: true, candidates: [candidate(name)] };
    },
  });
}
`,
		);
		await writeFile(
			join(src, "lookup.ts"),
			`export function candidate(name: string) {
  return { externalId: "42", name };
}
`,
		);
		run("vp", ["run", "verify"], project);
		const skill = await readFile(
			join(project, ".agents/skills/bn-extension-development/SKILL.md"),
			"utf8",
		);
		expect(skill).toBe(
			await readFile(
				join(
					project,
					"node_modules/@bilibili-notify/extension/skills/bn-extension-development/SKILL.md",
				),
				"utf8",
			),
		);
		for (const name of [
			"AGENTS.md",
			"CLAUDE.md",
			".claude/skills/bn-extension-development/SKILL.md",
		]) {
			const file = join(project, name);
			const instructions = await readFile(file, "utf8");
			expect(instructions.trim()).not.toBe("");
			for (const [, target] of instructions.matchAll(/\]\(([^)]+)\)/g)) {
				await readFile(resolve(dirname(file), target.split("#")[0]));
			}
		}
		const opened = openExtensionPackage(
			new Uint8Array(await readFile(join(project, "artifacts/example.demo-0.1.0.zip"))),
			BUILTIN_INTEGRATION_KEYS,
		);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.pkg.manifest).toMatchObject({
			id: "example.demo",
			version: "0.1.0",
			apiVersion: 1,
			settings: { fields: [expect.objectContaining({ key: "greeting" })] },
		});
		const installed = join(root, "installed");
		await installExtensionPackage({ root: installed, pkg: opened.pkg });
		const lookup = run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { activate } from "./index.mjs";
let source;
activate({ registerSource(def) { source = def; } });
console.log(JSON.stringify(await source.searchCreators("Alex", new AbortController().signal)));`,
			],
			join(installed, "example.demo"),
		);
		expect(JSON.parse(lookup)).toEqual({
			ok: true,
			candidates: [{ externalId: "42", name: "Alex" }],
		});
	}, 120_000);

	it.each(["", ".existing-hooks"])(
		"选择不初始化Git时，不更改外层仓库的hooks（%s）",
		async (hooks) => {
			const outer = join(root, `outer-${hooks ? "configured" : "empty"}`);
			await mkdir(outer);
			run("git", ["init", "--initial-branch=main"], outer);
			if (hooks) run("git", ["config", "core.hooksPath", hooks], outer);
			run(
				"vp",
				[
					"exec",
					"create-bn-ext",
					join(outer, "nested"),
					"--id",
					"example.nested",
					"--repository",
					"Owner/Tools",
					"--sdk",
					`file:${sdk}`,
					"--tools",
					`file:${tools}`,
					"--offline",
					"--no-git",
				],
				host,
			);
			const configured = run("git", ["config", "--local", "--list"], outer)
				.split("\n")
				.find((line) => line.startsWith("core.hookspath="));
			expect(configured).toBe(hooks ? `core.hookspath=${hooks}` : undefined);
		},
		120_000,
	);

	it("本地提交会拒绝错误消息、lint与格式；修正后同一组hooks放行", async () => {
		const project = join(root, "hooks");
		run(
			"vp",
			[
				"exec",
				"create-bn-ext",
				project,
				"--id",
				"example.hooks",
				"--repository",
				"Owner/Tools",
				"--sdk",
				`file:${sdk}`,
				"--tools",
				`file:${tools}`,
				"--offline",
			],
			host,
		);
		run("git", ["add", "."], project);
		expect(() => run("git", ["commit", "-m", "wrong message"], project)).toThrow(
			/type-empty|subject-empty/,
		);
		run("git", ["commit", "-m", "feat: create extension"], project);
		const source = join(project, "src/greeting.ts");
		const original = await readFile(source, "utf8");
		await writeFile(source, `${original}\nconst unused = 1;\n`);
		run("git", ["add", "src/greeting.ts"], project);
		expect(() => run("git", ["commit", "-m", "chore: invalid lint"], project)).toThrow(
			/no-unused-vars/,
		);
		await writeFile(source, `${original}\nexport const values=[1,2,3];\n`);
		run("git", ["add", "src/greeting.ts"], project);
		expect(() => run("git", ["commit", "-m", "chore: invalid format"], project)).toThrow(
			/format|Format/,
		);
		run("vp", ["run", "format"], project);
		run("git", ["add", "src/greeting.ts"], project);
		run("git", ["commit", "-m", "chore: format source"], project);
		expect(run("git", ["log", "-1", "--format=%s"], project).trim()).toBe("chore: format source");
	}, 120_000);

	it("生成的分支CI复验整段提交，不能只检查最后一个合法消息", async () => {
		const project = join(root, "ci");
		run(
			"vp",
			[
				"exec",
				"create-bn-ext",
				project,
				"--id",
				"example.ci",
				"--repository",
				"Owner/Tools",
				"--sdk",
				`file:${sdk}`,
				"--tools",
				`file:${tools}`,
				"--offline",
			],
			host,
		);
		run("git", ["add", "."], project);
		run("git", ["commit", "-m", "feat: initial extension"], project, { VP_GIT_HOOKS: "0" });
		const first = run("git", ["rev-parse", "HEAD"], project).trim();
		run("git", ["commit", "--allow-empty", "-m", "wrong message"], project, { VP_GIT_HOOKS: "0" });
		const bad = run("git", ["rev-parse", "HEAD"], project).trim();
		run("git", ["commit", "--allow-empty", "-m", "chore: valid tip"], project, {
			VP_GIT_HOOKS: "0",
		});
		const head = run("git", ["rev-parse", "HEAD"], project).trim();
		const workflow = parseYaml(
			await readFile(join(project, ".github/workflows/check.yml"), "utf8"),
		);
		expect(workflow.permissions).toEqual({ contents: "read" });
		const check = workflow.jobs.check.steps.find((step) => step.name === "Check branch commits");
		for (const from of [first, "0000000000000000000000000000000000000000"]) {
			expect(() =>
				run("bash", ["-e", "-o", "pipefail", "-c", check.run], project, { BASE: from, HEAD: head }),
			).toThrow(/type-empty/);
		}
		run("bash", ["-e", "-o", "pipefail", "-c", check.run], project, { BASE: bad, HEAD: head });
	}, 120_000);
});
