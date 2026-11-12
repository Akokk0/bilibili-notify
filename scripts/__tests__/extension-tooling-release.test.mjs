import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { npmRegistryFixture } from "./helpers/npm-registry-fixture.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);
const { parse: parseYaml } = createRequire(join(REPO, "apps/server/package.json"))("yaml");

describe("SDK与创建器的手动npm发行入口", () => {
	let root;
	let directory;
	let built;
	let actualBuilt;
	let sourceVersions;
	let registry;
	let env;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "bn-tooling-release-"));
		directory = join(root, "packages");
		registry = await npmRegistryFixture();
		const config = join(root, "npmrc");
		await writeFile(
			config,
			`//${new URL(registry.endpoint).host}/:_authToken=local-fixture-token\n`,
		);
		env = { ...process.env, NPM_CONFIG_USERCONFIG: config };
		await exec("vp", ["run", "build:extension-tooling", "--out", directory], {
			cwd: REPO,
			env,
			timeout: 120_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		actualBuilt = directory;
		sourceVersions = await Promise.all(
			["packages/extension", "tools/create-extension"].map(async (path) => {
				const { name, version } = JSON.parse(
					await readFile(join(REPO, path, "package.json"), "utf8"),
				);
				return { name, version };
			}),
		);
		directory = await mkdtemp(join(root, "fixed-fixtures-"));
		await cp(actualBuilt, directory, { recursive: true });
		await rewritePackage("@bilibili-notify/extension", (manifest) => {
			manifest.version = "0.1.0-alpha.0";
		});
		await rewritePackage("create-bn-ext", async (manifest, path) => {
			manifest.version = "0.1.0-alpha.0";
			const file = join(path, "versions.json");
			const versions = JSON.parse(await readFile(file, "utf8"));
			await writeFile(
				file,
				JSON.stringify({ ...versions, sdk: "0.1.0-alpha.0", tools: "0.1.0-alpha.0" }),
			);
		});
		built = directory;
	}, 150_000);
	beforeEach(async () => {
		registry.reset();
		directory = await mkdtemp(join(root, "case-"));
		await cp(built, directory, { recursive: true });
	});
	afterAll(async () => {
		if (registry) await registry.close();
		if (root) await rm(root, { recursive: true, force: true });
	});

	async function release(args = []) {
		return exec(
			"vp",
			[
				"run",
				"release:extension-tooling",
				"--directory",
				directory,
				"--registry",
				registry.endpoint,
				...args,
			],
			{ cwd: REPO, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
		);
	}
	async function rewritePackage(name, change) {
		const file = join(directory, "packages.json");
		const metadata = JSON.parse(await readFile(file, "utf8"));
		const candidate = metadata.packages.find((entry) => entry.name === name);
		const staging = await mkdtemp(join(root, "edit-"));
		await exec("tar", ["-xzf", join(directory, candidate.file), "-C", staging]);
		const manifestFile = join(staging, "package/package.json");
		const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
		await change(manifest, join(staging, "package"));
		await writeFile(manifestFile, JSON.stringify(manifest));
		candidate.version = manifest.version;
		candidate.file = `${name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
		const archive = join(directory, candidate.file);
		await exec("tar", ["-czf", archive, "-C", staging, "package"]);
		const bytes = await readFile(archive);
		Object.assign(candidate, {
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		});
		await writeFile(file, JSON.stringify(metadata));
	}
	it("实际构建两份公开tgz，默认只预检且不写registry", async () => {
		const { stdout } = await release(["--directory", actualBuilt]);
		const result = JSON.parse(stdout.trim().split("\n").at(-1));
		expect(result).toMatchObject({
			dryRun: true,
			packages: sourceVersions,
		});
		expect(
			registry.state.requests.filter((entry) => entry.method !== "GET").map((entry) => entry.path),
		).toEqual([]);
	}, 60_000);
	it("先公开SDK并复验，再发布创建器，预发布不改latest", async () => {
		await release(["--publish"]);
		for (const name of ["@bilibili-notify/extension", "create-bn-ext"]) {
			expect(registry.package(name).tags.alpha).toBe("0.1.0-alpha.0");
			expect(registry.package(name).tags.latest).toBeUndefined();
		}
		expect(
			registry.state.requests.filter((entry) => entry.method === "PUT").map((entry) => entry.path),
		).toEqual([
			"/@bilibili-notify/extension",
			"/-/package/@bilibili-notify/extension/dist-tags/alpha",
			"/create-bn-ext",
			"/-/package/create-bn-ext/dist-tags/alpha",
		]);
	}, 60_000);
	it.each(["size", "sha256"])(
		"任一归档的%s与清单不符时，在上传任何包之前拒绝",
		async (field) => {
			const file = join(directory, "packages.json");
			const metadata = JSON.parse(await readFile(file, "utf8"));
			metadata.packages[1][field] = field === "size" ? 1 : "wrong-sha256";
			await writeFile(file, JSON.stringify(metadata));
			await expect(release(["--publish"])).rejects.toThrow(/integrity mismatch/);
			expect(registry.state.requests).toEqual([]);
		},
		60_000,
	);
	it("第二个包已有同号但内容冲突时，第一个包也不上传", async () => {
		registry.package("create-bn-ext").versions["0.1.0-alpha.0"] = {
			dist: { integrity: "conflicting-content" },
		};
		await expect(release(["--publish"])).rejects.toThrow(/differs/);
		expect(
			registry.state.requests.filter((entry) => entry.method !== "GET").map((entry) => entry.path),
		).toEqual([]);
	}, 60_000);
	it("同版本同内容重跑不重复上传或改渠道", async () => {
		await release(["--publish"]);
		const writes = registry.state.requests.filter((entry) => entry.method === "PUT").length;
		await release(["--publish"]);
		expect(registry.state.requests.filter((entry) => entry.method === "PUT")).toHaveLength(writes);
	}, 60_000);
	it("上传已保存但响应丢失时停止，重跑先核对SDK再补创建器", async () => {
		registry.state.failAfterPublish = true;
		await expect(release(["--publish"])).rejects.toThrow(/503/);
		expect(registry.package("create-bn-ext").versions).toEqual({});
		await release(["--publish"]);
		expect(registry.package("create-bn-ext").tags.alpha).toBe("0.1.0-alpha.0");
		expect(
			registry.state.requests.filter(
				(entry) => entry.method === "PUT" && entry.path === "/@bilibili-notify/extension",
			),
		).toHaveLength(1);
	}, 60_000);
	it("创建器失败后重跑只补缺失步骤，不重发已完成SDK", async () => {
		registry.state.failure = (entry) => entry.method === "PUT" && entry.path === "/create-bn-ext";
		await expect(release(["--publish"])).rejects.toThrow(/503/);
		expect(registry.package("@bilibili-notify/extension").tags.alpha).toBe("0.1.0-alpha.0");
		await release(["--publish"]);
		expect(registry.package("create-bn-ext").tags.alpha).toBe("0.1.0-alpha.0");
		expect(
			registry.state.requests.filter(
				(entry) => entry.method === "PUT" && entry.path === "/@bilibili-notify/extension",
			),
		).toHaveLength(1);
	}, 60_000);
	it("补旧版本不回退两个包各自的alpha渠道", async () => {
		for (const name of ["@bilibili-notify/extension", "create-bn-ext"]) {
			registry.package(name).versions["0.1.0-alpha.10"] = { dist: { integrity: "newer-content" } };
			registry.package(name).tags.alpha = "0.1.0-alpha.10";
		}
		await release(["--publish"]);
		for (const name of ["@bilibili-notify/extension", "create-bn-ext"])
			expect(registry.package(name).tags.alpha).toBe("0.1.0-alpha.10");
	}, 60_000);
	it("可单发SDK；单发创建器必须等其默认SDK版本已上架", async () => {
		await expect(release(["--package", "creator", "--publish"])).rejects.toThrow(
			/Default SDK.*not published/,
		);
		expect(
			registry.state.requests.filter((entry) => entry.method === "PUT").map((entry) => entry.path),
		).toEqual([]);
		await release(["--package", "sdk", "--publish"]);
		expect(registry.package("@bilibili-notify/extension").tags.alpha).toBe("0.1.0-alpha.0");
		expect(registry.package("create-bn-ext").versions).toEqual({});
		await release(["--package", "creator", "--publish"]);
		expect(registry.package("create-bn-ext").tags.alpha).toBe("0.1.0-alpha.0");
	}, 60_000);
	it("SDK与创建器使用独立版本，并各自晋升正式或预发布渠道", async () => {
		await rewritePackage("@bilibili-notify/extension", (manifest) => {
			manifest.version = "0.2.0";
		});
		await rewritePackage("create-bn-ext", async (manifest, path) => {
			manifest.version = "0.3.0-alpha.2";
			const file = join(path, "versions.json");
			const versions = JSON.parse(await readFile(file, "utf8"));
			await writeFile(file, JSON.stringify({ ...versions, sdk: "0.2.0", tools: "0.3.0-alpha.2" }));
		});
		await release(["--publish"]);
		expect(registry.package("@bilibili-notify/extension").tags.latest).toBe("0.2.0");
		expect(registry.package("@bilibili-notify/extension").tags.alpha).toBeUndefined();
		expect(registry.package("create-bn-ext").tags.alpha).toBe("0.3.0-alpha.2");
		expect(registry.package("create-bn-ext").tags.latest).toBeUndefined();
	}, 60_000);
	it.each(["schema", "empty", "duplicate"])(
		"不接受%s损坏的候选清单",
		async (kind) => {
			const file = join(directory, "packages.json");
			const metadata = JSON.parse(await readFile(file, "utf8"));
			if (kind === "schema") metadata.schemaVersion = 99;
			if (kind === "empty") metadata.packages = [];
			if (kind === "duplicate") metadata.packages.push(metadata.packages[0]);
			await writeFile(file, JSON.stringify(metadata));
			await expect(release(["--publish"])).rejects.toThrow(/catalog/);
			expect(registry.state.requests.map((entry) => entry.path)).toEqual([]);
		},
		60_000,
	);
	it.each(["private", "internal", "workspace", "entry"])(
		"真实归档%s损坏时，即使摘要正确也不得发布",
		async (kind) => {
			await rewritePackage("@bilibili-notify/extension", async (manifest, path) => {
				if (kind === "private") manifest.private = true;
				if (kind === "internal") manifest.dependencies["@bilibili-notify/internal"] = "0.0.0-dev";
				if (kind === "workspace") manifest.dependencies.zod = "workspace:*";
				if (kind === "entry") await rm(join(path, "index.mjs"));
			});
			await expect(release(["--package", "sdk", "--publish"])).rejects.toThrow(/public|incomplete/);
			expect(registry.state.requests.map((entry) => entry.path)).toEqual([]);
		},
		60_000,
	);
	it("不把开发占位版本当作SDK发行号", async () => {
		await rewritePackage("@bilibili-notify/extension", (manifest) => {
			manifest.version = "0.0.0-dev";
		});
		await expect(release(["--package", "sdk", "--publish"])).rejects.toThrow(/release version/);
		expect(registry.state.requests.map((entry) => entry.path)).toEqual([]);
	}, 60_000);
	it.each([
		"http://example.invalid/",
		"https://fixture:fixture@example.invalid/",
		"https://example.invalid/?x=1",
	])(
		"发行registry %s不合规时预检也拒绝",
		async (url) => {
			await expect(release(["--registry", url])).rejects.toThrow(/Registry/);
			expect(registry.state.requests).toEqual([]);
		},
		60_000,
	);
	it("Actions只允许dev手动运行，沿全量门禁和精确归档发布，首发凭据只进发布步骤", async () => {
		const workflow = parseYaml(
			await readFile(join(REPO, ".github/workflows/tooling-release.yml"), "utf8"),
		);
		expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
		expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({
			type: "boolean",
			default: true,
		});
		expect(workflow.on.workflow_dispatch.inputs.package.options).toEqual([
			"both",
			"sdk",
			"creator",
		]);
		expect(workflow.on.workflow_dispatch.inputs.auth).toMatchObject({
			default: "trusted",
			options: ["trusted", "bootstrap-token"],
		});
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.gate.uses).toBe("./.github/workflows/gate.yml");
		expect(workflow.jobs.gate.if).toContain("github.ref == 'refs/heads/dev'");
		expect(workflow.jobs.build.needs).toEqual(["gate"]);
		expect(workflow.jobs.publish.needs).toEqual(["build"]);
		expect(workflow.jobs.publish.if).toContain("!inputs.dry_run");
		expect(workflow.jobs.publish.if).toContain("github.ref == 'refs/heads/dev'");
		expect(workflow.jobs.publish.permissions).toEqual({ contents: "read", "id-token": "write" });
		expect(workflow.jobs.publish.concurrency).toEqual({
			group: "bn-tooling-npm-publish",
			"cancel-in-progress": false,
		});
		const upload = workflow.jobs.build.steps.find((step) =>
			step.uses?.startsWith("actions/upload-artifact@"),
		);
		const download = workflow.jobs.publish.steps.find((step) =>
			step.uses?.startsWith("actions/download-artifact@"),
		);
		expect(upload.with["if-no-files-found"]).toBe("error");
		expect(download.with.name).toBe(upload.with.name);
		expect(workflow.jobs.build.steps.some((step) => step.env?.NODE_AUTH_TOKEN)).toBe(false);
		const verify = workflow.jobs.build.steps.find((step) => step.id === "verify");
		const publish = workflow.jobs.publish.steps.find((step) => step.id === "publish");
		expect(publish.env.NODE_AUTH_TOKEN).toContain("inputs.auth == 'bootstrap-token'");
		expect(publish.env.NODE_AUTH_TOKEN).toContain("secrets.NPM_TOKEN");
		const temporary = await mkdtemp(join(root, "runner-"));
		const workflowEnv = {
			...env,
			PACKAGE_DIRECTORY: directory,
			NPM_REGISTRY: registry.endpoint,
			RELEASE_PACKAGE: "both",
			RELEASE_AUTH: "bootstrap-token",
			NODE_AUTH_TOKEN: "local-fixture-token",
			RUNNER_TEMP: temporary,
		};
		await exec("bash", ["-e", "-o", "pipefail", "-c", verify.run], {
			cwd: REPO,
			env: workflowEnv,
			timeout: 60_000,
		});
		expect(
			registry.state.requests.filter((entry) => entry.method !== "GET").map((entry) => entry.path),
		).toEqual([]);
		await expect(
			exec("bash", ["-e", "-o", "pipefail", "-c", publish.run], {
				cwd: REPO,
				env: { ...workflowEnv, NODE_AUTH_TOKEN: "" },
				timeout: 60_000,
			}),
		).rejects.toThrow(/NPM_TOKEN/);
		expect(
			registry.state.requests.filter((entry) => entry.method !== "GET").map((entry) => entry.path),
		).toEqual([]);
		const { stdout, stderr } = await exec("bash", ["-e", "-o", "pipefail", "-c", publish.run], {
			cwd: REPO,
			env: workflowEnv,
			timeout: 60_000,
		});
		expect(stdout + stderr).not.toContain("local-fixture-token");
		expect(await readdir(temporary)).toEqual([]);
		for (const name of ["@bilibili-notify/extension", "create-bn-ext"])
			expect(registry.package(name).tags.alpha).toBe("0.1.0-alpha.0");
	}, 60_000);
});
