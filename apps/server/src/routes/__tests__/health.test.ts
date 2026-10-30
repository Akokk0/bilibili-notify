import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import serverPkg from "../../../package.json" with { type: "json" };
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
	function detailsApp(pipeline: unknown) {
		const store = {
			getSubscriptions: () => [{ id: "s1" }, { id: "s2" }],
			getTargets: () => [{ id: "t1" }],
			getGlobalsMeta: () => meta,
			getSubscriptionsMeta: () => meta,
			getTargetsMeta: () => meta,
		};
		return createHealthRoute({ runtime: { pipeline }, store } as unknown as RouteDeps);
	}

	it("恰好是契约里那几格:各模块开没开、核心包版本、配置分区;短版的四格不重复带", async () => {
		const modules = { dynamic: true, live: false, image: true, ai: false };
		const app = detailsApp({ getModuleState: () => modules });
		const body = (await (await app.request("/details")).json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual([
			"configScopes",
			"moduleVersions",
			"modules",
			"phase",
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
