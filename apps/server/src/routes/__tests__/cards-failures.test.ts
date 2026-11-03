/**
 * `/api/cards` 的失败怎么回(ADR-0026,规矩见 docs/agents/conventions/failure-results.md)。
 *
 * 两类分开:
 * - **请求本身不成 / 前提不满足** → 非 2xx 的错误体 `{ code, message, issues? }`,经 `respondFailure`。
 *   其中最要紧的一对:**没配浏览器是 `not_configured`(409)**(面板据此摆出「一键检测并启用 Chrome」),
 *   **推送链路 / 皮肤库还没就绪是 `unavailable`(503)**(等一会儿就好)—— 从前面板靠状态码 503 认,
 *   两件事混在一个 503 里分不开。
 * - **试了一次、没成**(预览 / 截图 / 测试推送里渲染抛错、投递没被接受)→ **照旧 200**,体是 `Result<…>`
 *   的失败那一支;耗时只在成功那一支,不带假的 `latencyMs: 0`。
 *
 * 别的用例(成功路径、引用拦截、热切换……)在 cards-route.test.ts / library-route.test.ts,这里只放失败。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CARD_SKINS_DIR, CardSkinStore } from "../../card-skins/store.js";
import type { PuppeteerAdapter } from "../../runtime/puppeteer.js";
import { bilibiliLikeSources } from "../../subscriptions/__tests__/fixtures.js";
import { createCardsRoute } from "../cards.js";
import { respondFailure, unhandledErrorMessage } from "../respond-failure.js";
import type { RouteDeps } from "../types.js";

const EMPTY_GLOBALS = { defaults: { cardSkin: "default", cardSkinKnobs: {} } };
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const STYLE = { font: "PingFang SC, sans-serif" };

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-cards-failures-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

/** 一份带推送链路、带一个推送目标的 deps。`pipeline: null` = 推送链路还没挂上。 */
function makeDeps(opts: { pipeline?: unknown } = {}): RouteDeps {
	const pipeline = "pipeline" in opts ? opts.pipeline : { push: { sendToTarget: vi.fn() } };
	return {
		runtime: {
			sourceRegistry: bilibiliLikeSources(),
			dataRoot: dataDir,
			pipeline,
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		store: {
			getGlobals: () => EMPTY_GLOBALS,
			getSubscriptions: () => [],
			getTargets: () => [{ id: TARGET_ID, name: "群一", enabled: true }],
		},
	} as unknown as RouteDeps;
}

/** 渲染能跑通的假 puppeteer。 */
function workingPuppeteer(): PuppeteerAdapter {
	const page = {
		setContent: vi.fn(async () => {}),
		$: vi.fn(async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		})),
		screenshot: vi.fn(async () => Buffer.from("fake-png-bytes")),
		close: vi.fn(async () => {}),
	};
	return { page: vi.fn(async () => page) } as unknown as PuppeteerAdapter;
}

/** 一开页就炸的假 puppeteer —— 「Chrome 起不来」。 */
function crashingPuppeteer(): PuppeteerAdapter {
	return {
		page: vi.fn(async () => {
			throw new Error("Failed to launch the browser process");
		}),
	} as unknown as PuppeteerAdapter;
}

function post(app: Pick<Hono, "request">, path: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /preview", () => {
	const body = { kind: "live", style: STYLE };

	it("没配浏览器 → not_configured(409),把该怎么办说出来", async () => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: null });
		const res = await post(app, "/preview", body);
		expect(res.status).toBe(409);
		const json = (await res.json()) as any;
		expect(json.code).toBe("not_configured");
		expect(json.message).toContain("BN_CHROME_PATH");
		expect(json).not.toHaveProperty("ok");
	});

	it("请求体不对 → invalid(400),zod 的逐格原因进 issues", async () => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: workingPuppeteer() });
		const res = await post(app, "/preview", { kind: "nope", style: STYLE });
		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.code).toBe("invalid");
		expect(json.issues.length).toBeGreaterThan(0);
	});

	it("画出来了 → 200 + { ok: true, dataUrl }", async () => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: workingPuppeteer() });
		const res = await post(app, "/preview", body);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.ok).toBe(true);
		expect(json.dataUrl).toMatch(/^data:image\/png;base64,/);
	});

	it("Chrome 起不来 → 200 + 失败那一支(unavailable),底层原因写进 message", async () => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: crashingPuppeteer() });
		const res = await post(app, "/preview", body);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: false,
			code: "unavailable",
			message: "卡片渲染失败：Failed to launch the browser process",
		});
	});
});

describe("POST /skins/:id/screenshot", () => {
	const shotBody = { kind: "live", manifest: {} };

	function shotApp(puppeteer: PuppeteerAdapter | null, withStore = true) {
		return createCardsRoute({
			deps: makeDeps(),
			puppeteer,
			cardSkins: withStore
				? new CardSkinStore({ dir: join(dataDir, ...CARD_SKINS_DIR) })
				: undefined,
		});
	}

	it("请求体不对 → invalid(400),issues 逐格", async () => {
		const res = await post(shotApp(workingPuppeteer()), "/skins/default/screenshot", {
			kind: "nope",
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.code).toBe("invalid");
		expect(json.issues.length).toBeGreaterThan(0);
	});

	it("皮肤库还没给 → unavailable(503),不是 not_configured:等一会儿就好", async () => {
		const res = await post(
			shotApp(workingPuppeteer(), false),
			"/skins/default/screenshot",
			shotBody,
		);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ code: "unavailable", message: "皮肤库未就绪" });
	});

	it("截图时 Chrome 起不来 → 200 + 失败那一支(unavailable),原因写进 message", async () => {
		const { DEFAULT_CARD_SKIN } = await import("@bilibili-notify/internal");
		const res = await post(shotApp(crashingPuppeteer()), "/skins/default/screenshot", {
			...shotBody,
			manifest: DEFAULT_CARD_SKIN,
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json).toEqual({
			ok: false,
			code: "unavailable",
			message: "卡片截图失败：Failed to launch the browser process",
		});
	});
});

describe("POST /test", () => {
	const body = { targetId: TARGET_ID, kind: "live", style: STYLE };

	it("请求体不对 → invalid(400),issues 逐格", async () => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: workingPuppeteer() });
		const res = await post(app, "/test", {
			targetId: "不是 uuid",
			kind: "live",
			style: STYLE,
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.code).toBe("invalid");
		expect(json.issues.length).toBeGreaterThan(0);
	});

	it("没配浏览器 → not_configured(409)", async () => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: null });
		const res = await post(app, "/test", body);
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).code).toBe("not_configured");
	});

	it("推送链路还没挂上 → unavailable(503)", async () => {
		const app = createCardsRoute({
			deps: makeDeps({ pipeline: null }),
			puppeteer: workingPuppeteer(),
		});
		const res = await post(app, "/test", body);
		expect(res.status).toBe(503);
		expect(((await res.json()) as any).code).toBe("unavailable");
	});

	it("没有这个推送目标 → not_found(404)", async () => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: workingPuppeteer() });
		const res = await post(app, "/test", {
			...body,
			targetId: "33333333-3333-4333-8333-333333333333",
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这个推送目标" });
	});

	it("渲染没成 → 200 + 失败那一支,不带假的 latencyMs,也没往外发", async () => {
		const sendToTarget = vi.fn();
		const app = createCardsRoute({
			deps: makeDeps({ pipeline: { push: { sendToTarget } } }),
			puppeteer: crashingPuppeteer(),
		});
		const res = await post(app, "/test", body);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json).toEqual({
			ok: false,
			code: "unavailable",
			message: "卡片渲染失败：Failed to launch the browser process",
		});
		expect(json).not.toHaveProperty("latencyMs");
		expect(sendToTarget).not.toHaveBeenCalled();
	});

	it("送达 → 200 + { ok: true, latencyMs }", async () => {
		const sendToTarget = vi.fn(async () => ({ ok: true, latencyMs: 12 }));
		const app = createCardsRoute({
			deps: makeDeps({ pipeline: { push: { sendToTarget } } }),
			puppeteer: workingPuppeteer(),
		});
		const res = await post(app, "/test", body);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, latencyMs: 12 });
	});

	it("没送达 → 200 + 失败那一支,对端的原话进 message,不带 latencyMs", async () => {
		const sendToTarget = vi.fn(async () => fail("unavailable", "群不存在"));
		const app = createCardsRoute({
			deps: makeDeps({ pipeline: { push: { sendToTarget } } }),
			puppeteer: workingPuppeteer(),
		});
		const res = await post(app, "/test", body);
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json).toEqual({ ok: false, code: "unavailable", message: "群不存在" });
		expect(json).not.toHaveProperty("latencyMs");
	});
});

describe("POST /renderer:意外的抛错不回原文", () => {
	it("构造 adapter 就抛 → 交给全局出错处理:只回固定一句,原话(带路径)不外泄", async () => {
		const secret = `${dataDir}/chrome: EACCES`;
		const route = createCardsRoute({
			deps: makeDeps(),
			puppeteer: null,
			createPuppeteer: () => {
				throw new Error(secret);
			},
		});
		// 与生产一样带全局的出错处理:抛出来的按 `unavailable` 回,原话只进日志。
		const app = new Hono()
			.onError((_err, c) => respondFailure(c, fail("unavailable", unhandledErrorMessage())))
			.route("/", route);
		const res = await post(app, "/renderer", { chromePath: "/x" });
		expect(res.status).toBe(503);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ code: "unavailable", message: unhandledErrorMessage() });
		expect(text).not.toContain("EACCES");
	});
});
