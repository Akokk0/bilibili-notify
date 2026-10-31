/**
 * 接线守卫:ADR-0036「路由按资源整理」的每一组新路径都真的挂在 app 上,老路径都已经没了。
 *
 * 各路由自己那几条测试直接 `createXRoute()` 再打相对路径,**证明不了它被挂进了 app、挂在哪**。
 * 少一行 `app.route(...)` 的症状是面板上那一块永远读不出来(404),而路由自己的测试全绿。
 *
 * 判「路由不存在」只认**那句固定的话**(`ROUTE_NOT_FOUND_MESSAGE`),不认状态码 404:
 * 带着不存在的 id 打 `POST /api/targets/:id/test` 之类,处理函数自己也会回 404(「没有这个推送目标」),
 * 那是**挂上了**的证据,不是没挂。
 *
 * 另外两道闸(桌面令牌闸只放行精确的 `/api/health`、cookie 闸只放行 `/api/session` 与 `/api/session/*`)
 * 不许被新路径钻空子 —— 所以每条新路径在两种闸下都要被拦,而 `/api/ws/ticket` 尤其不能放进
 * `/api/session` 底下(ADR-0036 决策 3)。
 */

import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type CreateAppOptions, createApp, createCardSkinStore } from "../app.js";
import { createSessionCodec } from "../auth/session.js";
import { createWsTicketStore } from "../auth/ws-ticket.js";
import type { BackupService } from "../backup/service.js";
import { settingsSegment } from "../bilibili/settings.js";
import { createDevtoolsProviderRegistry } from "../devtools/providers.js";
import { createDevRegistry } from "../devtools/registry.js";
import { createDevRoute } from "../devtools/route.js";
import { ROUTE_NOT_FOUND_MESSAGE } from "../routes/respond-failure.js";
import { createAppRuntime } from "../runtime/bootstrap.js";
import type { UpdateService } from "../update/service.js";

const ID = "11111111-1111-4111-8111-111111111111";
const KEY = Buffer.from("test-key-material-32-bytes-long!!", "utf8");
const CREDS = { username: "admin", password: "s3cret" };
const DESKTOP_TOKEN = "desktop-token-for-the-mount-guard";

interface Probe {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	/** 写口子要的体;只为让处理函数在**动手之前**就回 400 / 503,不会真做事。 */
	body?: unknown;
}

const get = (path: string): Probe => ({ method: "GET", path });
const post = (path: string, body: unknown = {}): Probe => ({ method: "POST", path, body });

/**
 * 决策 4 那张表里每一组的新路径,各挑**只读或动手前就被拒**的口子。
 * 带条件挂载的几组(`/api/system/update`、`/backup`、`/api/ws/ticket`、`/api/dev`)由 {@link makeApp}
 * 把条件依赖都传上,让它们挂出来。
 */
const NEW_PATHS: Probe[] = [
	get("/api/library/images"),
	post("/api/library/images"),
	get("/api/library/images/nope"),
	{ method: "DELETE", path: "/api/library/images/nope" },
	get("/api/library/fonts"),
	post("/api/library/fonts"),
	get("/api/library/fonts/nope"),
	{ method: "DELETE", path: "/api/library/fonts/nope" },

	get("/api/settings"),
	get("/api/subscriptions"),
	get("/api/subscriptions/tags"),
	get("/api/stats/followers"),
	get("/api/ai/skills"),
	post("/api/ai/test"),
	get("/api/system/logs"),
	get("/api/system/update"),
	post("/api/system/backup/export"),
	get("/api/system/notices"),
	// 旧版本数据(㉙c):列表只读;删除带了不存在的号,处理函数自己回「没有这一代」(那也是挂上了的证据)。
	get("/api/system/generations"),
	{ method: "DELETE", path: "/api/system/generations/7" },
	// 存储占用(㉙d):列表只读;清理带了不认的类别,处理函数自己回 400(那也是挂上了的证据);清扫的 POST 没有请求体要校验,
	// 注入的是一份什么都不删的替身。
	get("/api/system/storage"),
	{ method: "DELETE", path: "/api/system/storage/nope" },
	post("/api/system/storage/images/sweep"),
	get("/api/cards/skins"),
	post(`/api/cards/skins/${ID}/ai`),
	get("/api/dashboard/skins"),
	post(`/api/dashboard/skins/${ID}/ai`),
	post("/api/cards/test"),
	get("/api/cards/chrome"),
	get("/api/cards/renderer"),
	post("/api/cards/renderer"),
	post(`/api/cards/skins/${ID}/screenshot`),
	post("/api/stats/roast/run"),
	post(`/api/stats/roast/run/${ID}`),
	{ method: "DELETE", path: "/api/dev/captures/history" },
	post("/api/ws/ticket"),
	post(`/api/targets/${ID}/test`),
	post(`/api/connections/${ID}/probe`),
	// 挑地址的读口(3a-22-3):不带 `scope`,处理函数动手之前就回 400。
	get(`/api/connections/${ID}/addresses`),
	// 适配器自带的扫码建连接(3a-29):这份 app 不登记任何适配器,三个口都在动手之前回「适配器没在跑」(503)。
	post("/api/adapters/qq-official/auth"),
	get("/api/adapters/qq-official/auth/nope"),
	post("/api/adapters/qq-official/auth/nope/draft"),
	// 来源的登录口(3a-29 B 站半):这份 app 的登记表里没有来源,三个口都在动手之前回「这个来源没在跑」(503)。
	get("/api/sources/bilibili/auth"),
	post("/api/sources/bilibili/auth"),
	{ method: "DELETE", path: "/api/sources/bilibili/auth" },
	// 问题表的读口(3a-30):只读内存里的表,真运行时里是空表 —— 挂上了就回 200。
	get("/api/problems"),
	// 决策 5 随 ⑮ 开的图库读口(没这张图,处理函数自己回 404 —— 那也是挂上了的证据)。
	get(`/api/images/${"0".repeat(64)}.png`),
	// 聊天附件的上传(⑳b 起存进图库):没带文件,处理函数动手之前就回 400。
	post("/api/ai/assets"),
];

/** 对应的老路径:一条都不许再答。 */
const OLD_PATHS: Probe[] = [
	get("/api/cards/assets"),
	post("/api/cards/asset"),
	get("/api/cards/asset/nope"),
	{ method: "DELETE", path: "/api/cards/asset/nope" },
	get("/api/cards/font-assets"),
	post("/api/cards/font-asset"),
	get("/api/cards/font-asset/nope"),
	{ method: "DELETE", path: "/api/cards/font-asset/nope" },

	get("/api/globals"),
	get("/api/subs"),
	get("/api/subs/tags"),
	get(`/api/subs/${ID}/avatar`),
	get("/api/fans"),
	get("/api/maid-skills"),
	post("/api/ai/test-push"),
	get("/api/logs"),
	get("/api/update"),
	post("/api/backup/export"),
	get("/api/card-skins"),
	post(`/api/card-skins/${ID}/ai-css`),
	get("/api/skins"),
	post(`/api/skins/${ID}/ai-edit`),
	post("/api/cards/test-push"),
	get("/api/cards/detect-chrome"),
	get("/api/cards/render-source"),
	post("/api/cards/enable-rendering"),
	post("/api/cards/skin-shot"),
	// `POST /api/stats/roast/run-now`(单段)不在这张表里:它如今会被 `/roast/:subscriptionId` 当成
	// 一个订阅 id 吃掉,回的不是「没有这个接口」—— 见下面「老的 run-now 不会触发那一轮」那条。
	post(`/api/stats/roast/run-now/${ID}`),
	post("/api/dev/captures/purge-history"),
	post("/api/auth/ws-ticket"),
	// `/api/auth/*`(3a-29 提交 ⑤)整个退役:登录口搬到 `/api/sources/:sourceKey/auth`,手动刷新 Cookie 的口直接删。
	get("/api/auth/status"),
	post("/api/auth/qr"),
	post("/api/auth/cookies/refresh"),
	post("/api/auth/logout"),
	post("/api/push/test"),
	post(`/api/connections/${ID}/test`),
	// QQ 官方挑群 / 频道地址的两个读口(3a-22-3 起走 `/api/connections/:id/addresses`,这两个退役)。
	get(`/api/qq/sessions/${ID}`),
	get(`/api/qq/guilds/${ID}`),
	// QQ 官方扫码绑定的两个口(3a-29 起走 `/api/adapters/:adapterKey/auth…`,整个 `/api/qq` 退役)。
	post("/api/qq/bind/start"),
	post("/api/qq/bind/poll"),
	// 聊天附件的读口(⑳b 起走图库的同源读口 `/api/images/<ref>`,这个口退役)。
	get(`/api/ai/assets/${"0".repeat(32)}.png`),
	// 拓展订阅头像的读口(⑳c 起头像在图库里、资料里放引用,走 `/api/images/<ref>`,这个口退役)。
	get(`/api/subscriptions/${ID}/avatar`),
	// 历史配图的读口(⑳d 起配图在图库里、行里放引用,走 `/api/images/<ref>`,这个口退役)。
	get(`/api/history/img/${"0".repeat(64)}.png`),
];

let dataDir: string;
const disposers: Array<() => Promise<void>> = [];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-routes-by-resource-"));
});

afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
	await rm(dataDir, { recursive: true, force: true });
});

/** 一个把有条件的几组都挂上的完整 app;`extra` 叠上鉴权闸那几样。 */
async function makeApp(extra: Partial<CreateAppOptions> = {}) {
	const runtime = createAppRuntime(
		{ server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
		{ dataRoot: dataDir },
		{ integrationSettings: [settingsSegment] },
	);
	await runtime.configStore.load();
	const wsTicketStore = createWsTicketStore();
	disposers.push(async () => {
		wsTicketStore.dispose();
		await runtime.dispose();
	});
	const status = {
		currentVersion: "0.0.0",
		rollbackTarget: null,
		pinnedVersion: null,
		state: { phase: "idle" as const },
	};
	const updateService: UpdateService = {
		getStatus: () => status,
		check: async () => status,
		download: async () => status,
		rollback: async () => status,
		probeMirrors: async () => [],
	};
	return createApp(runtime, {
		cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		wsTicketStore,
		backupService: {} as BackupService,
		update: {
			service: updateService,
			startedAt: "2026-10-03T00:00:00.000Z",
			applyUpdate: async () => {},
		},
		system: {
			ability: () => ({ can: true, how: "container" }),
			startedAt: "2026-10-03T00:00:00.000Z",
			version: "0.0.0",
			restart: async () => {},
			notices: { list: async () => [], acknowledge: async () => false },
			requestGeneration: async () => {},
			zeroGenerationExists: async () => false,
			generations: { list: async () => [], remove: async () => ({ kind: "not_found" }) },
			storage: {
				list: async () => ({ rows: [] }),
				clear: async () => ({ freedBytes: 0 }),
				sweepImages: async () => ({ removedCount: 0, removedBytes: 0, referenced: 0, inGrace: 0 }),
			},
		},
		devtools: createDevRoute({
			registry: createDevRegistry(createDevtoolsProviderRegistry()),
			captures: {
				status: () => ({}) as never,
				clear: () => {},
				purgeHistory: async () => 0,
			},
		}),
		...extra,
	});
}

async function hit(app: Hono, probe: Probe) {
	const init: RequestInit = { method: probe.method };
	if (probe.body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(probe.body);
	}
	return app.request(probe.path, init);
}

/** 这条回应是不是 app 的「没有这个接口」—— 区别于处理函数自己回的 404。 */
async function isRouteMissing(res: Response): Promise<boolean> {
	if (res.status !== 404) return false;
	const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
	return body?.code === "not_found" && body.message === ROUTE_NOT_FOUND_MESSAGE;
}

const label = (p: Probe) => `${p.method} ${p.path}`;

describe("路由按资源整理(ADR-0036)的挂载", () => {
	it.each(NEW_PATHS.map((p) => [label(p), p] as const))("新路径 %s 挂着", async (_name, probe) => {
		const app = await makeApp();
		const res = await hit(app, probe);
		expect(await isRouteMissing(res), `${label(probe)} → ${res.status}`).toBe(false);
	});

	it.each(OLD_PATHS.map((p) => [label(p), p] as const))(
		"老路径 %s 回 JSON not_found",
		async (_name, probe) => {
			const app = await makeApp();
			const res = await hit(app, probe);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ code: "not_found", message: ROUTE_NOT_FOUND_MESSAGE });
		},
	);

	it("宿主没传的几组照旧不挂:/api/system 下只剩一直挂着的日志", async () => {
		const app = await makeApp({
			backupService: undefined,
			update: undefined,
			system: undefined,
			devtools: undefined,
		});
		// 日志是一直挂着的。
		expect(await isRouteMissing(await hit(app, get("/api/system/logs")))).toBe(false);
		// 其余三口各看各的条件,没传就当没有这回事。
		for (const probe of [
			get("/api/system/update"),
			post("/api/system/backup/export"),
			get("/api/system/notices"),
			get("/api/system/generations"),
			{ method: "DELETE", path: "/api/system/generations/7" } as Probe,
			get("/api/system/storage"),
			{ method: "DELETE", path: "/api/system/storage/stats" } as Probe,
			post("/api/system/storage/images/sweep"),
			post("/api/system/restart"),
		]) {
			expect(await isRouteMissing(await hit(app, probe)), label(probe)).toBe(true);
		}
		expect(await isRouteMissing(await hit(app, post("/api/dev/captures/history")))).toBe(true);
	});

	it("立刻跑一轮锐评:/roast/run 与 /roast/run/:id 触发调度器,老的 run-now 不会", async () => {
		const runRoastNow = vi.fn(async () => ({ ran: true }) as never);
		const app = await makeApp({ runRoastNow });

		expect((await hit(app, post("/api/stats/roast/run"))).status).toBe(200);
		expect(runRoastNow).toHaveBeenLastCalledWith(undefined);
		expect((await hit(app, post(`/api/stats/roast/run/${ID}`))).status).toBe(200);
		expect(runRoastNow).toHaveBeenLastCalledWith(ID);
		expect(runRoastNow).toHaveBeenCalledTimes(2);

		// 单段的老路径被 `/roast/:subscriptionId` 当订阅 id 吃了(回什么看单人锐评怎么判),
		// 但**不会**去跑那一轮;两段的老路径干脆没有这个接口。
		await hit(app, post("/api/stats/roast/run-now"));
		await hit(app, post(`/api/stats/roast/run-now/${ID}`));
		expect(runRoastNow).toHaveBeenCalledTimes(2);
	});

	it("票的口子无条件挂着(从前要登录系统在场才挂,3a-29 之后不再依赖它)", async () => {
		const app = await makeApp({});
		expect(await isRouteMissing(await hit(app, post("/api/ws/ticket")))).toBe(false);
	});
});

describe("两道鉴权闸不被新路径钻空子", () => {
	it("cookie 闸:每条新路径没带 cookie 一律 401,只有 /api/session 照旧免闸", async () => {
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = await makeApp({ basicAuthCredentials: CREDS, sessionCodec: codec });

		for (const probe of NEW_PATHS) {
			const res = await hit(app, probe);
			expect(res.status, label(probe)).toBe(401);
			expect(await res.json(), label(probe)).toEqual({
				code: "unauthorized",
				message: "需要先登录面板",
			});
		}

		// 面板 WS 的票要登录才给 —— 带上 cookie 才拿得到。
		const ticket = await hit(app, post("/api/ws/ticket"));
		expect(ticket.status).toBe(401);
		const authed = await app.request("/api/ws/ticket", {
			method: "POST",
			headers: { cookie: `bn_session=${codec.sign()}` },
		});
		expect(authed.status).toBe(200);
		expect(await authed.json()).toMatchObject({ ticket: expect.any(String) });

		// 免闸的只有 /api/session:探针照旧答。
		const session = await app.request("/api/session");
		expect(session.status).toBe(200);
	});

	it("桌面令牌闸:每条新路径没带令牌一律 401,只有精确的 /api/health 放行", async () => {
		const app = await makeApp({ desktopToken: DESKTOP_TOKEN });

		for (const probe of NEW_PATHS) {
			const res = await hit(app, probe);
			expect(res.status, label(probe)).toBe(401);
		}
		expect((await app.request("/api/health")).status).toBe(200);
		// 带上令牌就是另一回事了:同一条路径过得了闸、不是「没有这个接口」。
		const withToken = await app.request("/api/ws/ticket", {
			method: "POST",
			headers: { "x-bn-desktop-token": DESKTOP_TOKEN },
		});
		expect(withToken.status).toBe(200);
	});
});
