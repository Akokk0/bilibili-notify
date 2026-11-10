import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { BUILTIN_INTEGRATION_KEYS } from "../../apps/server/src/compose.js";
import { openExtensionPackage } from "../../apps/server/src/extensions/install.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { parse: parseYaml } = createRequire(join(REPO, "apps/server/package.json"))("yaml");
const { packageManager } = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));

function run(command, args, cwd, env = {}) {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
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
				devDependencies: { "@bilibili-notify/create-extension": `file:${tools}` },
			}),
		);
		run("vp", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], host);
	}, 120_000);

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	}, 60_000);

	it("生成后以冻结锁安装，vp检查、类型、测试、构建和打包全部通过，ZIP可由宿主接收", async () => {
		const project = join(root, "example");
		run(
			"vp",
			[
				"exec",
				"create-extension",
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
					"create-extension",
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
				"create-extension",
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
				"create-extension",
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
