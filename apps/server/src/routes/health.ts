import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// 各核心包版本走**静态 JSON import**(而非 createRequire 运行时解析):bundler 构建期
// 把 version 内联进产物,单文件 bundle 旁没有 node_modules 也能显示真实版本;dev(tsx)/
// 测试(vitest)/外置 lib 构建下,import attributes 由 node / vite 原生支持,行为一致。
import aiPkg from "@bilibili-notify/ai/package.json" with { type: "json" };
import apiPkg from "@bilibili-notify/api/package.json" with { type: "json" };
import dynamicPkg from "@bilibili-notify/dynamic/package.json" with { type: "json" };
import imagePkg from "@bilibili-notify/image/package.json" with { type: "json" };
import livePkg from "@bilibili-notify/live/package.json" with { type: "json" };
import pushPkg from "@bilibili-notify/push/package.json" with { type: "json" };
import storagePkg from "@bilibili-notify/storage/package.json" with { type: "json" };
import subscriptionPkg from "@bilibili-notify/subscription/package.json" with { type: "json" };
import { Hono } from "hono";
import type { ConfigScopeMeta } from "../config/store.js";
import type { ModuleStatus } from "../runtime/engines.js";
import type { RouteDeps } from "./types.js";

type ModuleId = "api" | "storage" | "subscription" | "push" | "dynamic" | "live" | "image" | "ai";
type ModuleVersions = Record<ModuleId, string>;

interface HealthBody {
	status: "ok";
	version: string;
	moduleVersions: ModuleVersions;
	uptime: number;
	startedAt: string;
	login: string | null;
	push: string | null;
	dynamicCron: string | null;
	history: string | null;
	modules: ModuleStatus;
}

interface HealthDetailsBody {
	status: "ok";
	version: string;
	moduleVersions: ModuleVersions;
	uptime: number;
	startedAt: string;
	login: null;
	push: null;
	dynamicCron: string;
	history: { entries: number };
	lastError: null;
	configScopes: {
		globals: ConfigScopeMeta;
		subscriptions: ConfigScopeMeta & { count: number };
		targets: ConfigScopeMeta & { count: number };
	};
}

// infra 4 个 + engine 4 个,顺序与 dashboard 卡片排序保持一致
// (api → storage → subscription → push → dynamic → live → image → ai)。
// Docker builder 不再执行 `changeset version`;这里读到的是构建输入中的
// workspace package.json#version,仅用于展示核心包版本,不驱动独立端发布版本。
export const MODULE_VERSIONS: ModuleVersions = {
	api: apiPkg.version,
	storage: storagePkg.version,
	subscription: subscriptionPkg.version,
	push: pushPkg.version,
	dynamic: dynamicPkg.version,
	live: livePkg.version,
	image: imagePkg.version,
	ai: aiPkg.version,
};

/**
 * 从某个模块的位置往上找最近的 `package.json`。
 *
 * bundle 形态一步就到(产物是平的,`package.json` 与 `index.mjs` 同级);源码 / dev
 * 形态要从 `src/routes/` 往上爬两层才够到 `apps/server/package.json`。`maxDepth`
 * 是刹车:找不到就认输回 `null`,绝不一路爬到 `/` 去捡别人的 `package.json` ——
 * 报一个别的包的版本号比报 "dev" 更能骗人。
 */
export function findNearestPackageJson(fromUrl: string, maxDepth = 6): string | null {
	let dir = dirname(fileURLToPath(fromUrl));
	for (let i = 0; i <= maxDepth; i++) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

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
	pkgPath: string | null = findNearestPackageJson(import.meta.url),
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
 * Mounts:
 *   GET /api/health           — short shape, used as a liveness probe (unchanged from 2.1)
 *   GET /api/health/details   — richer report drawing on the config store + (later) sinks
 */
export function createHealthRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		const engines = deps.runtime.engines;
		const modules: ModuleStatus = engines
			? engines.getModuleStatus()
			: { dynamic: false, live: false, image: false, ai: false };
		const body: HealthBody = {
			status: "ok",
			version: APP_VERSION,
			moduleVersions: MODULE_VERSIONS,
			uptime: Math.floor((Date.now() - startedAtMs) / 1000),
			startedAt: new Date(startedAtMs).toISOString(),
			login: null,
			push: null,
			dynamicCron: null,
			history: null,
			modules,
		};
		return c.json(body);
	});

	app.get("/details", (c) => {
		const globals = deps.store.getGlobals();
		const subs = deps.store.getSubscriptions();
		const targets = deps.store.getTargets();
		const body: HealthDetailsBody = {
			status: "ok",
			version: APP_VERSION,
			moduleVersions: MODULE_VERSIONS,
			uptime: Math.floor((Date.now() - startedAtMs) / 1000),
			startedAt: new Date(startedAtMs).toISOString(),
			login: null,
			push: null,
			dynamicCron: globals.app.dynamicCron,
			history: { entries: 0 },
			lastError: null,
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
