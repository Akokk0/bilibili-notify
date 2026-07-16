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
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	ImageRenderer,
	type ImageRendererConfig,
	type ImageRendererOptions,
} from "../image-renderer";
import type { PuppeteerLike } from "../puppeteer";

// biome-ignore lint/suspicious/noExplicitAny: 测试需访问 private 方法/字段
type AnyRenderer = any;

function makeRenderer(
	config: Partial<ImageRendererConfig> = {},
	extra: Partial<ImageRendererOptions> = {},
): ImageRenderer {
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
			showPopularity: true,
			showArea: true,
			showFans: true,
			...config,
		},
		...extra,
	};
	return new ImageRenderer(opts);
}

function fakeResponse(opts: {
	ok?: boolean;
	status?: number;
	statusText?: string;
	contentType?: string | null;
	contentLength?: number | null;
	body?: Uint8Array;
}): Response {
	return {
		ok: opts.ok ?? true,
		status: opts.status ?? 200,
		statusText: opts.statusText ?? "OK",
		headers: {
			get: (k: string) => {
				const key = k.toLowerCase();
				if (key === "content-type") return opts.contentType ?? null;
				if (key === "content-length")
					return opts.contentLength != null ? String(opts.contentLength) : null;
				return null;
			},
		},
		// 无 body stream → readCapped 走 arrayBuffer 回退路径(仍做大小校验)。
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
// compressBiliImageUrl — 大图走 B 站处理服务缩放压缩
// ---------------------------------------------------------------------------

describe("ImageRenderer.compressBiliImageUrl", () => {
	it("i*.hdslb.com 的 /bfs/ 图 → 追加 @1280w_80q.webp 后缀", () => {
		const r = makeRenderer() as AnyRenderer;
		expect(r.compressBiliImageUrl("https://i0.hdslb.com/bfs/new_dyn/abc.jpg")).toBe(
			"https://i0.hdslb.com/bfs/new_dyn/abc.jpg@1280w_80q.webp",
		);
	});

	it("已有 @ 处理后缀 → 替换为统一缩放后缀", () => {
		const r = makeRenderer() as AnyRenderer;
		expect(r.compressBiliImageUrl("https://i2.hdslb.com/bfs/album/x.png@600w_1c.webp")).toBe(
			"https://i2.hdslb.com/bfs/album/x.png@1280w_80q.webp",
		);
	});

	it("保留 query 串", () => {
		const r = makeRenderer() as AnyRenderer;
		expect(r.compressBiliImageUrl("https://i0.hdslb.com/bfs/x.jpg?foo=bar")).toBe(
			"https://i0.hdslb.com/bfs/x.jpg@1280w_80q.webp?foo=bar",
		);
	});

	it("静态 s1.hdslb.com / 非 /bfs/ / 第三方域 → 原样不动", () => {
		const r = makeRenderer() as AnyRenderer;
		expect(r.compressBiliImageUrl("https://s1.hdslb.com/bfs/static/cap.png")).toBe(
			"https://s1.hdslb.com/bfs/static/cap.png",
		);
		expect(r.compressBiliImageUrl("https://i0.hdslb.com/other/x.jpg")).toBe(
			"https://i0.hdslb.com/other/x.jpg",
		);
		expect(r.compressBiliImageUrl("https://example.com/a.jpg")).toBe("https://example.com/a.jpg");
	});

	it("fetchImageAsDataUrl 用缩放后的 URL 作缓存键(命中即不发 fetch)", async () => {
		const r = makeRenderer() as AnyRenderer;
		const resized = "https://i0.hdslb.com/bfs/new_dyn/huge.jpg@1280w_80q.webp";
		r.imageCache.set(resized, { dataUrl: "data:resized", updatedAt: 1 });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const out = await r.fetchImageAsDataUrl("https://i0.hdslb.com/bfs/new_dyn/huge.jpg");
		expect(out).toBe("data:resized");
		expect(fetchMock).not.toHaveBeenCalled();
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
		r.imageCache.set("https://i0.hdslb.com/a.png", { dataUrl: "data:cached", updatedAt: 1 });
		const out = await r.fetchImageAsDataUrl("https://i0.hdslb.com/a.png");
		expect(out).toBe("data:cached");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(r.imageCache.get("https://i0.hdslb.com/a.png").updatedAt).toBeGreaterThan(1);
	});

	it("fetch 成功 → 返回 data URL 并写入缓存", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: "image/png", body: new Uint8Array([65]) })),
		);
		const out = await r.fetchImageAsDataUrl("https://i0.hdslb.com/a.png");
		expect(out).toBe(`data:image/png;base64,${Buffer.from([65]).toString("base64")}`);
		expect(r.imageCache.has("https://i0.hdslb.com/a.png")).toBe(true);
	});

	it("响应无 content-type → 回退到 URL 后缀的 mime", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: null })),
		);
		const out = await r.fetchImageAsDataUrl("https://i0.hdslb.com/pic.webp");
		expect(out.startsWith("data:image/webp;base64,")).toBe(true);
	});

	it("响应 not ok → 抛 HTTP 错误", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ ok: false, status: 404, statusText: "Not Found" })),
		);
		await expect(r.fetchImageAsDataUrl("https://i0.hdslb.com/missing.png")).rejects.toThrow(
			"HTTP 404",
		);
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
		const html =
			'<html><body><img src="https://i0.hdslb.com/a.png"><img src="/local/b.png"></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).toContain("data:image/png;base64,");
		expect(out).not.toContain("https://i0.hdslb.com/a.png");
		expect(out).toContain("/local/b.png"); // 相对路径保留
	});

	it("<style> 内 url(https://...) 内联替换", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: "image/png" })),
		);
		const html =
			'<html><head><style>.bg{background:url("https://i0.hdslb.com/bg.png")}</style></head><body></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).toContain("data:image/png;base64,");
		expect(out).not.toContain("https://i0.hdslb.com/bg.png");
	});

	// ②5:预取失败**不得保留原 URL**(否则 puppeteer 自行抓取,违背零外部引用)。
	it("单图 fetch 失败 → 换占位、不保留原 URL,不抛", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network");
			}),
		);
		const html = '<html><body><img src="https://i0.hdslb.com/x.png"></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).not.toContain("https://i0.hdslb.com/x.png");
		expect(out).toContain("data:image/gif;base64,R0lGOD"); // BLOCKED 占位前缀
	});

	// ②5:@import / image-set 也是 SSRF 残口,非白名单必须换占位。
	it("CSS @import / image-set 非白名单 → 换占位,不留原 URL", async () => {
		const r = makeRenderer() as AnyRenderer;
		const html =
			'<html><head><style>@import "http://169.254.169.254/meta.css"; .a{background:image-set("http://10.0.0.1/x.png" 1x)}</style></head><body></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).not.toContain("169.254.169.254");
		expect(out).not.toContain("10.0.0.1");
	});
});

// ---------------------------------------------------------------------------
// IM1 SSRF 白名单 + IM2 大小上限
// ---------------------------------------------------------------------------

describe("ImageRenderer — IM1 SSRF 白名单", () => {
	const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

	it("fetchImageAsDataUrl:非白名单域 → 抛 SSRF,且根本不发 fetch", async () => {
		const r = makeRenderer() as AnyRenderer;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(r.fetchImageAsDataUrl("https://evil.example.com/a.png")).rejects.toThrow(
			/SSRF blocked/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetchImageAsDataUrl:IP 字面量(169.254.169.254 元数据)→ 抛 SSRF", async () => {
		const r = makeRenderer() as AnyRenderer;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(r.fetchImageAsDataUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
			/SSRF blocked/,
		);
		await expect(r.fetchImageAsDataUrl("http://127.0.0.1:8080/x")).rejects.toThrow(/SSRF blocked/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("inlineRemoteImages:非白名单 <img> → 换透明占位,不保留原 URL、不发 fetch", async () => {
		const r = makeRenderer() as AnyRenderer;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const html = '<html><body><img src="http://169.254.169.254/x.png"></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).not.toContain("169.254.169.254"); // 原 URL 必须消失
		expect(out).toContain(PLACEHOLDER);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("inlineRemoteImages:非白名单 CSS url() → 换占位", async () => {
		const r = makeRenderer() as AnyRenderer;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const html =
			'<html><head><style>.b{background:url("http://10.0.0.5/p.png")}</style></head><body></body></html>';
		const out = await r.inlineRemoteImages(html);
		expect(out).not.toContain("10.0.0.5");
		expect(out).toContain(PLACEHOLDER);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("ImageRenderer — IM2 远端图大小上限", () => {
	it("Content-Length 声明超 8MB → 抛,不下载", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: "image/png", contentLength: 9 * 1024 * 1024 })),
		);
		await expect(r.fetchImageAsDataUrl("https://i0.hdslb.com/huge.png")).rejects.toThrow(
			/image too large/,
		);
	});

	it("无 Content-Length 但实体字节超限(arrayBuffer 回退路径)→ 抛", async () => {
		const r = makeRenderer() as AnyRenderer;
		const big = new Uint8Array(9 * 1024 * 1024);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => fakeResponse({ contentType: "image/png", body: big })),
		);
		await expect(r.fetchImageAsDataUrl("https://i0.hdslb.com/big.png")).rejects.toThrow(
			/exceeds .* bytes/,
		);
	});

	it("正常小图(白名单 + 未超限)仍成功内联", async () => {
		const r = makeRenderer() as AnyRenderer;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				fakeResponse({ contentType: "image/png", body: new Uint8Array([1, 2, 3, 4]) }),
			),
		);
		const out = await r.fetchImageAsDataUrl("https://i0.hdslb.com/ok.png");
		expect(out.startsWith("data:image/png;base64,")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// updateConfig — 仅在配置变化时记录(预览切卡片类型不刷日志)
// ---------------------------------------------------------------------------

describe("ImageRenderer.updateConfig", () => {
	const BASE: ImageRendererConfig = {
		cardColorStart: "#000000",
		cardColorEnd: "#ffffff",
		font: "sans-serif",
		showPopularity: true,
		showArea: true,
		showFans: true,
	};

	function makeWithSpyLogger(config: ImageRendererConfig) {
		const info = vi.fn();
		const ctx: ServiceContext = {
			logger: { debug() {}, info, warn() {}, error() {} },
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
		};
		const puppeteer = { page: async () => ({}) as never } as unknown as PuppeteerLike;
		const r = new ImageRenderer({ serviceCtx: ctx, puppeteer, config });
		return { r, info };
	}

	it("配置实际变化 → 记录一次", () => {
		const { r, info } = makeWithSpyLogger({ ...BASE });
		r.updateConfig({ ...BASE, cardColorStart: "#111111" });
		expect(info).toHaveBeenCalledTimes(1);
	});

	it("相同配置重复 updateConfig → 不记录(切卡片类型时样式没变)", () => {
		const { r, info } = makeWithSpyLogger({ ...BASE });
		r.updateConfig({ ...BASE });
		r.updateConfig({ ...BASE });
		expect(info).not.toHaveBeenCalled();
	});

	it("回归:只改 glassOpacity(渐变色未变)→ 日志报实际改的字段,不误报渐变色", () => {
		const { r, info } = makeWithSpyLogger({ ...BASE });
		r.updateConfig({ ...BASE, glassOpacity: 0.5 });
		expect(info).toHaveBeenCalledTimes(1);
		const [msg] = info.mock.calls[0] as [string];
		expect(msg).toContain("glassOpacity");
		expect(msg).not.toContain("cardColorStart");
		expect(msg).not.toContain("cardColorEnd");
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

/**
 * updateConfig 的热更日志:可选字段被清除时(玻璃片透明度关掉 → undefined),
 * 不能把裸 `undefined` 插进日志 —— 主人看到的是「glassOpacity=undefined」,读不出
 * 「回到各卡内置基线」这个真实含义。backgroundImage 早就打成 (set)/(none),这两个
 * 可选字段照做。
 */
function makeLoggingRenderer(
	infos: string[],
	config: Partial<ImageRendererConfig> = {},
): ImageRenderer {
	const r = makeRenderer(config) as AnyRenderer;
	r.logger = {
		debug() {},
		info: (m: string) => infos.push(m),
		warn() {},
		error() {},
	};
	return r as ImageRenderer;
}

const BASE_CONFIG: ImageRendererConfig = {
	cardColorStart: "#000000",
	cardColorEnd: "#ffffff",
	font: "sans-serif",
	showPopularity: true,
	showArea: true,
	showFans: true,
};

describe("ImageRenderer.updateConfig 热更日志", () => {
	it("清除玻璃片透明度打印「默认」而不是裸 undefined", () => {
		const infos: string[] = [];
		const r = makeLoggingRenderer(infos, { glassOpacity: 0.82 });

		r.updateConfig({ ...BASE_CONFIG, glassOpacity: undefined });

		expect(infos).toHaveLength(1);
		expect(infos[0]).toContain("glassOpacity=(默认)");
		expect(infos[0]).not.toContain("undefined");
	});

	it("清除完全透明开关同样不打印裸 undefined", () => {
		const infos: string[] = [];
		const r = makeLoggingRenderer(infos, { glassClear: true });

		r.updateConfig({ ...BASE_CONFIG, glassClear: undefined });

		expect(infos[0]).toContain("glassClear=(默认)");
		expect(infos[0]).not.toContain("undefined");
	});

	it("设了值仍然照常打印实际值", () => {
		const infos: string[] = [];
		const r = makeLoggingRenderer(infos, {});

		r.updateConfig({ ...BASE_CONFIG, glassOpacity: 0.5 });

		expect(infos[0]).toContain("glassOpacity=0.5");
	});
});

/**
 * 预览渲染器(routes/cards.ts)每收到一次预览请求就 updateConfig 一遍 —— 主人在
 * Cards 页拖一格滑块就是一条 INFO「配置已更新」,既刷屏又像是"已经保存了",而真正
 * 落盘生效的那条(推送渲染器热重载)反倒淹在里面。预览实例把这条日志降到 debug:
 * 排障时仍拿得到,平时不冒充保存。
 */
describe("ImageRenderer.updateConfig 预览实例静默", () => {
	it("quietConfigUpdates 时热更日志走 debug、不打 info", () => {
		const infos: string[] = [];
		const debugs: string[] = [];
		const r = makeRenderer({ glassOpacity: 0.82 }, { quietConfigUpdates: true }) as AnyRenderer;
		r.logger = {
			debug: (m: string) => debugs.push(m),
			info: (m: string) => infos.push(m),
			warn() {},
			error() {},
		};

		(r as ImageRenderer).updateConfig({ ...BASE_CONFIG, glassOpacity: 0.4 });

		expect(infos).toHaveLength(0);
		expect(debugs[0]).toContain("glassOpacity=0.4");
	});

	it("默认(推送渲染器)仍然打 info —— 那才是真的生效了", () => {
		const infos: string[] = [];
		const r = makeLoggingRenderer(infos, { glassOpacity: 0.82 });

		r.updateConfig({ ...BASE_CONFIG, glassOpacity: 0.4 });

		expect(infos[0]).toContain("glassOpacity=0.4");
	});
});

// ---------------------------------------------------------------------------
// generateLiveCard 自定义封面(liveCoverImage 经 resolveAsset 解析进模板)
// ---------------------------------------------------------------------------

describe("generateLiveCard 自定义封面", () => {
	function makeCapturingPuppeteer() {
		const captured = { html: "" };
		const page = {
			setContent: async (html: string) => {
				captured.html = html;
			},
			waitForFunction: async () => undefined,
			$: async () => ({
				boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
				dispose: async () => {},
			}),
			screenshot: async () => Buffer.from("fake-jpeg"),
			close: async () => {},
		};
		return { captured, puppeteer: { page: async () => page } as unknown as PuppeteerLike };
	}

	const liveApiData = {
		title: "标题",
		area_name: "分区",
		user_cover: "data:image/png;base64,API-COVER",
		keyframe: "data:image/png;base64,API-KEYFRAME",
		description: "",
		online: 1,
		live_time: "2026-01-01 00:00:00",
	};

	it("colorOptions.liveCoverImage(资产 id)→ resolveAsset 解析成 data URL 进封面", async () => {
		const { captured, puppeteer } = makeCapturingPuppeteer();
		const renderer = makeRenderer(
			{},
			{
				puppeteer,
				resolveAsset: async (id: string) => `data:image/png;base64,ASSET-${id}`,
			},
		);
		await renderer.generateLiveCard(
			liveApiData,
			"示例UP",
			"data:image/png;base64,FACE",
			{ likedNum: 0, watchedNum: "1", fansNum: 1, fansChanged: "" } as never,
			1,
			{ liveCoverImage: "cover-asset-1" },
		);
		expect(captured.html).toContain("data:image/png;base64,ASSET-cover-asset-1");
		expect(captured.html).not.toContain("API-COVER");
	});

	it("未配置 liveCoverImage → 封面维持 API 来源", async () => {
		const { captured, puppeteer } = makeCapturingPuppeteer();
		const renderer = makeRenderer({}, { puppeteer });
		await renderer.generateLiveCard(
			liveApiData,
			"示例UP",
			"data:image/png;base64,FACE",
			{ likedNum: 0, watchedNum: "1", fansNum: 1, fansChanged: "" } as never,
			1,
			{},
		);
		expect(captured.html).toContain("API-COVER");
	});
});
