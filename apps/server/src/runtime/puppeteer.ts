/**
 * Standalone-side `PuppeteerLike` adapter — wraps `puppeteer-core` (the lean
 * variant that does NOT bundle a chromium binary) so the operator brings their
 * own. The browser binary path is resolved at boot from
 * `bootstrap.chromePath` (BN_CHROME_PATH env / chromePath yaml field). When
 * unset, getPuppeteer() returns null and the cards/preview route reports 503.
 *
 * Browsers are lazy-launched on first use and reused across requests; calling
 * dispose() closes the shared browser. PageLike returned by `page()` resolves
 * to a fresh page each call, with `close()` releasing it back to the pool.
 */

import { existsSync } from "node:fs";
import type {
	BoundingBox,
	ElementHandleLike,
	PageLike,
	PageOptions,
	PuppeteerLike,
	ScreenshotOptions,
	SetContentOptions,
	WaitForFunctionOptions,
} from "@bilibili-notify/image";
import { createSerialGate, type Logger } from "@bilibili-notify/internal";
import puppeteer from "puppeteer-core";

export interface ResolveChromePathOptions {
	/** 路径存在性判定,默认 `fs.existsSync`;注入以便单测。 */
	exists?: (path: string) => boolean;
	/** 目标平台,默认 `process.platform`;注入以便单测跨平台候选表。 */
	platform?: NodeJS.Platform;
}

/**
 * 逐 OS 的 Chrome / Chromium 常见安装路径候选表。顺序即优先级 —— 同一平台多个
 * 浏览器都在时取靠前者。仅覆盖默认安装位置;非标准位置请 operator 显式填 chromePath。
 */
const CHROME_CANDIDATES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	],
	win32: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	],
};

/**
 * 解析最终使用的浏览器可执行路径。优先级:**显式 `chromePath`(非空) > 按平台探测
 * 命中的第一个候选 > null**。显式路径即使探测不到也原样返回 —— operator 说用哪个
 * 就用哪个,路径写错时由 puppeteer 启动报清晰错误,而非静默换浏览器造成困惑。
 */
export function resolveChromePath(
	explicit: string | undefined,
	options: ResolveChromePathOptions = {},
): string | null {
	const exists = options.exists ?? existsSync;
	const platform = options.platform ?? process.platform;
	const trimmed = explicit?.trim();
	if (trimmed) return trimmed;
	const candidates = CHROME_CANDIDATES[platform] ?? [];
	for (const candidate of candidates) {
		if (exists(candidate)) return candidate;
	}
	return null;
}

/** wrapPage 实际消费的页面最小面 —— 真 puppeteer Page 结构性满足,单测注入假实现。 */
export interface PageHandle {
	setContent(html: string, options?: SetContentOptions): Promise<void>;
	waitForFunction(
		// biome-ignore lint/suspicious/noExplicitAny: mirrors puppeteer's waitForFunction overload
		fn: string | ((...args: any[]) => unknown),
		options?: WaitForFunctionOptions,
	): Promise<unknown>;
	$(selector: string): Promise<ElementHandleLike | null>;
	screenshot(options?: ScreenshotOptions): Promise<Buffer | Uint8Array>;
	close(): Promise<void>;
}

/** adapter 消费的浏览器最小面 —— close 杀本地进程,disconnect 只断远端连接。 */
export interface BrowserHandle {
	readonly connected: boolean;
	newPage(): Promise<PageHandle>;
	close(): Promise<void>;
	disconnect(): void | Promise<void>;
}

export interface BrowserLaunchOptions {
	executablePath: string;
	headless: boolean;
	args: string[];
	defaultViewport: { width: number; height: number; deviceScaleFactor: number };
}

export interface BrowserConnectOptions {
	/** browserless 等直接暴露的 DevTools WS 端点(`ws://…`)。 */
	browserWSEndpoint?: string;
	/** 原生 chromium `--remote-debugging-port` 的 HTTP 端点(`http://…`),puppeteer 自己去换 WS 地址。 */
	browserURL?: string;
	defaultViewport: { width: number; height: number; deviceScaleFactor: number };
}

/** puppeteer-core 门面。生产用默认实现;单测注入假 launcher 测生命周期。 */
export interface BrowserLauncher {
	launch(options: BrowserLaunchOptions): Promise<BrowserHandle>;
	connect(options: BrowserConnectOptions): Promise<BrowserHandle>;
}

const defaultLauncher: BrowserLauncher = {
	// 真 Browser/Page 结构性满足 BrowserHandle/PageHandle,但 puppeteer 的重载签名
	// (screenshot 的 base64 重载等)让 TS 无法自动收窄 —— 在这唯一边界断言一次。
	launch: (options) => puppeteer.launch(options) as unknown as Promise<BrowserHandle>,
	connect: (options) => puppeteer.connect(options) as unknown as Promise<BrowserHandle>,
};

/** 空闲多久后自动关浏览器的默认值(5 分钟)。 */
export const DEFAULT_CHROME_IDLE_MS = 300_000;

export interface PuppeteerAdapterOptions {
	/** 本地浏览器二进制路径。`chromeEndpoint` 未设时必填。 */
	chromePath?: string;
	/**
	 * 远程浏览器端点,设了就走 `puppeteer.connect` 而非本地 launch(优先于
	 * `chromePath`)。`ws://…` 直连 DevTools WS(browserless 等);`http://…` 为
	 * `--remote-debugging-port` 的 HTTP 端点,由 puppeteer 换取 WS 地址。
	 */
	chromeEndpoint?: string;
	logger: Logger;
	/**
	 * 最后一次渲染结束后多久自动关掉浏览器(下次渲染懒重启),省常驻内存。
	 * 远程模式下到点只 disconnect 不 close。`0` = 永不自动关(旧行为)。
	 * 缺省 {@link DEFAULT_CHROME_IDLE_MS}。
	 */
	idleTimeoutMs?: number;
	/** 注入 puppeteer-core 门面(单测用);缺省真 puppeteer-core。 */
	launcher?: BrowserLauncher;
}

export interface StandalonePuppeteer extends PuppeteerLike {
	dispose(): Promise<void>;
	/**
	 * 还在排队等渲染的数量。`/status` 拿它回答「是不是卡住了」——
	 * 所有渲染都串行经过同一把闸,这个数持续不为 0 就是推送在堆积。
	 */
	renderQueueDepth(): number;
}

export function createPuppeteerAdapter(opts: PuppeteerAdapterOptions): StandalonePuppeteer {
	const launcher = opts.launcher ?? defaultLauncher;
	const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_CHROME_IDLE_MS;
	let browser: BrowserHandle | null = null;
	let launching: Promise<BrowserHandle> | null = null;
	// 在渲染中的页面数。归零才允许空闲计时器把浏览器关掉。
	let activePages = 0;
	let idleTimer: NodeJS.Timeout | null = null;
	// 串行闸:所有渲染(预览 screenshotHtml + 推送 ImageRenderer)经同一浏览器,冷启动
	// 窗口期并发截图会触发 CDP 竞态把卡片平铺成 2×2(见 internal 的 serial-gate)。串起来即根除。
	const renderGate = createSerialGate();

	function cancelIdleTimer(): void {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	function armIdleTimer(): void {
		if (idleTimeoutMs <= 0) return;
		cancelIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			void closeIdleBrowser();
		}, idleTimeoutMs);
		// 计时器不该拖住进程退出(dispose 也会清它,unref 只是兜底)。
		idleTimer.unref?.();
	}

	// 远程模式:浏览器是别人的(共享的 browserless / headless-shell 容器),
	// 收尾只断自己的连接,绝不 close 把它杀掉。
	const remote = Boolean(opts.chromeEndpoint);

	async function shutdownBrowser(b: BrowserHandle, reason: string): Promise<void> {
		try {
			if (remote) await b.disconnect();
			else await b.close();
		} catch (e) {
			opts.logger.warn(
				`[puppeteer] ${reason} ${remote ? "disconnect" : "close"} failed: ${String(e)}`,
			);
		}
	}

	async function closeIdleBrowser(): Promise<void> {
		// 防御:计时器与新渲染竞态时(page() 尚未走到 cancelIdleTimer)有活跃页就不动,
		// 该页 close 时会重新 arm。
		if (activePages > 0) return;
		const b = browser;
		browser = null;
		if (!b) return;
		opts.logger.info(
			`[puppeteer] 空闲 ${Math.round(idleTimeoutMs / 1000)}s,${
				remote ? "断开远程浏览器连接" : "关闭 chromium 释放内存"
			}(下次渲染自动${remote ? "重连" : "重启"})`,
		);
		await shutdownBrowser(b, "idle");
	}

	/** 一页渲染结束:活跃数减一,归零则起空闲计时。 */
	function onPageClosed(): void {
		activePages -= 1;
		if (activePages === 0) armIdleTimer();
	}

	async function ensure(): Promise<BrowserHandle> {
		if (browser?.connected) return browser;
		if (launching) return launching;
		launching = (async () => {
			// 2x DPI 烤进 launch/connect 的 defaultViewport,而非每页 setViewport —— 冷启动
			// 后多张卡片并发渲染时,per-page setViewport(Emulation.setDeviceMetricsOverride)
			// 在刚启动的浏览器上会与紧随的 captureScreenshot 竞态,deviceScaleFactor 尚未生效
			// 就截图,clip 被按错误倍率放大 → 同一张卡被平铺成 2×2 并裁切(用户报告的
			// 「全家福动态发布第一次启动就 4 连图」)。defaultViewport 在页面诞生即带 dSF=2,
			// 无 setViewport 这一步,竞态消失。
			const defaultViewport = { width: 1280, height: 720, deviceScaleFactor: 2 };
			let b: BrowserHandle;
			if (opts.chromeEndpoint) {
				const endpoint = opts.chromeEndpoint;
				opts.logger.info(`[puppeteer] 连接远程浏览器 · ${endpoint}`);
				b = await launcher.connect(
					endpoint.startsWith("http")
						? { browserURL: endpoint, defaultViewport }
						: { browserWSEndpoint: endpoint, defaultViewport },
				);
			} else if (opts.chromePath) {
				opts.logger.info(`[puppeteer] 启动 chromium · executablePath=${opts.chromePath}`);
				b = await launcher.launch({
					executablePath: opts.chromePath,
					headless: true,
					args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
					defaultViewport,
				});
			} else {
				throw new Error(
					"puppeteer adapter misconfigured: neither chromeEndpoint nor chromePath set",
				);
			}
			browser = b;
			launching = null;
			return b;
		})();
		try {
			return await launching;
		} catch (err) {
			launching = null;
			throw err;
		}
	}

	return {
		renderQueueDepth: () => renderGate.waiting(),
		async page(options?: PageOptions): Promise<PageLike> {
			// 进闸:等上一个渲染(页面 close)后才继续,保证全程并发度为 1。低优先级
			// (链接卡)在正常车道排空之前不放行。
			const release = await renderGate.acquire({ priority: options?.priority });
			cancelIdleTimer();
			try {
				const b = await ensure();
				const p = await b.newPage();
				activePages += 1;
				// 2x DPI(retina / HiDPI 下截图够清晰)由 launch 的 defaultViewport 提供,
				// 页面诞生即带 dSF=2 —— 不再 per-page setViewport。
				return wrapPage(p, release, onPageClosed);
			} catch (err) {
				// 取页失败(启动报错等):立刻放闸,否则后续渲染全卡死。失败也算一次
				// 活动结束 —— 没有活跃页就重新起空闲计时,别让半残浏览器常驻。
				release();
				if (activePages === 0) armIdleTimer();
				throw err;
			}
		},
		async dispose(): Promise<void> {
			cancelIdleTimer();
			const b = browser;
			browser = null;
			launching = null;
			if (b) await shutdownBrowser(b, "dispose");
		},
	};
}

function wrapPage(page: PageHandle, release: () => void, onClosed: () => void): PageLike {
	let closed = false;
	return {
		async setContent(html: string, options?: SetContentOptions) {
			await page.setContent(html, options);
		},
		async waitForFunction(
			// biome-ignore lint/suspicious/noExplicitAny: matches PageLike contract
			fn: string | ((...args: any[]) => unknown),
			options?: WaitForFunctionOptions,
		) {
			return page.waitForFunction(fn, options);
		},
		async $(selector: string): Promise<ElementHandleLike | null> {
			const el = await page.$(selector);
			if (!el) return null;
			return {
				async boundingBox(): Promise<BoundingBox | null> {
					return el.boundingBox();
				},
				async dispose() {
					await el.dispose();
				},
			};
		},
		async screenshot(options?: ScreenshotOptions): Promise<Buffer | Uint8Array> {
			return page.screenshot(options);
		},
		async close() {
			// 幂等:重复 close 不重复放闸/减计数,防活跃页计数被扣穿。
			if (closed) return;
			closed = true;
			// 先放闸再 close:即便 close 抛错(Chrome 崩溃),闸也已释放,后续渲染不被卡死。
			try {
				release();
			} finally {
				try {
					await page.close();
				} finally {
					onClosed();
				}
			}
		},
	};
}
