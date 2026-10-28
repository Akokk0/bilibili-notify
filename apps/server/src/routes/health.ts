import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// 各核心包版本走**静态 JSON import**(而非 createRequire 运行时解析):bundler 构建期
// 把 version 内联进产物,单文件 bundle 旁没有 node_modules 也能显示真实版本;dev(tsx)/
// 测试(vitest)/外置 lib 构建下,import attributes 由 node / vite 原生支持,行为一致。
import aiPkg from "@bilibili-notify/ai/package.json" with { type: "json" };
import type { HealthDetailsResponse, HealthResponse, ModuleState } from "@bilibili-notify/contract";
import imagePkg from "@bilibili-notify/image/package.json" with { type: "json" };
import pushPkg from "@bilibili-notify/push/package.json" with { type: "json" };
import storagePkg from "@bilibili-notify/storage/package.json" with { type: "json" };
import subscriptionPkg from "@bilibili-notify/subscription/package.json" with { type: "json" };
import { Hono } from "hono";
import { findNearestPackageJson } from "../runtime/nearest-package-json.js";
import type { RouteDeps } from "./types.js";

type ModuleVersions = HealthDetailsResponse["moduleVersions"];

// 顺序与 dashboard 卡片排序保持一致(storage → subscription → push → image → ai)。
// B 站那三个包(api / dynamic / live)3a 搬进服务端、不再是独立的包,没有自己的版本可报。
// Docker builder 不再执行 `changeset version`;这里读到的是构建输入中的
// workspace package.json#version,仅用于展示核心包版本,不驱动独立端发布版本。
export const MODULE_VERSIONS: ModuleVersions = {
	storage: storagePkg.version,
	subscription: subscriptionPkg.version,
	push: pushPkg.version,
	image: imagePkg.version,
	ai: aiPkg.version,
};

/**
 * 独立端自身版本,取自构建时的 apps/server/package.json#version。源码中该值
 * 保持开发占位;发布 workflow 会按 v<VERSION> tag 临时同步后再构建,因此镜像 /
 * Desktop 运行时读到的版本与发布 tag 一致。读不到则回退 "dev"。
 *
 * 默认按**本模块自己的位置**找,不是 `process.cwd()`:在线升级后新载荷跑在
 * `/data/versions/<新版>/`,而 cwd 仍是容器的 `/app`(镜像自带那份)。照 cwd 读
 * 就会一直报旧版本号 —— 用户升完看仪表盘纹丝不动,只会以为升级压根没成。
 */
export function resolveAppVersion(
	// 源码形态要从 `src/routes/` 往上爬到 `apps/server/package.json`,6 层够用还不至于摸到别人的。
	pkgPath: string | null = findNearestPackageJson(dirname(fileURLToPath(import.meta.url)), 6),
): string {
	if (!pkgPath) return "dev";
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
		return pkg.version || "dev";
	} catch {
		return "dev";
	}
}

/**
 * 这一进程跑的载荷版本,启动时算一次。`resolveAppVersion` 每次调用都要向上找一遍
 * package.json 再解析,而它在一次启动里不会变 —— 别的模块也用这个常量,别再算一遍。
 */
export const APP_VERSION = resolveAppVersion();
const startedAtMs = Date.now();
/**
 * 这个进程的启动时刻(ISO)。`/api/health` 报它,`POST /api/system/update/apply` 也报它 ——
 * 面板靠「startedAt 变了」认新进程,两处必须是同一个值。
 */
export const STARTED_AT = new Date(startedAtMs).toISOString();

/**
 * 短版健康回应(ADR-0025 决策 12 的四格)。开机那一段(数据与推送链路还没起来)与完整的 app 答的是
 * 同一份 —— 四格都不看运行时。
 */
export function healthResponse(): HealthResponse {
	return {
		status: "ok",
		version: APP_VERSION,
		uptime: Math.floor((Date.now() - startedAtMs) / 1000),
		startedAt: STARTED_AT,
	};
}

/** 推送链路还没挂上时各模块的状态。 */
const NO_MODULES: ModuleState = { dynamic: false, live: false, image: false, ai: false };

/**
 * Mounts:
 *   GET /api/health           — 短版四格,存活探测
 *   GET /api/health/details   — 健康卡的数据:各模块开没开、核心包版本、配置分区
 */
export function createHealthRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.get("/", (c) => c.json(healthResponse()));

	app.get("/details", (c) => {
		const subs = deps.store.getSubscriptions();
		const targets = deps.store.getTargets();
		const body: HealthDetailsResponse = {
			moduleVersions: MODULE_VERSIONS,
			modules: deps.runtime.pipeline?.getModuleState() ?? NO_MODULES,
			configScopes: {
				globals: deps.store.getGlobalsMeta(),
				subscriptions: { ...deps.store.getSubscriptionsMeta(), count: subs.length },
				targets: { ...deps.store.getTargetsMeta(), count: targets.length },
			},
		};
		return c.json(body);
	});

	return app;
}
