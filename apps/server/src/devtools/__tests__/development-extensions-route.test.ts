import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import type {
	DevelopmentDirectoriesResponse,
	DevelopmentExtensionsResponse,
	ErrorResponse,
} from "@bilibili-notify/contract";
import type { ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { fixedTimezone, inertTransitImages } from "../../__tests__/support/integration-io.js";
import { memoryIntegrationStore } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { BUILTIN_INTEGRATION_KEYS } from "../../compose.js";
import { loadExtensions } from "../../extensions/loader.js";
import { createExtensionMounts } from "../../extensions/mount.js";
import { createExtensionUpgrades } from "../../extensions/upgrade.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createDevEntryAttacher } from "../dev-entry.js";
import { createDevelopmentExtensions } from "../development-extensions.js";
import { createDevtoolsProviderRegistry } from "../providers.js";
import { createDevRegistry } from "../registry.js";
import { createDevRoute } from "../route.js";

describe("开发拓展挂载请求", () => {
	let root: string;
	let loaded: Awaited<ReturnType<typeof loadExtensions>>;
	let development: ReturnType<typeof createDevelopmentExtensions>;
	let app: ReturnType<typeof createDevRoute>;
	let enabled: boolean;
	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "bn-development-extensions-")));
		enabled = true;
		const providers = createDevtoolsProviderRegistry([]);
		const attachDevtools = createDevEntryAttacher({
			providers,
			address: () => undefined,
			sourceEntry: (directory) => development?.devtoolsEntry(directory),
		});
		const host: ServiceContext = {
			logger: silentLogger,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose() {},
			signal: new AbortController().signal,
			track() {},
		};
		loaded = await loadExtensions({
			attachDevtools,
			developmentEntry: (directory) =>
				development?.resolveEntry(directory) ?? Promise.resolve(undefined),
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			timezoneReader: fixedTimezone("Asia/Shanghai"),
			transitImages: inertTransitImages,
			locale: fixedLocale(),
			root: join(root, "installed"),
			isEnabled: () => enabled,
			maxFailures: 3,
			host,
			loggerOf: () => silentLogger,
			integrationStore: memoryIntegrationStore(),
			problems: ignoredProblems,
			mounts: createExtensionMounts({ logger: silentLogger }),
			adapters: createPlatformAdapterRegistry(),
			connections: () => [],
			onConnectionsChanged: () => ({ dispose() {} }),
			settings: () => undefined,
			onSettingsChanged: () => ({ dispose() {} }),
			inbound: {},
			upgrades: createExtensionUpgrades(),
		});
		development = createDevelopmentExtensions({
			root: join(root, "installed"),
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			extensions: () => loaded,
		});
		app = createDevRoute({
			registry: createDevRegistry(providers),
			developmentExtensions: development,
		});
	});

	afterEach(async () => {
		await development?.dispose();
		await loaded?.dispose();
		await rm(root, { recursive: true, force: true });
	});

	it("浏览宿主目录只列文件夹，默认从工作区起步且不挂载", async () => {
		await mkdir(join(root, "a-project"));
		await mkdir(join(root, "z-project"));
		await writeFile(join(root, "notes.txt"), "not a directory");
		await writeFile(join(root, "extension.json"), "{}");
		const response = await app.request("/directories");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			directory: root,
			parent: join(root, ".."),
			hasManifest: true,
			entries: [
				{ name: "a-project", path: join(root, "a-project") },
				{ name: "z-project", path: join(root, "z-project") },
			],
		});
		expect(await (await app.request("/extensions")).json()).toEqual({ mounts: [] });
	});

	it("目录软链可选择，进入后回真实路径，并可返回上一级", async () => {
		const target = join(root, "source");
		const alias = join(root, "source-link");
		await mkdir(target);
		await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
		await symlink(join(root, "missing"), join(root, "broken-link"));
		const listing = (await (
			await app.request("/directories")
		).json()) as DevelopmentDirectoriesResponse;
		expect(listing.entries).toContainEqual({ name: "source-link", path: alias });
		expect(listing.entries).not.toContainEqual(expect.objectContaining({ name: "broken-link" }));
		const opened = await app.request(`/directories?path=${encodeURIComponent(alias)}`);
		expect(opened.status).toBe(200);
		expect(await opened.json()).toEqual({
			directory: target,
			parent: root,
			hasManifest: false,
			entries: [],
		});
		const up = await app.request(`/directories?path=${encodeURIComponent(dirname(target))}`);
		expect(await up.json()).toMatchObject({ directory: root });
		const driveRoot = parse(root).root;
		const top = await app.request(`/directories?path=${encodeURIComponent(driveRoot)}`);
		expect(await top.json()).toMatchObject({ parent: null });
	});

	it.each([
		["relative", 400, "invalid"],
		["missing", 404, "not_found"],
		["file", 400, "invalid"],
	] as const)("浏览失败如实返回标准错误：%s", async (kind, status, code) => {
		await writeFile(join(root, "plain-file"), "not a folder");
		const path =
			kind === "relative"
				? "relative/source"
				: join(root, kind === "file" ? "plain-file" : "missing");
		const response = await app.request(`/directories?path=${encodeURIComponent(path)}`);
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ code, message: expect.any(String) });
		expect(await (await app.request("/extensions")).json()).toEqual({ mounts: [] });
	});

	async function project(id: string): Promise<string> {
		const dir = join(root, "outside", id);
		await mkdir(join(dir, "src"), { recursive: true });
		const manifest = JSON.stringify({
			id,
			name: id,
			description: "Development fixture",
			version: "0.1.0",
			apiVersion: 1,
			contributes: { push: { label: "Test", shortLabel: "T", color: "#000000" } },
		});
		await writeFile(join(dir, "extension.json"), manifest);
		await writeFile(join(dir, "src/index.ts"), code("one"));
		return dir;
	}
	function code(value: string) {
		return `export function activate(ctx) { ctx.publishView(() => ({ summary: { text: [${JSON.stringify(value)}] } })); }\n`;
	}
	it("没有dist的TypeScript工程由BN直接加载，未启用时不运行activate", async () => {
		const directory = await project("example.source");
		await rm(join(directory, "dist"), { recursive: true, force: true });
		await mkdir(join(directory, "src"), { recursive: true });
		await writeFile(
			join(directory, "src/index.ts"),
			'const value: string = "source"; export function activate(ctx: {publishView(fn: () => unknown): void}) { ctx.publishView(() => ({summary: {text: [value]}})); }',
		);
		enabled = false;
		expect((await mount(directory, true)).status).toBe(200);
		expect(loaded.list()[0]?.state).toBe("disabled");
		enabled = true;
		await loaded.sync();
		expect(loaded.status("example.source")).toMatchObject({ summary: { text: ["source"] } });
		await expect(access(join(directory, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("只改源码子依赖也会热更新，不需要拓展构建或独立启动", async () => {
		const directory = await project("example.helper");
		await rm(join(directory, "dist"), { recursive: true, force: true });
		await mkdir(join(directory, "src"), { recursive: true });
		await writeFile(join(directory, "src/message.ts"), 'export const message: string = "one";');
		await writeFile(
			join(directory, "src/index.ts"),
			'import {message} from "./message.js"; export function activate(ctx: {publishView(fn: () => unknown): void}) { ctx.publishView(() => ({summary: {text: [message]}})); }',
		);
		expect((await mount(directory, true)).status).toBe(200);
		await writeFile(join(directory, "src/message.ts"), 'export const message: string = "two";');
		await vi.waitFor(
			() => expect(loaded.status("example.helper")).toMatchObject({ summary: { text: ["two"] } }),
			{ timeout: 4000 },
		);
		await rm(join(directory, "src/message.ts"));
		await vi.waitFor(() => expect(development.list()[0]?.error).toBeTruthy(), { timeout: 4000 });
		expect(loaded.status("example.helper")).toMatchObject({ summary: { text: ["two"] } });
		await writeFile(join(directory, "src/message.ts"), 'export const message: string = "three";');
		await vi.waitFor(
			() => expect(loaded.status("example.helper")).toMatchObject({ summary: { text: ["three"] } }),
			{ timeout: 4000 },
		);
		await expect(access(join(directory, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("解除后再次挂载已启用工程会运行新代码，不留在等待替换状态", async () => {
		const directory = await project("example.remount");
		expect((await mount(directory)).status).toBe(200);
		expect((await app.request("/extensions/example.remount", { method: "DELETE" })).status).toBe(
			200,
		);
		await writeFile(join(directory, "src/index.ts"), code("two"));
		expect((await mount(directory)).status).toBe(200);
		expect(loaded.status("example.remount")).toMatchObject({ summary: { text: ["two"] } });
	});
	it("源码设置声明校验失败时保留旧实例，修正后恢复更新", async () => {
		const directory = await project("example.completed");
		expect((await mount(directory, true)).status).toBe(200);
		await writeFile(
			join(directory, "src/index.ts"),
			`export const settingsSchema = {};\n${code("two")}`,
		);
		await vi.waitFor(() => expect(development.list()[0]?.error).toBeTruthy(), { timeout: 4000 });
		expect(loaded.status("example.completed")).toMatchObject({ summary: { text: ["one"] } });
		await writeFile(join(directory, "src/index.ts"), code("two"));
		await vi.waitFor(
			() =>
				expect(loaded.status("example.completed")).toMatchObject({ summary: { text: ["two"] } }),
			{ timeout: 4000 },
		);
	});
	function mount(directory: string, watch = false) {
		return app.request("/extensions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ directory, watch }),
		});
	}

	it("手动指定仓外工程后直接加载源码，挂载列表交出真实目录", async () => {
		const directory = await project("example.one");
		const response = await app.request("/extensions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ directory, watch: false }),
		});
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({ id: "example.one" });
		expect(loaded.list().map((entry) => [entry.id, entry.state])).toEqual([
			["example.one", "running"],
		]);
		expect(await readlink(join(root, "installed/example.one"))).toBe(directory);
		expect(await (await app.request("/extensions")).json()).toMatchObject({
			mounts: [{ id: "example.one", directory, watching: false }],
		});
	});

	it("多个工程独立监听重载，解除一个不影响另一个，也不删除源码", async () => {
		const first = await project("example.one");
		const second = await project("example.two");
		expect((await mount(first, true)).status).toBe(200);
		expect((await mount(second, true)).status).toBe(200);
		await writeFile(join(first, "src/index.ts"), code("two"));
		await vi.waitFor(
			() => expect(loaded.status("example.one")).toMatchObject({ summary: { text: ["two"] } }),
			{ timeout: 4000 },
		);
		expect(loaded.status("example.two")).toMatchObject({ summary: { text: ["one"] } });
		const removed = await app.request("/extensions/example.one", { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect(loaded.list().map((entry) => entry.id)).toEqual(["example.two"]);
		expect(await realpath(join(first, "src"))).toBe(join(first, "src"));
	});

	it("同ID和已有安装均拒绝覆盖，解除也不能删除被替换的真实目录", async () => {
		const directory = await project("example.one");
		expect((await mount(directory)).status).toBe(200);
		expect((await mount(directory)).status).toBe(409);
		const at = join(root, "installed/example.one");
		await rm(at);
		await mkdir(at);
		await writeFile(join(at, "keep.txt"), "existing installation");
		expect((await mount(directory)).status).toBe(409);
		expect((await app.request("/extensions/example.one", { method: "DELETE" })).status).toBe(409);
		expect(await readFile(join(at, "keep.txt"), "utf8")).toBe("existing installation");
	});

	it("坏输入、清单不兼容和缺少源码均拒绝，不残留安装目录", async () => {
		expect((await mount("relative/path")).status).toBe(400);
		expect((await mount(join(root, "missing"))).status).toBe(400);
		const directory = await project("example.one");
		const path = join(directory, "extension.json");
		const manifest = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...manifest, apiVersion: 999 }));
		expect((await mount(directory)).status).toBe(400);
		await writeFile(path, JSON.stringify(manifest));
		await rm(join(directory, "src"), { recursive: true });
		const missing = await mount(directory);
		expect(missing.status).toBe(400);
		const failure = (await missing.json()) as ErrorResponse;
		expect(failure.message).not.toContain("上一份代码");
		expect(loaded.list()).toEqual([]);
		await expect(access(join(root, "installed/example.one"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("停用拓展时保存源码不自动启用，解除未管理的ID也不能删除文件", async () => {
		enabled = false;
		const directory = await project("example.one");
		expect((await mount(directory, true)).status).toBe(200);
		await writeFile(join(directory, "src/index.ts"), code("two"));
		await vi.waitFor(() => expect(development.list()[0]?.reloads).toBeGreaterThan(0), {
			timeout: 4000,
		});
		expect(loaded.list()).toMatchObject([{ id: "example.one", state: "disabled" }]);
		expect(loaded.status("example.one")).toBeUndefined();
		enabled = true;
		await loaded.sync();
		expect(loaded.status("example.one")).toMatchObject({ summary: { text: ["two"] } });
		expect((await app.request("/extensions/unknown", { method: "DELETE" })).status).toBe(404);
	});

	it("源码开发场景及其子依赖随拓展重载，解除挂载后场景撤下", async () => {
		const directory = await project("example.provider");
		const manifest = JSON.parse(await readFile(join(directory, "extension.json"), "utf8"));
		await writeFile(
			join(directory, "extension.json"),
			JSON.stringify({ ...manifest, contributes: { ...manifest.contributes, devtools: {} } }),
		);
		await mkdir(join(directory, "src/devtools"));
		await writeFile(
			join(directory, "src/devtools/message.ts"),
			'export const message: string = "first";',
		);
		await writeFile(
			join(directory, "src/devtools/index.ts"),
			`
import { message } from "./message.js";
export function devtools() {
  return { scenarios: [{ id: "inspect", group: "ext", title: "Inspect", params: [], run: () => ({ ok: true, summary: message }) }] };
}
`,
		);
		expect((await mount(directory, true)).status).toBe(200);
		const run = async () =>
			(await app.request("/run/example.provider.inspect", { method: "POST" })).json();
		expect(await run()).toMatchObject({ summary: "first" });
		await writeFile(
			join(directory, "src/devtools/message.ts"),
			'export const message: string = "second";',
		);
		await vi.waitFor(async () => expect(await run()).toMatchObject({ summary: "second" }), {
			timeout: 4000,
		});
		expect((await app.request("/extensions/example.provider", { method: "DELETE" })).status).toBe(
			200,
		);
		expect((await app.request("/run/example.provider.inspect", { method: "POST" })).status).toBe(
			404,
		);
	});

	it("源码语法错误不会停掉旧实例，修正后监听仍能恢复", async () => {
		const directory = await project("example.one");
		expect((await mount(directory, true)).status).toBe(200);
		await writeFile(join(directory, "src/index.ts"), "export !!! broken");
		await vi.waitFor(
			async () => {
				const response = (await (
					await app.request("/extensions")
				).json()) as DevelopmentExtensionsResponse;
				expect(response.mounts[0]?.error).toEqual(expect.any(String));
			},
			{ timeout: 4000 },
		);
		expect(loaded.status("example.one")).toMatchObject({ summary: { text: ["one"] } });
		await writeFile(join(directory, "src/index.ts"), code("recovered"));
		await vi.waitFor(
			() =>
				expect(loaded.status("example.one")).toMatchObject({ summary: { text: ["recovered"] } }),
			{ timeout: 4000 },
		);
	});
});
