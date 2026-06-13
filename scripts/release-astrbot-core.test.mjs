import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(repoRoot, "scripts", "release-astrbot-core.mjs");

async function git(args, cwd) {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
}

// 构造一个最小的「已构建插件」源目录:含构建产物 + 运行态/缓存(应被排除)。
async function makeSource(root) {
	const src = join(root, "core");
	await mkdir(join(src, "sidecar", "app"), { recursive: true });
	await mkdir(join(src, "pages", "dashboard"), { recursive: true });
	await mkdir(join(src, "sidecar", "state"), { recursive: true });
	await mkdir(join(src, "__pycache__"), { recursive: true });
	await mkdir(join(src, "tests", "__pycache__"), { recursive: true });
	await writeFile(join(src, "metadata.yaml"), "name: astrbot_plugin_bilibili_notify\n");
	await writeFile(join(src, "main.py"), "# plugin\n");
	await writeFile(join(src, "sidecar", "app", "index.mjs"), "// sidecar bundle\n");
	await writeFile(join(src, "pages", "dashboard", "index.html"), "<!doctype html>\n");
	await writeFile(join(src, "sidecar", "state", "subs.json"), "[]\n");
	await writeFile(join(src, "__pycache__", "x.pyc"), "cache\n");
	// 嵌套 __pycache__(如 tests/)—— 顶层判断漏掉、git add -f 又无视 .gitignore 的泄漏点。
	await writeFile(join(src, "tests", "__pycache__", "t.pyc"), "cache\n");
	await writeFile(join(src, "debug.log"), "log\n");
	// 复刻真实 astrbot/core:内嵌 .gitignore 会 ignore 自己的产物(sidecar/app/),
	// 若 cp 带过去会让 staging 仓的 git add 漏掉 sidecar bundle。
	await writeFile(join(src, ".gitignore"), "__pycache__/\nsidecar/state/\n");
	await writeFile(join(src, "sidecar", ".gitignore"), "app/\nstate/\nlogs/\n");
	return src;
}

async function runRelease(args) {
	return execFileAsync(process.execPath, [scriptPath, ...args], { cwd: repoRoot });
}

describe("release-astrbot-core", () => {
	let tmp;
	let bare;
	let source;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "bn-release-"));
		bare = join(tmp, "plugin.git");
		await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
		source = await makeSource(tmp);
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("publishes built artifacts (sidecar bundle + dashboard) as a single root commit", async () => {
		await runRelease(["--source", source, "--remote", bare, "--branch", "main"]);

		const log = (await git(["--git-dir", bare, "log", "--format=%H|%P", "main"], tmp))
			.split("\n")
			.filter(Boolean);
		expect(log).toHaveLength(1);
		expect(log[0].split("|")[1]).toBe(""); // 首次无父(根提交)

		const files = (
			await git(["--git-dir", bare, "ls-tree", "-r", "--name-only", "main"], tmp)
		).split("\n");
		// 构建产物必须发布(否则插件跑不起来) —— 这是 git-only 方案漏掉的关键。
		expect(files).toContain("sidecar/app/index.mjs");
		expect(files).toContain("pages/dashboard/index.html");
		expect(files).toContain("metadata.yaml");
		expect(files).toContain("main.py");
		// 运行态/缓存不发布(任何层级的 __pycache__、.pyc、.log、运行态目录)。
		expect(files.some((f) => f.startsWith("sidecar/state/"))).toBe(false);
		expect(files.some((f) => f.split("/").includes("__pycache__"))).toBe(false);
		expect(files.some((f) => f.endsWith(".pyc") || f.endsWith(".log"))).toBe(false);
		// monorepo 的 .gitignore 不进发布仓(否则会 ignore 已发布的产物)。
		expect(files.some((f) => f.endsWith(".gitignore"))).toBe(false);
	});

	it("stacks a second snapshot with the previous tip as parent (non-force)", async () => {
		await runRelease(["--source", source, "--remote", bare, "--branch", "main"]);
		const first = await git(["--git-dir", bare, "rev-parse", "main"], tmp);

		await runRelease(["--source", source, "--remote", bare, "--branch", "main"]);
		const log = (await git(["--git-dir", bare, "log", "--format=%H|%P", "main"], tmp))
			.split("\n")
			.filter(Boolean);
		expect(log).toHaveLength(2);
		expect(log[0].split("|")[1]).toBe(first); // 新提交以首次为父,非 force
	});

	it("aborts when a required build artifact is missing", async () => {
		await rm(join(source, "sidecar", "app", "index.mjs"));
		await expect(
			runRelease(["--source", source, "--remote", bare, "--branch", "main"]),
		).rejects.toBeTruthy();
		// 中止时不应推送任何东西。
		await expect(git(["--git-dir", bare, "rev-parse", "main"], tmp)).rejects.toBeTruthy();
	});

	it("does not push under --dry-run", async () => {
		await runRelease(["--source", source, "--remote", bare, "--branch", "main", "--dry-run"]);
		await expect(git(["--git-dir", bare, "rev-parse", "main"], tmp)).rejects.toBeTruthy();
	});

	it("honors --dry-run even when vp forwards a -- separator", async () => {
		// 复刻 `vp run release:astrbot-core -- --dry-run`:转发的 `--` 不能让 --dry-run 失效。
		await runRelease(["--", "--dry-run", "--source", source, "--remote", bare, "--branch", "main"]);
		await expect(git(["--git-dir", bare, "rev-parse", "main"], tmp)).rejects.toBeTruthy();
	});

	it("signs the commit with the monorepo git identity and honors --message", async () => {
		await runRelease([
			"--source",
			source,
			"--remote",
			bare,
			"--branch",
			"main",
			"--message",
			"chore: publish plugin snapshot",
		]);
		const subject = await git(["--git-dir", bare, "log", "-1", "--format=%s", "main"], tmp);
		expect(subject).toBe("chore: publish plugin snapshot");
		// 署名 == 脚本会用的身份:monorepo git config,无配置(如 CI 全新环境)则回退中性默认。
		// 测试镜像同一回退逻辑,避免在没配 user.email 的 CI 上因 `git config` 报错而失败。
		const email = await git(["--git-dir", bare, "log", "-1", "--format=%ae", "main"], tmp);
		let expectedEmail = "release@bilibili-notify.local";
		try {
			expectedEmail = await git(["config", "user.email"], repoRoot);
		} catch {
			// repoRoot 未配 git 身份 → 脚本回退默认,测试同此
		}
		expect(email).toBe(expectedEmail);
	});

	it("--reset force-overwrites the remote with a single root commit", async () => {
		await runRelease(["--source", source, "--remote", bare, "--branch", "main"]);
		await runRelease(["--source", source, "--remote", bare, "--branch", "main"]);
		expect(
			(await git(["--git-dir", bare, "log", "--format=%H", "main"], tmp))
				.split("\n")
				.filter(Boolean),
		).toHaveLength(2);

		await runRelease(["--source", source, "--remote", bare, "--branch", "main", "--reset"]);
		const log = (await git(["--git-dir", bare, "log", "--format=%H|%P", "main"], tmp))
			.split("\n")
			.filter(Boolean);
		expect(log).toHaveLength(1); // 历史被重置为单个提交
		expect(log[0].split("|")[1]).toBe(""); // 且无父(根提交)
	});
});
