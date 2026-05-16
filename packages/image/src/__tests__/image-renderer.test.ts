/**
 * 单元测试 — `ImageRenderer` 的有逻辑纯函数(packages/image 首份测试)。
 *
 * 刻意只覆盖「逻辑承载」函数,**不测** HTML/CSS 模板拼装与 puppeteer SSR
 * (测渲染产物又脆又低价值,属集成测试地盘):
 *   - getTimeDifference:luxon UTC+8 时差格式化(过去/未来/相等)
 *   - getLiveStatus:直播状态码 → 文案三元组
 *   - getMimeType / isRemoteUrl / unixTimestampToString:纯映射
 *   - fetchImageAsDataUrl:缓存命中 / fetch 成功 / content-type 回退 / HTTP 错误
 *   - inlineRemoteImages:<img>+CSS url() 内联为 data:,失败保留原 URL
 *   - pruneImageCache:TTL 过期清除 + 超上限按最旧逐出
 *
 * 策略:fetch 用 vi.stubGlobal;时间相关用 vi.useFakeTimers;private 方法/字段
 * 经 `(r as any)` 白盒访问。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ImageRenderer,
	type ImageRendererConfig,
	type ImageRendererOptions,
} from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";

// biome-ignore lint/suspicious/noExplicitAny: 测试需访问 private 方法/字段
type AnyRenderer = any;

function makeRenderer(config: Partial<ImageRendererConfig> = {}): ImageRenderer {
	const ctx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	const puppeteer = {
		page: async () => ({}) as never,
	} as unknown as PuppeteerLike;
	const opts: ImageRendererOptions = {
		serviceCtx: ctx,
		puppeteer,
		config: {
			cardColorStart: "#000000",
			cardColorEnd: "#ffffff",
			font: "sans-serif",
			hideDesc: false,
			followerDisplay: false,
			...config,
		},
	};
	return new ImageRenderer(opts);
}

function fakeResponse(opts: {
	ok?: boolean;
	status?: number;
	statusText?: string;
	contentType?: string | null;
	body?: Uint8Array;
}): Response {
	return {
		ok: opts.ok ?? true,
		status: opts.status ?? 200,
		statusText: opts.statusText ?? "OK",
		headers: {
			get: (k: string) => (k.toLowerCase() === "content-type" ? (opts.contentType ?? null) : null),
		},
		arrayBuffer: async () => (opts.body ?? new Uint8Array([1, 2, 3])).buffer,
	} as unknown as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// getTimeDifference
// ---------------------------------------------------------------------------

describe("ImageRenderer.getTimeDifference", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// 现在 = 2026-01-01T04:00:00Z = UTC+8 的 2026-01-01 12:00:00
		vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
	});

	it("过去 2 小时 → 「2小时」", async () => {
		const r = makeRenderer();
		// dateString 按 UTC+8 解析:10:00:00(+08) = 02:00:00Z,距今 2h 前
		expect(await r.getTimeDifference("2026-01-01 10:00:00")).toBe("2小时");
	});

	it("未来 2 小时 → 带负号「-2小时」", async () => {
		const r = makeRenderer();
		expect(await r.getTimeDifference("2026-01-01 14:00:00")).toBe("-2小时");
	});

	it("时间相等 → 「0秒」", async () => {
		const r = makeRenderer();
		expect(await r.getTimeDifference("2026-01-01 12:00:00")).toBe("0秒");
	});
});

// ---------------------------------------------------------------------------
// getLiveStatus
// ---------------------------------------------------------------------------

describe("ImageRenderer.getLiveStatus", () => {
	it("status=0 → 未直播", async () => {
		const r = makeRenderer();
		expect(await r.getLiveStatus("t", 0)).toEqual(["未直播", "未开播", true]);
	});

	it("status=1 → 开播啦 + 开播时间", async () => {
		const r = makeRenderer();
		expect(await r.getLiveStatus("2026-01-01 12:00:00", 1)).toEqual([
			"开播啦",
			"开播时间：2026-01-01 12:00:00",
			true,
		]);
	});

	it("status=2 → 正在直播 + 时长,第三元素 false", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
		const r = makeRenderer();
		const [title, , flag] = await r.getLiveStatus("2026-01-01 10:00:00", 2);
		expect(title).toBe("正在直播");
		expect(flag).toBe(false);
	});

	it("status=3 → 下播啦", async () => {
		const r = makeRenderer();
		expect(await r.getLiveStatus("2026-01-01 12:00:00", 3)).toEqual([
			"下播啦",
			"开播时间：2026-01-01 12:00:00",
			true,
		]);
	});

	it("未知 status → 空文案三元组", async () => {
		const r = makeRenderer();
		expect(await r.getLiveStatus("t", 99)).toEqual(["", "", true]);
	});
});

// ---------------------------------------------------------------------------
// 纯映射:getMimeType / isRemoteUrl / unixTimestampToString
// ---------------------------------------------------------------------------

describe("ImageRenderer 纯映射辅助", () => {
	it("getMimeType 按后缀映射,未知回退 jpeg", () => {
		const r = makeRenderer() as AnyRenderer;
		expect(r.getMimeType("a/b.PNG")).toBe("image/png");
		expect(r.getMimeType("x.webp")).toBe("image/webp");
		expect(r.getMimeType("x.gif")).toBe("image/gif");
		expect(r.getMimeType("x.svg")).toBe("image/svg+xml");
		expect(r.getMimeType("x.unknownext")).toBe("image/jpeg");
	});

	it("isRemoteUrl 仅对 http(s) 为真", () => {
		const r = makeRenderer() as AnyRenderer;
		expect(r.isRemoteUrl("https://a/b.png")).toBe(true);
		expect(r.isRemoteUrl("http://a")).toBe(true);
		expect(r.isRemoteUrl("/local/x.png")).toBe(false);
		expect(r.isRemoteUrl("data:image/png;base64,AAA")).toBe(false);
		expect(r.isRemoteUrl(null)).toBe(false);
		expect(r.isRemoteUrl(undefined)).toBe(false);
	});

	it("unixTimestampToString 零填充格式", () => {
		const r = makeRenderer();
		// 2026-01-02T03:04:05Z;断言年与零填充结构(不锁时区具体小时)
		const s = r.unixTimestampToString(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000);
		expect(s).toMatch(/^2026年01月\d{2}日 \d{2}:\d{2}:\d{2}$/);
	});
});

// ---------------------------------------------------------------------------
// fetchImageAsDataUrl
// ---------------------------------------------------------------------------

describe("ImageRenderer.fetchImageAsDataUrl", () => {
	it("缓存命中 → 直接返回,不发 fetch,刷新 updatedAt", async () => {
		const r = makeRenderer() as AnyRenderer;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		r.imageCache.set("http://x/a.png", { dataUrl: "data:cached", updatedAt: 1 });
		const out = await r.fetchImageAsDataUrl("http://x/a.png");
		expect(out).toBe("data:cached");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(r.imageCache.get("http://x/a.png").updatedAt).toBeGreaterThan(1);
	});

	it("fetch 成功 → 返回 data URL 并写入缓存", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: "image/png", body: new Uint8Array([65]) })),
		);
		const out = await r.fetchImageAsDataUrl("http://x/a.png");
		expect(out).toBe(`data:image/png;base64,${Buffer.from([65]).toString("base64")}`);
		expect(r.imageCache.has("http://x/a.png")).toBe(true);
	});

	it("响应无 content-type → 回退到 URL 后缀的 mime", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: null })),
		);
		const out = await r.fetchImageAsDataUrl("http://x/pic.webp");
		expect(out.startsWith("data:image/webp;base64,")).toBe(true);
	});

	it("响应 not ok → 抛 HTTP 错误", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ ok: false, status: 404, statusText: "Not Found" })),
		);
		await expect(r.fetchImageAsDataUrl("http://x/missing.png")).rejects.toThrow("HTTP 404");
	});
});

// ---------------------------------------------------------------------------
// inlineRemoteImages
// ---------------------------------------------------------------------------

describe("ImageRenderer.inlineRemoteImages", () => {
	it("<img src=远程> 内联为 data:,相对路径 src 不动", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: "image/png" })),
		);
		const html = '<html><body><img src="https://cdn/a.png"><img src="/local/b.png"></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).toContain("data:image/png;base64,");
		expect(out).not.toContain("https://cdn/a.png");
		expect(out).toContain("/local/b.png"); // 相对路径保留
	});

	it("<style> 内 url(https://...) 内联替换", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: "image/png" })),
		);
		const html =
			'<html><head><style>.bg{background:url("https://cdn/bg.png")}</style></head><body></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).toContain("data:image/png;base64,");
		expect(out).not.toContain("https://cdn/bg.png");
	});

	it("单图 fetch 失败 → 保留原 URL,不抛", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network");
			}),
		);
		const html = '<html><body><img src="https://cdn/x.png"></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).toContain("https://cdn/x.png");
	});
});

// ---------------------------------------------------------------------------
// pruneImageCache
// ---------------------------------------------------------------------------

describe("ImageRenderer.pruneImageCache", () => {
	it("TTL 过期项被清除,未过期保留", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const r = makeRenderer() as AnyRenderer;
		const now = Date.now();
		r.imageCache.set("old", { dataUrl: "d", updatedAt: now - 31 * 60 * 1000 }); // > 30min
		r.imageCache.set("fresh", { dataUrl: "d", updatedAt: now - 60 * 1000 });
		r.pruneImageCache();
		expect(r.imageCache.has("old")).toBe(false);
		expect(r.imageCache.has("fresh")).toBe(true);
	});

	it("超过 CACHE_MAX_SIZE → 按 updatedAt 最旧逐出至上限", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const r = makeRenderer() as AnyRenderer;
		const now = Date.now();
		// 302 条且都「未过期」(updatedAt 递增,序号越小越旧)
		for (let i = 0; i < 302; i++) {
			r.imageCache.set(`u${i}`, { dataUrl: "d", updatedAt: now - (302 - i) * 1000 });
		}
		r.pruneImageCache();
		expect(r.imageCache.size).toBe(300);
		// 最旧两条(u0/u1)应被逐出
		expect(r.imageCache.has("u0")).toBe(false);
		expect(r.imageCache.has("u1")).toBe(false);
		expect(r.imageCache.has("u301")).toBe(true);
	});
});
