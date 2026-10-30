import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningHealthDetailsResponse } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import serverPkg from "../../../package.json" with { type: "json" };
import type { ExtensionEntry } from "../../extensions/loader.js";
import { createProblemTable } from "../../problems/problem-table.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { makeIntegration, makeLogger, makeSource } from "../../subscriptions/__tests__/fixtures.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import { createHealthRoute, MODULE_VERSIONS, resolveAppVersion } from "../health.js";
import type { RouteDeps } from "../types.js";

const serverPkgVersion = serverPkg.version;

describe("resolveAppVersion", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bn-health-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writePkg(name: string, content: string): string {
		const p = join(dir, name);
		writeFileSync(p, content);
		return p;
	}

	it("读取 package.json 的 version 字段(prerelease)", () => {
		const p = writePkg("package.json", JSON.stringify({ name: "x", version: "0.1.0-alpha.3" }));
		expect(resolveAppVersion(p)).toBe("0.1.0-alpha.3");
	});

	it("读取纯 semver 版本", () => {
		const p = writePkg("package.json", JSON.stringify({ version: "1.2.3" }));
		expect(resolveAppVersion(p)).toBe("1.2.3");
	});

	it("文件不存在时回退 dev", () => {
		expect(resolveAppVersion(join(dir, "missing.json"))).toBe("dev");
	});

	it("JSON 损坏时回退 dev", () => {
		const p = writePkg("package.json", "{ not valid json");
		expect(resolveAppVersion(p)).toBe("dev");
	});

	it("version 缺失或空串时回退 dev", () => {
		expect(resolveAppVersion(writePkg("a.json", JSON.stringify({ name: "x" })))).toBe("dev");
		expect(resolveAppVersion(writePkg("b.json", JSON.stringify({ version: "" })))).toBe("dev");
	});

	/**
	 * 版本号必须是**当前跑的这份载荷**的版本,不是进程恰好待在哪个目录。
	 *
	 * 在线升级后 cwd 仍是容器的 /app(镜像自带那份),而新载荷跑在
	 * /data/versions/<新版>/ 下 —— 照 cwd 读就会一直报旧版本号,用户升完看仪表盘
	 * 纹丝不动,只会以为升级压根没成。NapCat 那个恒显 0.0.0 就是这个形态。
	 */
	it("不传参时按模块自己的位置找,而不是进程的 cwd", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9-from-cwd" }));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		try {
			expect(resolveAppVersion()).not.toBe("9.9.9-from-cwd");
			// apps/server/package.json —— 源码形态下模块往上找到的就是它。
			expect(resolveAppVersion()).toBe(serverPkgVersion);
		} finally {
			cwdSpy.mockRestore();
		}
	});
});

/**
 * 刻画测试:MODULE_VERSIONS 与各核心包 package.json#version 逐一相等。
 * 钉的是「版本来源」这个行为不变量,与解析**机制**解耦 —— 机制从 createRequire
 * 运行时解析切到构建期静态 JSON import(单文件 bundle 后旁边没有 node_modules
 * 可解析,createRequire 全部落空 → 版本全显 0.0.0)时,本测试必须保绿。
 */
describe("MODULE_VERSIONS — 与 workspace 核心包版本一致", () => {
	const require_ = createRequire(import.meta.url);
	const ids = ["storage", "subscription", "push", "image", "ai"] as const;

	it("恰好是这五个包(B 站那三个包不再是独立的包,没有版本可报)", () => {
		expect(Object.keys(MODULE_VERSIONS).sort()).toEqual([...ids].sort());
	});

	it("每个核心包版本逐一相等,且无 0.0.0 降级", () => {
		for (const id of ids) {
			const pkg = require_(`@bilibili-notify/${id}/package.json`) as { version: string };
			expect(MODULE_VERSIONS[id], `模块 ${id}`).toBe(pkg.version);
			expect(MODULE_VERSIONS[id], `模块 ${id} 不应是降级值`).not.toBe("0.0.0");
		}
	});
});

/**
 * 短版 `/api/health` 线上只有四格(ADR-0025 决策 12):存活探测(`status`)、应用内更新认新进程
 * (`version`、`startedAt`)、`uptime`。各模块开没开与核心包版本住详情口。
 * 恒为 null 的格子不许回来 —— 面板读到 null 分不清「没有」和「坏了」。
 */
describe("GET /api/health — 回应的格子", () => {
	it("恰好是契约里那四格", async () => {
		const app = createHealthRoute({ runtime: { pipeline: null } } as unknown as RouteDeps);
		const body = (await (await app.request("/")).json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["startedAt", "status", "uptime", "version"]);
	});
});

describe("GET /api/health/details — 回应的格子", () => {
	const meta = { exists: true, lastUpdatedAt: "2026-10-28T00:00:00.000Z" };
	function detailsApp(
		pipeline: unknown,
		scopeMeta: { exists: boolean; lastUpdatedAt: string | null } = meta,
		runtimeOverrides: Partial<RouteDeps["runtime"]> = {},
		storeOverrides: Partial<RouteDeps["store"]> = {},
	) {
		const store = {
			getSubscriptions: () => [
				{ id: "s1", identity: { sourceKey: "demo", externalId: "1" } },
				{ id: "s2", identity: { sourceKey: "demo", externalId: "2" } },
			],
			getTargets: () => [{ id: "t1" }],
			getConnections: () => [],
			getGlobalsMeta: () => scopeMeta,
			getSubscriptionsMeta: () => scopeMeta,
			getTargetsMeta: () => scopeMeta,
			...storeOverrides,
		};
		return createHealthRoute({
			runtime: {
				pipeline,
				sourceRegistry: createSourceRegistry(),
				adapterRegistry: createPlatformAdapterRegistry(),
				problems: createProblemTable({ logger: makeLogger() }),
				serviceCtx: { logger: makeLogger() },
				subscriptionStateStore: { get: () => undefined },
				...runtimeOverrides,
			},
			store,
		} as unknown as RouteDeps);
	}

	it("核心固定五格;图片与AI的false只表达未就绪,没有落盘的默认配置仍可运行", async () => {
		const app = detailsApp(
			{ getModuleState: () => ({ dynamic: true, live: false, image: false, ai: false }) },
			{ exists: false, lastUpdatedAt: null },
		);
		const body = (await (await app.request("/details")).json()) as RunningHealthDetailsResponse;
		expect(body.core).toEqual({
			problemCount: 0,
			items: [
				{ key: "storage", status: "running", light: "green", version: MODULE_VERSIONS.storage },
				{
					key: "subscription",
					status: "running",
					light: "green",
					version: MODULE_VERSIONS.subscription,
					count: 2,
				},
				{ key: "push", status: "running", light: "green", version: MODULE_VERSIONS.push, count: 1 },
				{ key: "image", status: "not-ready", light: "gray", version: MODULE_VERSIONS.image },
				{ key: "ai", status: "not-ready", light: "gray", version: MODULE_VERSIONS.ai },
			],
		});
	});

	it("多口拓展合一格,坏连接仍占格;问题只按reporter计一次,core不分摊,未知reporter仍在总数", async () => {
		const sourceRegistry = createSourceRegistry();
		await sourceRegistry.register("dual", makeSource(), makeIntegration() as never);
		const problems = createProblemTable({ logger: makeLogger() });
		problems.report({ reporter: "core", code: "settings_invalid", message: "core issue" });
		problems.report({
			reporter: "dual",
			about: { subscriptionId: "s1" },
			code: "fetch_failed",
			message: "same text",
		});
		problems.report({
			reporter: "dual",
			about: { connectionId: "c1" },
			code: "fetch_failed",
			message: "same text",
		});
		problems.report({ reporter: "gone", code: "fetch_failed", message: "orphan" });
		const descriptor = { label: "Push", shortLabel: "P", color: "#112233" };
		const entries: ExtensionEntry[] = [
			{
				id: "dual",
				state: "running",
				dir: "/unused/dual",
				manifest: {
					id: "dual",
					name: "Dual",
					contributes: {
						subscription: { label: "Source", supportedFeatures: ["post"] },
						push: descriptor,
					},
				} as never,
			},
			{
				id: "empty",
				state: "disabled",
				dir: "/unused/empty",
				manifest: { id: "empty", name: "Empty", contributes: { push: descriptor } } as never,
			},
			{
				id: "bad",
				state: "settings-invalid",
				dir: "/unused/bad",
				detail: "invalid settings",
				manifest: { id: "bad", name: "Bad", contributes: { push: descriptor } } as never,
			},
		];
		const app = createHealthRoute(
			{
				runtime: {
					sourceRegistry,
					adapterRegistry: createPlatformAdapterRegistry(),
					problems,
					pipeline: null,
					serviceCtx: { logger: makeLogger() },
					subscriptionStateStore: { get: () => undefined },
				},
				store: {
					getSubscriptions: () => [],
					getTargets: () => [],
					getConnections: () => [
						{ id: "c1", adapterKey: "dual" },
						{ id: "c2", adapterKey: "bad", settings: {} },
					],
					getGlobalsMeta: () => meta,
					getSubscriptionsMeta: () => meta,
					getTargetsMeta: () => meta,
				},
			} as unknown as RouteDeps,
			{ extensions: () => entries },
		);
		try {
			const body = (await (await app.request("/details")).json()) as RunningHealthDetailsResponse;
			expect(body.problemCount).toBe(4);
			expect(body.core.problemCount).toBe(1);
			expect(body.core.items.every((item) => !("problemCount" in item))).toBe(true);
			expect(body.integrations).toHaveLength(2);
			expect(body.integrations[0]?.descriptor).toMatchObject({
				label: "Dual",
				shortLabel: "P",
				color: "#112233",
			});
			expect(body.integrations[0]).toMatchObject({
				key: "dual",
				kind: "extension",
				provides: ["push", "subscription"],
				sourceKey: "dual",
				adapterKey: "dual",
				status: "running",
				light: "orange",
				problemCount: 2,
				connectionCount: 1,
			});
			expect(body.integrations[1]).toMatchObject({
				key: "bad",
				status: "settings-invalid",
				light: "red",
				connectionCount: 1,
				failure: { code: "unavailable", message: "invalid settings" },
			});
		} finally {
			problems.dispose();
		}
	});

	it("内置来源保留启动失败;摘要读取抛错不改运行结论,没有摘要能力就不编摘要", async () => {
		const sourceRegistry = createSourceRegistry();
		const broken = makeSource();
		broken.start.mockImplementation(async () => {
			throw new Error("cannot start");
		});
		await expect(
			sourceRegistry.register("broken", broken, makeIntegration() as never),
		).rejects.toThrow("cannot start");
		const healthy = makeSource();
		healthy.health = () => {
			throw new Error("summary unavailable");
		};
		await sourceRegistry.register("healthy", healthy, makeIntegration() as never);
		await sourceRegistry.register("bare", makeSource(), makeIntegration() as never);
		const body = (await (
			await detailsApp(null, meta, { sourceRegistry }).request("/details")
		).json()) as RunningHealthDetailsResponse;
		expect(body.integrations).toHaveLength(3);
		expect(body.integrations[0]).toMatchObject({
			key: "broken",
			kind: "builtin-source",
			status: "failed",
			light: "red",
			failure: { code: "unavailable", message: "cannot start" },
		});
		expect(body.integrations[1]).toMatchObject({
			key: "healthy",
			status: "running",
			light: "green",
			health: { ok: false, code: "unavailable" },
		});
		expect(body.integrations[2]).not.toHaveProperty("health");
	});

	it("内置适配器有配置连接才占格,描述每次现取", async () => {
		const adapterRegistry = createPlatformAdapterRegistry();
		let label = "Initial";
		for (const adapterKey of ["configured", "empty"])
			await adapterRegistry.register(
				{
					adapterKey,
					descriptor: () => ({ label, shortLabel: "A", color: "#123456", settingsFields: [] }),
					start: async () => {},
					stop: async () => {},
				} as never,
				makeIntegration() as never,
			);
		const app = detailsApp(
			null,
			meta,
			{ adapterRegistry },
			{ getConnections: () => [{ id: "c1", adapterKey: "configured", settings: {} }] as never },
		);
		label = "Current";
		const body = (await (await app.request("/details")).json()) as RunningHealthDetailsResponse;
		expect(body.integrations).toEqual([
			{
				key: "configured",
				kind: "builtin-adapter",
				descriptor: { label: "Current", shortLabel: "A", color: "#123456" },
				provides: ["push"],
				adapterKey: "configured",
				status: "running",
				light: "green",
				problemCount: 0,
				connectionCount: 1,
			},
		]);
	});

	it("同身份遗留组由服务端计算,不同来源相同外部id不合组,只返回订阅id与已有名字", async () => {
		const subscriptions = [
			{ id: "a", identity: { sourceKey: "one", externalId: "42" } },
			{ id: "b", identity: { sourceKey: "two", externalId: "42" } },
			{ id: "c", identity: { sourceKey: "one", externalId: "42" } },
		];
		const app = detailsApp(
			null,
			meta,
			{
				subscriptionStateStore: {
					get: (id: string) => (id === "c" ? { cachedProfile: { name: "Cached" } } : undefined),
				} as never,
			},
			{ getSubscriptions: () => subscriptions as never },
		);
		const body = (await (await app.request("/details")).json()) as RunningHealthDetailsResponse;
		expect(body.identityDuplicates).toEqual([
			{
				identity: { sourceKey: "one", externalId: "42" },
				subscriptionIds: ["a", "c"],
				name: "Cached",
			},
		]);
		expect(subscriptions.map((sub) => sub.id)).toEqual(["a", "b", "c"]);
	});

	it.each([
		["running", "green"],
		["disabled", "gray"],
		["staged", "gray"],
		["failed", "red"],
		["blocked", "red"],
		["incompatible", "red"],
		["unreadable", "red"],
		["settings-invalid", "red"],
	] as const)("拓展%s原样下发并映射%s灯;读不出清单时仍保留身份", async (status, light) => {
		const sourceRegistry = createSourceRegistry();
		const app = createHealthRoute(
			{
				runtime: {
					sourceRegistry,
					adapterRegistry: createPlatformAdapterRegistry(),
					pipeline: null,
					problems: { list: () => [] },
					serviceCtx: { logger: makeLogger() },
					subscriptionStateStore: { get: () => undefined },
				},
				store: {
					getSubscriptions: () => [],
					getTargets: () => [],
					getConnections: () => [],
					getGlobalsMeta: () => meta,
					getSubscriptionsMeta: () => meta,
					getTargetsMeta: () => meta,
				},
			} as unknown as RouteDeps,
			{
				extensions: () => [
					{
						id: "unknown-ports",
						state: status,
						dir: "/unused",
						identity: { id: "unknown-ports", name: "Retained" } as never,
					},
				],
			},
		);
		const body = (await (await app.request("/details")).json()) as RunningHealthDetailsResponse;
		expect(body.integrations).toMatchObject([
			{ key: "unknown-ports", descriptor: { label: "Retained" }, status, light },
		]);
		expect(body.integrations[0]).not.toHaveProperty("provides");
	});

	it("恰好是契约里那几格:各模块开没开、核心包版本、配置分区;短版的四格不重复带", async () => {
		const modules = { dynamic: true, live: false, image: true, ai: false };
		const app = detailsApp({ getModuleState: () => modules });
		const body = (await (await app.request("/details")).json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual([
			"configScopes",
			"core",
			"identityDuplicates",
			"integrations",
			"moduleVersions",
			"modules",
			"phase",
			"problemCount",
		]);
		expect(body.phase).toBe("running");
		expect(body.modules).toEqual(modules);
		expect(body.moduleVersions).toEqual(MODULE_VERSIONS);
		expect(body.configScopes).toEqual({
			globals: meta,
			subscriptions: { ...meta, count: 2 },
			targets: { ...meta, count: 1 },
		});
	});

	it("推送链路还没挂上:四个模块都是 false", async () => {
		const body = (await (await detailsApp(null).request("/details")).json()) as {
			modules: unknown;
		};
		expect(body.modules).toEqual({ dynamic: false, live: false, image: false, ai: false });
	});
});
