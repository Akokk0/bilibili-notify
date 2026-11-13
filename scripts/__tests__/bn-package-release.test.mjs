import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { npmRegistryFixture } from "./helpers/npm-registry-fixture.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { parse: parseYaml } = createRequire(join(REPO, "apps/server/package.json"))("yaml");
const exec = promisify(execFile);
const sha = (bytes, algorithm = "sha256", encoding = "hex") =>
	createHash(algorithm).update(bytes).digest(encoding);

describe("BN npm发行命令", () => {
	let root;
	let registry;
	let scanClock;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "bn-npm-release-"));
		registry = await npmRegistryFixture();
		// 只加速发行进程的等待。npm 子进程与本机 registry 照常收发请求。
		scanClock = join(root, "scan-clock.mjs");
		await writeFile(
			scanClock,
			`
const realTimeout = globalThis.setTimeout;
let now = Date.now();
Date.now = () => now;
globalThis.setTimeout = (callback, delay, ...args) => {
  now += delay;
  return realTimeout(callback, 0, ...args);
};
`,
		);
		await writeFile(
			join(root, "npmrc"),
			`//${new URL(registry.endpoint).host}/:_authToken=local-fixture-token\n`,
		);
	});
	beforeEach(() => registry.reset());
	afterAll(async () => {
		if (registry) await registry.close();
		if (root) await rm(root, { recursive: true, force: true });
	});

	async function candidate(name, version = "1.0.0-alpha.1") {
		const directory = join(root, name);
		const cli = join(directory, "cli");
		await cp(join(REPO, "tools/bn-cli/lib"), cli, { recursive: true });
		const pkg = JSON.parse(await readFile(join(cli, "package.json"), "utf8"));
		pkg.version = version;
		await writeFile(join(cli, "package.json"), JSON.stringify(pkg));
		await mkdir(join(cli, "runtimes"));
		const runtimes = {};
		for (const profile of ["web", "dev"]) {
			const files = {
				"index.mjs": "export async function startServer() {}",
				"boot.mjs": "await import('./index.mjs');",
				"package.json": JSON.stringify({ type: "module", version }),
				"bn-runtime.json": JSON.stringify({ schemaVersion: 1, profile, version }),
				"web-dist/index.html": "<!doctype html><title>BN fixture</title>",
			};
			const archive = zipSync(
				Object.fromEntries(
					Object.entries(files).map(([file, contents]) => [
						file,
						new TextEncoder().encode(contents),
					]),
				),
			);
			runtimes[profile] = {
				version,
				file: `runtimes/${profile}.zip`,
				size: archive.length,
				sha256: sha(archive),
			};
			await writeFile(join(cli, runtimes[profile].file), archive);
		}
		await writeFile(join(cli, "runtime.json"), JSON.stringify({ schemaVersion: 1, runtimes }));
		const assembled = join(directory, "package");
		execFileSync(
			process.execPath,
			[
				join(REPO, "scripts/assemble-bn-package.mjs"),
				"--cli",
				cli,
				"--runtimes",
				cli,
				"--out",
				assembled,
			],
			{ cwd: REPO, stdio: "pipe" },
		);
		const file = `bilibili-notify-bn-${version}.tgz`;
		execFileSync("vp", ["pm", "pack", "--out", join(directory, file), "--json"], {
			cwd: assembled,
			stdio: "pipe",
		});
		const bytes = await readFile(join(directory, file));
		const meta = {
			name: "@bilibili-notify/bn",
			version,
			file,
			size: bytes.length,
			sha256: sha(bytes),
			integrity: `sha512-${sha(bytes, "sha512", "base64")}`,
		};
		await writeFile(join(directory, "package.json"), JSON.stringify(meta));
		return { directory, meta, bytes };
	}
	async function release(fixture, options = [], nodeArgs = []) {
		return exec(
			process.execPath,
			[
				...nodeArgs,
				join(REPO, "scripts/release-bn-package.mjs"),
				"--directory",
				fixture.directory,
				"--tag",
				`v${fixture.meta.version}`,
				"--registry",
				registry.endpoint,
				...options,
			],
			{
				cwd: REPO,
				timeout: 60_000,
				maxBuffer: 4 * 1024 * 1024,
				env: { ...process.env, NPM_CONFIG_USERCONFIG: join(root, "npmrc") },
			},
		);
	}
	async function repack(fixture) {
		execFileSync(
			"vp",
			["pm", "pack", "--out", join(fixture.directory, fixture.meta.file), "--json"],
			{ cwd: join(fixture.directory, "package"), stdio: "pipe" },
		);
		fixture.bytes = await readFile(join(fixture.directory, fixture.meta.file));
		Object.assign(fixture.meta, {
			size: fixture.bytes.length,
			sha256: sha(fixture.bytes),
			integrity: `sha512-${sha(fixture.bytes, "sha512", "base64")}`,
		});
		await writeFile(join(fixture.directory, "package.json"), JSON.stringify(fixture.meta));
	}
	it("dry-run核对实际tgz与双宿主，不向registry写入", async () => {
		const fixture = await candidate("dry-run");
		const { stdout } = await release(fixture, ["--dry-run"]);
		expect(JSON.parse(stdout.trim().split("\n").at(-1))).toMatchObject({
			dryRun: true,
			name: "@bilibili-notify/bn",
			version: "1.0.0-alpha.1",
			channel: "alpha",
		});
		expect(registry.state.requests.filter((item) => item.method !== "GET")).toEqual([]);
	}, 30_000);
	it("tag不一致或tgz被改动时，在任何registry请求之前拒绝", async () => {
		const fixture = await candidate("invalid-local");
		await expect(release(fixture, ["--publish", "--tag", "v9.0.0"])).rejects.toThrow(
			/must match the app tag/,
		);
		await expect(release(fixture, ["--publish", "--tag", "v1.0.0-alpha.01"])).rejects.toThrow(
			/not valid/,
		);
		await writeFile(join(fixture.directory, fixture.meta.file), Buffer.from("damaged tgz"));
		await expect(release(fixture, ["--publish"])).rejects.toThrow(/integrity mismatch/);
		expect(registry.state.requests).toEqual([]);
	}, 30_000);
	it.each(["missing", "profile", "version", "entry"])(
		"实际tgz的宿主%s错误，即使外层摘要正确也不得发布",
		async (kind) => {
			const fixture = await candidate(`runtime-${kind}`);
			const directory = join(fixture.directory, "package");
			const runtime = join(directory, "runtimes/dev.zip");
			if (kind === "missing") await rm(runtime);
			else {
				const files = unzipSync(await readFile(runtime));
				const marker = JSON.parse(new TextDecoder().decode(files["bn-runtime.json"]));
				if (kind === "entry") delete files["boot.mjs"];
				else if (kind === "profile") marker.profile = "web";
				else marker.version = "9.0.0";
				files["bn-runtime.json"] = new TextEncoder().encode(JSON.stringify(marker));
				const bytes = zipSync(files);
				await writeFile(runtime, bytes);
				const catalog = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
				catalog.runtimes.dev.sha256 = sha(bytes);
				catalog.runtimes.dev.size = bytes.length;
				await writeFile(join(directory, "runtime.json"), JSON.stringify(catalog));
			}
			await repack(fixture);
			await expect(release(fixture, ["--publish"])).rejects.toThrow(
				["missing", "entry"].includes(kind) ? /incomplete/ : /profile or version mismatch/,
			);
			expect(registry.state.requests).toEqual([]);
		},
		30_000,
	);
	it("先公开版本包，再晋升alpha；传输字节与待发布tgz相同", async () => {
		const fixture = await candidate("alpha");
		await release(fixture, ["--publish"]);
		expect(registry.state.versions["1.0.0-alpha.1"].dist.integrity).toBe(fixture.meta.integrity);
		expect(registry.state.tags.alpha).toBe("1.0.0-alpha.1");
		expect(registry.state.tags.latest).toBeUndefined();
		const writes = registry.state.requests.filter((item) => item.method !== "GET");
		expect(writes.map((item) => item.path)).toEqual([
			"/@bilibili-notify/bn",
			"/-/package/@bilibili-notify/bn/dist-tags/alpha",
		]);
		const sent = Object.values(JSON.parse(writes[0].body)._attachments)[0];
		expect(Buffer.from(sent.data, "base64")).toEqual(fixture.bytes);
	}, 30_000);
	it("同版本重跑核对内容，一致不重复写；内容冲突拒绝覆盖", async () => {
		const fixture = await candidate("rerun");
		await release(fixture, ["--publish"]);
		const writes = registry.state.requests.filter((item) => item.method !== "GET").length;
		await release(fixture, ["--publish"]);
		expect(registry.state.requests.filter((item) => item.method !== "GET")).toHaveLength(writes);
		registry.state.versions["1.0.0-alpha.1"].dist.integrity = "sha512-conflicting-content";
		await expect(release(fixture, ["--publish"])).rejects.toThrow(/differs/);
		expect(registry.state.requests.filter((item) => item.method !== "GET")).toHaveLength(writes);
	}, 30_000);
	it.each([
		["1.0.0", "2.0.0", "latest"],
		["1.0.0-alpha.9", "1.0.0-alpha.10", "alpha"],
	])(
		"旧tag %s可补齐版本，但不回退%s所在的%s渠道",
		async (version, newer, channel) => {
			const fixture = await candidate(`older-${channel}`, version);
			registry.state.versions[newer] = {
				name: "@bilibili-notify/bn",
				version: newer,
				dist: { integrity: "existing-newer-content" },
			};
			registry.state.tags[channel] = newer;
			await release(fixture, ["--publish"]);
			expect(registry.state.versions[version].dist.integrity).toBe(fixture.meta.integrity);
			expect(registry.state.tags[channel]).toBe(newer);
			expect(
				registry.state.requests.filter((item) => item.method !== "GET").map((item) => item.path),
			).toEqual(["/@bilibili-notify/bn"]);
		},
		30_000,
	);
	it("同步主程序tag版本时包含npm宿主包，SDK与拓展创建器的版本独立", async () => {
		const directory = join(root, "sync-version");
		const files = [
			"apps/server/package.json",
			"apps/web/package.json",
			"apps/desktop/package.json",
			"apps/desktop/src-tauri/tauri.conf.json",
			"apps/desktop/src-tauri/Cargo.toml",
			"apps/desktop/src-tauri/Cargo.lock",
			"tools/bn-cli/package.json",
			"packages/extension/package.json",
			"tools/create-extension/package.json",
		];
		for (const file of files) {
			await mkdir(dirname(join(directory, file)), { recursive: true });
			await cp(join(REPO, file), join(directory, file));
		}
		const sdk = await readFile(join(directory, "packages/extension/package.json"), "utf8");
		const creator = await readFile(join(directory, "tools/create-extension/package.json"), "utf8");
		await exec("bash", [join(REPO, ".github/scripts/shared/sync-app-version.sh")], {
			cwd: directory,
			env: { ...process.env, VERSION: "2.0.0-alpha.7" },
		});
		for (const file of [
			"apps/server/package.json",
			"apps/web/package.json",
			"apps/desktop/package.json",
			"tools/bn-cli/package.json",
		])
			expect(JSON.parse(await readFile(join(directory, file), "utf8")).version).toBe(
				"2.0.0-alpha.7",
			);
		expect(await readFile(join(directory, "packages/extension/package.json"), "utf8")).toBe(sdk);
		expect(await readFile(join(directory, "tools/create-extension/package.json"), "utf8")).toBe(
			creator,
		);
	}, 30_000);
	it("发布失败和晋升失败不会触碰原渠道，重跑只补缺失的一步", async () => {
		const fixture = await candidate("failure", "2.0.0");
		registry.state.versions["1.0.0"] = { version: "1.0.0", dist: { integrity: "old-content" } };
		registry.state.tags.latest = "1.0.0";
		registry.state.failure = (item) =>
			item.method === "PUT" && item.path === "/@bilibili-notify/bn";
		await expect(release(fixture, ["--publish"])).rejects.toThrow(/503/);
		expect(registry.state.versions["2.0.0"]).toBeUndefined();
		expect(registry.state.tags.latest).toBe("1.0.0");
		registry.state.failure = (item) => item.method === "PUT" && item.path.endsWith("/latest");
		await expect(release(fixture, ["--publish"])).rejects.toThrow(/503/);
		expect(registry.state.versions["2.0.0"].dist.integrity).toBe(fixture.meta.integrity);
		expect(registry.state.tags.latest).toBe("1.0.0");
		const uploads = registry.state.requests.filter(
			(item) => item.method === "PUT" && item.path === "/@bilibili-notify/bn",
		).length;
		expect(uploads).toBe(2);
		await release(fixture, ["--publish"]);
		expect(registry.state.tags.latest).toBe("2.0.0");
		expect(
			registry.state.requests.filter(
				(item) => item.method === "PUT" && item.path === "/@bilibili-notify/bn",
			),
		).toHaveLength(uploads);
	}, 30_000);
	it("npm接收上传后等待扫描结果，只上传一次并在摘要可见后更新渠道", async () => {
		const fixture = await candidate("scan");
		const { version } = fixture.meta;
		let readsAfterUpload = 0;
		registry.state.visibleVersions = (versions) => {
			if (versions[version] && ++readsAfterUpload <= 2) return {};
			return versions;
		};
		await release(fixture, ["--publish"], ["--import", scanClock]);
		expect(registry.state.tags.alpha).toBe(version);
		expect(
			registry.state.requests.filter((item) => item.method === "PUT").map((item) => item.path),
		).toEqual(["/@bilibili-notify/bn", "/-/package/@bilibili-notify/bn/dist-tags/alpha"]);
	}, 30_000);
	it("超过扫描等待时限仍未公开，保留原渠道且不重传", async () => {
		const fixture = await candidate("scan-failure");
		registry.state.visibleVersions = () => ({});
		await expect(release(fixture, ["--publish"], ["--import", scanClock])).rejects.toThrow(
			/still not visible/,
		);
		expect(
			registry.state.requests.filter(({ method }) => method === "PUT").map(({ path }) => path),
		).toEqual(["/@bilibili-notify/bn"]);
	}, 30_000);
	it("首次公开的摘要与候选不同，立即停止且不晋升", async () => {
		const fixture = await candidate("scan-mismatch");
		const { version } = fixture.meta;
		let publicReads = 0;
		registry.state.visibleVersions = (versions) => {
			if (!versions[version]) return versions;
			publicReads++;
			return { [version]: { dist: { integrity: "different-content" } } };
		};
		await expect(release(fixture, ["--publish"], ["--import", scanClock])).rejects.toThrow(
			/integrity could not be verified/,
		);
		expect(publicReads).toBe(1);
		expect(
			registry.state.requests.filter(({ method }) => method === "PUT").map(({ path }) => path),
		).toEqual(["/@bilibili-notify/bn"]);
	}, 30_000);
	it("registry已经保存包但响应失败时不自动重传，重跑复验后继续晋升", async () => {
		const fixture = await candidate("lost-response");
		registry.state.failAfterPublish = true;
		await expect(release(fixture, ["--publish"])).rejects.toThrow(/503/);
		expect(registry.state.versions["1.0.0-alpha.1"].dist.integrity).toBe(fixture.meta.integrity);
		expect(registry.state.tags.alpha).toBeUndefined();
		await release(fixture, ["--publish"]);
		expect(registry.state.tags.alpha).toBe("1.0.0-alpha.1");
		expect(
			registry.state.requests.filter(
				(item) => item.method === "PUT" && item.path === "/@bilibili-notify/bn",
			),
		).toHaveLength(1);
	}, 30_000);
	it("Actions沿主程序tag和门禁构建，只给tag发布作业OIDC权限；实际步骤可dry-run及发布", async () => {
		const workflow = parseYaml(
			await readFile(join(REPO, ".github/workflows/npm-release.yml"), "utf8"),
		);
		expect(workflow.on.push.tags).toEqual(["v*"]);
		expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({
			type: "boolean",
			default: true,
		});
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.gate.uses).toBe("./.github/workflows/gate.yml");
		expect(workflow.jobs.build.needs).toEqual(["gate"]);
		expect(workflow.jobs.publish.needs).toEqual(["build"]);
		expect(workflow.jobs.publish.if).toBe(
			"github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
		);
		expect(workflow.jobs.publish.permissions).toEqual({ contents: "read", "id-token": "write" });
		expect(workflow.jobs.build.permissions?.["id-token"]).toBeUndefined();
		expect(workflow.jobs.publish.concurrency).toEqual({
			group: "bn-npm-publish",
			"cancel-in-progress": false,
		});
		for (const job of [workflow.jobs.gate, workflow.jobs.build]) {
			expect(job.if).toContain("github.ref == 'refs/heads/dev'");
			expect(job.if).toContain("inputs.dry_run");
		}
		const steps = workflow.jobs.build.steps;
		expect(steps.find((step) => step.id === "build").run).toBe("vp run build:bn-package");
		expect(steps.find((step) => step.name === "Sync app version metadata").run).toBe(
			"bash .github/scripts/shared/sync-app-version.sh",
		);
		expect(
			steps.find((step) => step.uses?.startsWith("actions/upload-artifact@")).with[
				"if-no-files-found"
			],
		).toBe("error");
		const fixture = await candidate("workflow", "1.0.0");
		const env = {
			...process.env,
			TAG: "v1.0.0",
			PACKAGE_DIRECTORY: fixture.directory,
			NPM_REGISTRY: registry.endpoint,
			NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
		};
		const dryRun = steps.find((step) => step.id === "verify");
		await exec("bash", ["-e", "-o", "pipefail", "-c", dryRun.run], {
			cwd: REPO,
			env,
			timeout: 30_000,
		});
		expect(registry.state.requests.filter((item) => item.method !== "GET")).toEqual([]);
		const publish = workflow.jobs.publish.steps.find((step) => step.id === "publish");
		await exec("bash", ["-e", "-o", "pipefail", "-c", publish.run], {
			cwd: REPO,
			env,
			timeout: 30_000,
		});
		expect(registry.state.tags.latest).toBe("1.0.0");
		expect(registry.state.tags.alpha).toBeUndefined();
	}, 30_000);
});
