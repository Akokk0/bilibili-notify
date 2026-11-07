/**
 * 单元测试 — `ImageRenderer` 自己的那点逻辑(时间排版、热更配置的日志、直播卡自定义封面、渲染页拦下请求的记账)。
 *
 * 出卡的 HTML 由各卡种自己的测试钉(`generate-post-card.test.ts` 等);「HTML 里没有会发请求的地址」
 * 由 `zero-network.test.ts` 钉。private 字段经 `(r as any)` 白盒访问。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	ImageRenderer,
	type ImageRendererOptions,
	type ImageRendererSettings,
} from "../image-renderer";
import type { PageOptions, PuppeteerLike } from "../puppeteer";
import type { LiveCardInput } from "../templates/live-card";

// biome-ignore lint/suspicious/noExplicitAny: 测试需访问 private 方法/字段
type AnyRenderer = any;

function makeRenderer(
	config: Partial<ImageRendererSettings> = {},
	extra: Partial<ImageRendererOptions> = {},
): ImageRenderer {
	const ctx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const puppeteer = {
		page: async () => ({}) as never,
	} as unknown as PuppeteerLike;
	const opts: ImageRendererOptions = {
		serviceCtx: ctx,
		puppeteer,
		config: {
			font: "sans-serif",
			...config,
		},
		// 宿主必注入的两个解析回调;缺省解析成空串(= 资产不存在),用例按需覆盖。
		resolveAsset: async () => "",
		resolveFontFace: async () => "",
		timezone: () => "Asia/Shanghai",
		...extra,
	};
	return new ImageRenderer(opts);
}

// ---------------------------------------------------------------------------
// 纯映射:unixTimestampToString
// ---------------------------------------------------------------------------

describe("ImageRenderer 纯映射辅助", () => {
	it("unixTimestampToString 按全局时区排、零填充", () => {
		const r = makeRenderer();
		// 2026-01-02T03:04:05Z → 上海 11:04:05。
		const s = r.unixTimestampToString(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000);
		expect(s).toBe("2026年01月02日 11:04:05");
	});
});

// ---------------------------------------------------------------------------
// updateConfig — 仅在配置变化时记录(预览切卡片类型不刷日志)
// ---------------------------------------------------------------------------

describe("ImageRenderer.updateConfig", () => {
	const BASE: ImageRendererSettings = {
		font: "sans-serif",
	};

	function makeWithSpyLogger(config: ImageRendererSettings) {
		const info = vi.fn();
		const serviceCtx: ServiceContext = {
			logger: { debug() {}, info, warn() {}, error() {} },
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
			signal: new AbortController().signal,
			track: () => {},
		};
		return { r: makeRenderer(config, { serviceCtx }), info };
	}

	it("配置实际变化 → 记录一次", () => {
		const { r, info } = makeWithSpyLogger({ ...BASE });
		r.updateConfig({ ...BASE, font: "serif" });
		expect(info).toHaveBeenCalledTimes(1);
	});

	it("相同配置重复 updateConfig → 不记录(切卡片类型时样式没变)", () => {
		const { r, info } = makeWithSpyLogger({ ...BASE });
		r.updateConfig({ ...BASE });
		r.updateConfig({ ...BASE });
		expect(info).not.toHaveBeenCalled();
	});

	it("回归:只改自带字体(家族名未变)→ 日志只报实际改的那项", () => {
		const { r, info } = makeWithSpyLogger({ ...BASE });
		r.updateConfig({ ...BASE, fontAsset: "font-1" });
		expect(info).toHaveBeenCalledTimes(1);
		const [msg] = info.mock.calls[0] as [string];
		expect(msg).toContain("fontAsset");
		expect(msg).not.toContain("font=");
	});
});

/** 把 info 日志收进数组的渲染器 —— 热更日志那几条共用。 */
function makeLoggingRenderer(
	infos: string[],
	config: Partial<ImageRendererSettings> = {},
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

const BASE_CONFIG: ImageRendererSettings = {
	font: "sans-serif",
};

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
		const r = makeRenderer({ font: "sans-serif" }, { quietConfigUpdates: true }) as AnyRenderer;
		r.logger = {
			debug: (m: string) => debugs.push(m),
			info: (m: string) => infos.push(m),
			warn() {},
			error() {},
		};

		(r as ImageRenderer).updateConfig({ ...BASE_CONFIG, font: "serif" });

		expect(infos).toHaveLength(0);
		expect(debugs[0]).toContain("font=serif");
	});

	it("默认(推送渲染器)仍然打 info —— 那才是真的生效了", () => {
		const infos: string[] = [];
		const r = makeLoggingRenderer(infos, { font: "sans-serif" });

		r.updateConfig({ ...BASE_CONFIG, font: "serif" });

		expect(infos[0]).toContain("font=serif");
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

	/** 来源给的封面:出卡前已存进图库,输入里是引用。 */
	const COVER_REF = `${"c".repeat(64)}.png`;
	const resolveImageRef = async (ref: string) =>
		ref === COVER_REF ? "data:image/png;base64,API-COVER" : undefined;

	const liveInput: LiveCardInput = {
		status: "start",
		creator: { name: "示例UP" },
		title: "标题",
		category: "分区",
		cover: { ref: COVER_REF },
		startedAt: "2025-12-31T16:00:00.000Z",
		currentViewers: 1,
	};

	it("colorOptions.liveCoverImage(资产 id)→ resolveAsset 解析成 data URL 进封面", async () => {
		const { captured, puppeteer } = makeCapturingPuppeteer();
		const renderer = makeRenderer(
			{},
			{
				puppeteer,
				resolveImageRef,
				resolveAsset: async (id: string) => `data:image/png;base64,ASSET-${id}`,
			},
		);
		await renderer.generateLiveCard(liveInput, { liveCoverImage: "cover-asset-1" });
		expect(captured.html).toContain("data:image/png;base64,ASSET-cover-asset-1");
		expect(captured.html).not.toContain("API-COVER");
	});

	it("未配置 liveCoverImage → 封面维持来源给的那张(图库引用解析出来的)", async () => {
		const { captured, puppeteer } = makeCapturingPuppeteer();
		const renderer = makeRenderer({}, { puppeteer, resolveImageRef });
		await renderer.generateLiveCard(liveInput, {});
		expect(captured.html).toContain("API-COVER");
	});
});

// ---------------------------------------------------------------------------
// 渲染页拦下的请求:记日志 + 内部计数(3a-37「出图器零联网」)
// ---------------------------------------------------------------------------

describe("ImageRenderer 渲染页拦下的请求", () => {
	it("一张卡里被拦下的请求汇总成一条警告(几个、去了哪些主机,不带路径与参数),计数照加", async () => {
		const warns: string[] = [];
		// 这一张卡渲染期间,适配层的闸会拦下哪些请求。
		let blockedDuringRender: string[] = [];
		let onBlockedRequest: PageOptions["onBlockedRequest"];
		const page = {
			setContent: async () => {
				for (const url of blockedDuringRender) onBlockedRequest?.(url);
			},
			waitForFunction: async () => undefined,
			$: async () => ({
				boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
				dispose: async () => {},
			}),
			screenshot: async () => Buffer.from("fake-jpeg"),
			close: async () => {},
		};
		const puppeteer: PuppeteerLike = {
			page: async (options) => {
				onBlockedRequest = options?.onBlockedRequest;
				return page;
			},
		};
		const serviceCtx: ServiceContext = {
			logger: { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} },
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
			signal: new AbortController().signal,
			track: () => {},
		};
		const renderer = makeRenderer({}, { puppeteer, serviceCtx });

		// 没有请求被拦下的卡一条不记。
		await renderer.screenshotHtml("<html><body></body></html>");
		expect(onBlockedRequest).toBeTypeOf("function");
		expect(warns).toEqual([]);
		expect((renderer as AnyRenderer).blockedRequestCount).toBe(0);

		blockedDuringRender = [
			"https://example.invalid/a.png?token=1",
			"https://example.invalid/b.png",
			"file:///etc/hosts",
		];
		await renderer.screenshotHtml("<html><body></body></html>");

		expect((renderer as AnyRenderer).blockedRequestCount).toBe(3);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("渲染页拦下 3 个请求");
		// 同一台主机只报一次;没有主机的(`file:`)报协议。
		expect(warns[0]?.split("example.invalid")).toHaveLength(2);
		expect(warns[0]).toContain("file:");
		expect(warns[0]).not.toContain("token");
		expect(warns[0]).not.toContain("a.png");
		expect(warns[0]).not.toContain("/etc/hosts");

		// 下一张卡从头数,不把上一张的带过来。
		blockedDuringRender = [];
		await renderer.screenshotHtml("<html><body></body></html>");
		expect(warns).toHaveLength(1);
	});
});
