import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	checkMarketplaceIndex,
	MarketplaceIndexSchema,
} from "../../packages/internal/src/schema/extension-marketplace.ts";
import { githubReleaseFixture } from "./helpers/github-release-fixture.mjs";

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { parse: parseYaml } = createRequire(join(REPO, "apps/server/package.json"))("yaml");
const { packageManager } = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));

const indexedEntry = (id, version, apiVersion = 1) => ({
	id,
	version,
	apiVersion,
	name: id,
	description: "",
	prerelease: version.includes("-"),
	package: {
		url: `https://packages.example/${id}-${version}.zip`,
		sha256: "a".repeat(64),
		size: 100,
	},
});
const oldIndex = (extensions) => ({
	name: "example.demo",
	namespace: "example",
	owner: { name: "owner" },
	issuedAt: 1700000000,
	extensions,
});

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

describe("生成工程的公开发布命令", () => {
	let root;
	let sdk;
	let tools;
	let host;
	let github;
	let endpoint;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "bn-project-release-"));
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
		github = await githubReleaseFixture();
		endpoint = github.endpoint;
	}, 120_000);

	afterAll(async () => {
		if (github) await github.close();
		if (root) await rm(root, { recursive: true, force: true });
	}, 60_000);

	beforeEach(() => github.reset());

	async function project(name) {
		const cwd = join(root, name);
		run(
			"vp",
			[
				"exec",
				"create-extension",
				cwd,
				"--id",
				"example.demo",
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
		run("git", ["add", "."], cwd);
		run("git", ["commit", "-m", "feat: initial extension"], cwd, { VP_GIT_HOOKS: "0" });
		run("git", ["tag", "v0.1.0"], cwd);
		github.state.head = run("git", ["rev-parse", "HEAD"], cwd).trim();
		return cwd;
	}

	async function release(cwd, args = []) {
		return exec(
			"vp",
			["exec", "bn-extension", "release", "--tag", "v0.1.0", "--api-base", endpoint, ...args],
			{
				cwd,
				encoding: "utf8",
				timeout: 90_000,
				maxBuffer: 8 * 1024 * 1024,
				env: {
					...process.env,
					GITHUB_TOKEN: "local-fixture-token",
					GITHUB_REPOSITORY: "owner/tools",
				},
			},
		);
	}

	async function bump(cwd, version) {
		const path = join(cwd, "extension.json");
		const manifest = JSON.parse(await readFile(path, "utf8"));
		manifest.version = version;
		await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
		run("vp", ["run", "format"], cwd);
		run("git", ["add", "extension.json"], cwd);
		run("git", ["commit", "-m", `chore: release ${version}`], cwd, { VP_GIT_HOOKS: "0" });
		run("git", ["tag", `v${version}`], cwd);
		github.state.head = run("git", ["rev-parse", "HEAD"], cwd).trim();
	}

	it("dry-run实际跑全部vp门禁并生成可复查条目，不请求GitHub或创建发行", async () => {
		const cwd = await project("dry-run");
		const { stdout } = await release(cwd, ["--dry-run"]);
		expect(JSON.parse(stdout.trim().split("\n").at(-1))).toMatchObject({
			dryRun: true,
			tag: "v0.1.0",
		});
		expect(
			JSON.parse(await readFile(join(cwd, "artifacts/marketplace-entry.json"), "utf8")),
		).toMatchObject({
			id: "example.demo",
			version: "0.1.0",
			package: {
				url: "https://github.com/owner/tools/releases/download/v0.1.0/example.demo-0.1.0.zip",
				sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				size: expect.any(Number),
			},
		});
		expect(github.state.requests).toEqual([]);
	}, 120_000);

	it("先上传并发布版本ZIP，再发布固定索引；索引符合宿主格式，同一版本重跑不覆盖资产", async () => {
		const cwd = await project("publish");
		await release(cwd);
		const index = MarketplaceIndexSchema.parse(await github.readIndex());
		expect(checkMarketplaceIndex(index, { official: false }).ok).toBe(true);
		expect(index).toMatchObject({
			namespace: "example",
			extensions: [
				{
					id: "example.demo",
					version: "0.1.0",
					package: {
						url: "https://github.com/owner/tools/releases/download/v0.1.0/example.demo-0.1.0.zip",
					},
				},
			],
		});
		const requests = github.state.requests;
		const zip = requests.findIndex(
			(item) => item.method === "POST" && item.name === "example.demo-0.1.0.zip",
		);
		const publish = requests.findIndex(
			(item) =>
				item.method === "PATCH" &&
				/^\/repos\/owner\/tools\/releases\/\d+$/.test(item.path) &&
				item.json?.draft === false,
		);
		const market = requests.findIndex(
			(item) => item.method === "POST" && item.name?.includes("marketplace"),
		);
		expect(zip).toBeGreaterThan(-1);
		expect(publish).toBeGreaterThan(zip);
		expect(market).toBeGreaterThan(publish);
		const writes = requests.filter((item) => item.method !== "GET").length;
		await release(cwd);
		expect(github.state.requests.filter((item) => item.method !== "GET")).toHaveLength(writes);
	}, 120_000);

	it("tag与清单不一致或本地门禁失败时，不请求GitHub", async () => {
		const cwd = await project("gate-failure");
		await expect(release(cwd, ["--tag", "v9.0.0"])).rejects.toThrow(/must match extension.json/);
		const path = join(cwd, "package.json");
		const manifest = JSON.parse(await readFile(path, "utf8"));
		manifest.scripts.verify = "node -e \"throw new Error('gate refused')\"";
		await writeFile(path, JSON.stringify(manifest, null, 2));
		await expect(release(cwd)).rejects.toThrow(/gate refused/);
		expect(github.state.requests).toEqual([]);
	}, 120_000);

	it("发布和dry-run都会复验提交消息，不能绕过本地hooks发布错误提交", async () => {
		const cwd = await project("commit-gate");
		run("git", ["commit", "--allow-empty", "-m", "wrong message"], cwd, { VP_GIT_HOOKS: "0" });
		run("git", ["tag", "-f", "v0.1.0"], cwd);
		github.state.head = run("git", ["rev-parse", "HEAD"], cwd).trim();
		await expect(release(cwd, ["--dry-run"])).rejects.toMatchObject({
			code: 1,
			stdout: expect.stringContaining("type-empty"),
		});
		expect(github.state.requests).toEqual([]);
	}, 120_000);

	it("ZIP上传失败不会发布索引；重跑找到原草稿并完成，不重复创建版本Release", async () => {
		const cwd = await project("upload-retry");
		github.state.failure = (request) =>
			request.method === "POST" && request.name === "example.demo-0.1.0.zip";
		await expect(release(cwd)).rejects.toThrow(/HTTP 503/);
		expect(
			[...github.state.releases.values()].some((item) => item.tag_name === "bn-marketplace"),
		).toBe(false);
		await release(cwd);
		expect((await github.readIndex()).extensions[0].version).toBe("0.1.0");
		expect(
			github.state.requests.filter(
				(item) =>
					item.method === "POST" &&
					item.path.endsWith("/releases") &&
					item.json?.tag_name === "v0.1.0",
			),
		).toHaveLength(1);
	}, 120_000);

	it("索引晋升失败保留上一份可用索引，重跑复用版本ZIP并完成索引更新", async () => {
		const cwd = await project("index-retry");
		await release(cwd);
		await bump(cwd, "0.2.0");
		github.state.failure = (request) =>
			request.method === "PATCH" && request.json?.name === "marketplace.json";
		await expect(release(cwd, ["--tag", "v0.2.0"])).rejects.toThrow(/HTTP 503/);
		expect((await github.readIndex()).extensions[0].version).toBe("0.1.0");
		await release(cwd, ["--tag", "v0.2.0"]);
		expect((await github.readIndex()).extensions[0].version).toBe("0.2.0");
		expect(
			github.state.requests.filter(
				(item) => item.method === "POST" && item.name === "example.demo-0.2.0.zip",
			),
		).toHaveLength(1);
	}, 120_000);

	it("首次索引已上传但发布草稿失败后，重跑会真正公开索引", async () => {
		const cwd = await project("index-draft-retry");
		github.state.failure = (request) =>
			request.method === "PATCH" &&
			request.json?.draft === false &&
			[...github.state.releases.values()].some(
				(item) =>
					item.tag_name === "bn-marketplace" && request.path.endsWith(`/releases/${item.id}`),
			);
		await expect(release(cwd)).rejects.toThrow(/HTTP 503/);
		await release(cwd);
		expect(
			[...github.state.releases.values()].find((item) => item.tag_name === "bn-marketplace")?.draft,
		).toBe(false);
		expect((await github.readIndex()).extensions[0].version).toBe("0.1.0");
	}, 120_000);

	it("已有同名版本ZIP的字节改变时拒绝覆盖，保留现有索引和所有资产", async () => {
		const cwd = await project("immutable-asset");
		await release(cwd);
		const zip = [...github.state.assets.values()].find(
			(item) => item.asset.name === "example.demo-0.1.0.zip",
		);
		zip.bytes = Buffer.from("changed remote bytes");
		const writes = github.state.requests.filter((item) => item.method !== "GET").length;
		await expect(release(cwd)).rejects.toThrow(/differs; use a new version/);
		expect(github.state.requests.filter((item) => item.method !== "GET")).toHaveLength(writes);
	}, 120_000);

	it("更新只替换自己的同档同API条目，保留预发布、其他API、其他拓展和撤回记录", async () => {
		const cwd = await project("channels");
		github.seedIndex({
			...oldIndex([
				indexedEntry("example.demo", "0.0.5"),
				indexedEntry("example.demo", "0.3.0-alpha.1"),
				indexedEntry("example.demo", "9.0.0", 2),
				indexedEntry("example.other", "1.0.0"),
			]),
			revoked: ["example.other@0.9.0"],
		});
		await release(cwd);
		const index = await github.readIndex();
		expect(index.extensions.map((entry) => [entry.id, entry.version, entry.apiVersion])).toEqual([
			["example.demo", "0.1.0", 1],
			["example.demo", "0.3.0-alpha.1", 1],
			["example.demo", "9.0.0", 2],
			["example.other", "1.0.0", 1],
		]);
		expect(index.revoked).toEqual(["example.other@0.9.0"]);
		expect(index.issuedAt).toBeGreaterThan(1700000000);
	}, 120_000);

	it("较旧tag可补齐版本发行，但不会把固定索引降回旧版", async () => {
		const cwd = await project("old-tag");
		github.seedIndex(oldIndex([indexedEntry("example.demo", "0.2.0")]));
		await release(cwd);
		expect((await github.readIndex()).extensions[0].version).toBe("0.2.0");
		expect(
			github.state.requests.some(
				(item) => item.method === "POST" && item.name?.includes("marketplace"),
			),
		).toBe(false);
	}, 120_000);

	it("既有索引声明另一命名空间时拒绝发版，不对远端写入", async () => {
		const cwd = await project("namespace-conflict");
		github.seedIndex({
			...oldIndex([indexedEntry("another.demo", "0.2.0")]),
			namespace: "another",
		});
		await expect(release(cwd)).rejects.toThrow(/namespace does not match/);
		expect(github.state.requests.filter((item) => item.method !== "GET")).toEqual([]);
	}, 120_000);

	it("生成的发布Actions以只读门禁执行真实dry-run，发布作业须依赖门禁且单独取得写权限", async () => {
		const cwd = await project("actions");
		const workflow = parseYaml(await readFile(join(cwd, ".github/workflows/release.yml"), "utf8"));
		expect(workflow.on.push.tags).toEqual(["v*"]);
		expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.verify.permissions?.contents ?? workflow.permissions.contents).toBe(
			"read",
		);
		expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
		expect(workflow.jobs.publish.needs).toBe("verify");
		expect(workflow.jobs.publish.permissions).toEqual({ contents: "write" });
		expect(workflow.jobs.publish.if).toContain("dry_run");
		const gate = workflow.jobs.verify.steps.find(
			(step) => step.name === "Verify release without publishing",
		);
		await exec("bash", ["-e", "-o", "pipefail", "-c", gate.run], {
			cwd,
			encoding: "utf8",
			timeout: 90_000,
			env: { ...process.env, TAG: "v0.1.0", GITHUB_REPOSITORY: "owner/tools" },
			maxBuffer: 8 * 1024 * 1024,
		});
		expect(github.state.requests).toEqual([]);
		const publish = workflow.jobs.publish.steps.find(
			(step) => step.name === "Publish version assets then marketplace",
		);
		expect(publish.env.GITHUB_TOKEN).toMatch(/^\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}$/);
		await exec("bash", ["-e", "-o", "pipefail", "-c", `${publish.run} --api-base "$API_BASE"`], {
			cwd,
			encoding: "utf8",
			timeout: 90_000,
			maxBuffer: 8 * 1024 * 1024,
			env: {
				...process.env,
				TAG: "v0.1.0",
				API_BASE: endpoint,
				GITHUB_TOKEN: "local-fixture-token",
				GITHUB_REPOSITORY: "owner/tools",
			},
		});
		expect((await github.readIndex()).extensions[0].version).toBe("0.1.0");
	}, 120_000);
});
