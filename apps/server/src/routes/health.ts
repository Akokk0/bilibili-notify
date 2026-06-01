import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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

const require_ = createRequire(import.meta.url);
function readPkgVersion(specifier: string): string {
	try {
		return (require_(specifier) as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

// 编译期/启动期读一次缓存,health 接口高频调用不该每次 IO。infra 4 个 + engine 4 个,
// 顺序与 dashboard 卡片排序保持一致(api → storage → subscription → push → dynamic → live → image → ai)。
// Docker builder 不再执行 `changeset version`;这里读到的是镜像构建输入中的
// workspace package.json#version,可能落后于独立端 apps/server/package.json#version。
const MODULE_VERSIONS: ModuleVersions = {
	api: readPkgVersion("@bilibili-notify/api/package.json"),
	storage: readPkgVersion("@bilibili-notify/storage/package.json"),
	subscription: readPkgVersion("@bilibili-notify/subscription/package.json"),
	push: readPkgVersion("@bilibili-notify/push/package.json"),
	dynamic: readPkgVersion("@bilibili-notify/dynamic/package.json"),
	live: readPkgVersion("@bilibili-notify/live/package.json"),
	image: readPkgVersion("@bilibili-notify/image/package.json"),
	ai: readPkgVersion("@bilibili-notify/ai/package.json"),
};

/**
 * 独立端自身版本,取自 apps/server/package.json#version。版本号是唯一事实源、
 * 手动维护;`apps/server` 被 changeset `ignore`,`changeset version` 不会改它,
 * 故运行时读到的就是仓库里手填的版本。镜像 tag 与 alpha/正式渠道亦据它推导
 * (见 .github/workflows/image-release.yml)。读不到则回退 "dev"。
 */
export function resolveAppVersion(pkgPath: string = join(process.cwd(), "package.json")): string {
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
		return pkg.version || "dev";
	} catch {
		return "dev";
	}
}

const APP_VERSION = resolveAppVersion();
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
