/**
 * AstrBot sidecar 侧的 `PuppeteerLike` 适配器 —— 包装 `puppeteer-core`(精简版,
 * **不**自带 chromium 二进制,由 operator 自备)。浏览器路径解析顺序见
 * {@link resolveChromePath}:显式 `chromePath`(插件配置 / `BN_SIDECAR_CHROME_PATH`)
 * 优先,缺省时按 OS 探测常见安装位置,都没有则返回 null → 卡片渲染降级纯文字。
 *
 * 与独立端 `apps/server/src/runtime/puppeteer.ts` 同构:浏览器首次使用时懒启动并
 * 跨请求复用,`dispose()` 关闭共享浏览器;`page()` 每次返回新页面,`close()` 释放。
 */

import { existsSync } from "node:fs";
import type {
	BoundingBox,
	ElementHandleLike,
	PageLike,
	PuppeteerLike,
	ScreenshotOptions,
	SetContentOptions,
	WaitForFunctionOptions,
} from "@bilibili-notify/image";
import type { Logger } from "@bilibili-notify/internal";
import type { Browser, Page } from "puppeteer-core";
import puppeteer from "puppeteer-core";

/**
 * 逐 OS 的 Chrome / Chromium 常见安装路径候选表。顺序即优先级 —— 同一平台上若
 * 多个浏览器都在,取靠前者。仅覆盖默认安装位置;非标准位置请由 operator 显式
 * 填 `chromePath`。
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

export interface ResolveChromePathOptions {
	/** 路径存在性判定,默认 `fs.existsSync`;注入以便单测。 */
	exists?: (path: string) => boolean;
	/** 目标平台,默认 `process.platform`;注入以便单测跨平台候选表。 */
	platform?: NodeJS.Platform;
}

/**
 * 解析最终使用的浏览器可执行路径。
 *
 * 优先级:**显式 `chromePath`(非空) > 按平台探测命中的第一个候选 > null**。
 * 显式路径即使探测不到也原样返回 —— operator 说用哪个就用哪个,路径写错时由
 * puppeteer 启动报清晰错误,而非静默换一个浏览器造成困惑。返回 null 时上层
 * 不构造 ImageRenderer,卡片推送降级纯文字。
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

export interface PuppeteerAdapterOptions {
	chromePath: string;
	logger: Logger;
}

export interface SidecarPuppeteer extends PuppeteerLike {
	dispose(): Promise<void>;
}

export function createPuppeteerAdapter(opts: PuppeteerAdapterOptions): SidecarPuppeteer {
	let browser: Browser | null = null;
	let launching: Promise<Browser> | null = null;

	async function ensure(): Promise<Browser> {
		if (browser?.connected) return browser;
		if (launching) return launching;
		launching = (async () => {
			opts.logger.info(`[puppeteer] 启动 chromium · executablePath=${opts.chromePath}`);
			const b = await puppeteer.launch({
				executablePath: opts.chromePath,
				headless: true,
				args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
			});
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
		async page(): Promise<PageLike> {
			const b = await ensure();
			const p = await b.newPage();
			// 2x DPI,卡片截图在 retina / HiDPI 下保留足够栅格细节(与独立端一致)。
			await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
			return wrapPage(p);
		},
		async dispose(): Promise<void> {
			const b = browser;
			browser = null;
			launching = null;
			if (b) {
				try {
					await b.close();
				} catch (e) {
					opts.logger.warn(`[puppeteer] close failed: ${String(e)}`);
				}
			}
		},
	};
}

function wrapPage(page: Page): PageLike {
	return {
		async setContent(html: string, options?: SetContentOptions) {
			await page.setContent(html, options);
		},
		async waitForFunction(
			// biome-ignore lint/suspicious/noExplicitAny: matches PageLike contract
			fn: string | ((...args: any[]) => unknown),
			options?: WaitForFunctionOptions,
		) {
			// biome-ignore lint/suspicious/noExplicitAny: puppeteer-core's overload typing
			return page.waitForFunction(fn as any, options);
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
			// PageLike 契约无 encoding 字段 → 始终走二进制重载;经 unknown 桥接 union。
			const result = await page.screenshot(options as never);
			return result as unknown as Buffer | Uint8Array;
		},
		async close() {
			await page.close();
		},
	};
}
