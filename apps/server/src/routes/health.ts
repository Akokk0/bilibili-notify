import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// 走最近 package.json 上溯。dev (tsx, 文件在 src/routes) 和 prod (bundled
// 到 lib/index.mjs) 起点不同,但都能在 1-2 层内找到 apps/server/package.json。
function readNearestPkgVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		try {
			const text = readFileSync(resolve(dir, "package.json"), "utf-8");
			const pkg = JSON.parse(text) as { version?: string };
			if (pkg.version) return pkg.version;
		} catch {
			/* keep walking */
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "0.0.0";
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

// 顶层 version 字段保留兼容:用 apps/server 自身 package.json,作为 app shell 版本。
const SERVER_PKG_VERSION = readNearestPkgVersion();
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
			version: SERVER_PKG_VERSION,
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
			version: SERVER_PKG_VERSION,
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
