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

export interface PuppeteerAdapterOptions {
	chromePath: string;
	logger: Logger;
}

export interface StandalonePuppeteer extends PuppeteerLike {
	dispose(): Promise<void>;
}

export function createPuppeteerAdapter(opts: PuppeteerAdapterOptions): StandalonePuppeteer {
	let browser: Browser | null = null;
	let launching: Promise<Browser> | null = null;

	async function ensure(): Promise<Browser> {
		if (browser && browser.connected) return browser;
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
			// puppeteer-core's screenshot has overloads (Uint8Array | string when
			// encoding: "base64"). Our PageLike contract doesn't carry an encoding
			// field so we always end up on the binary overload — cast through
			// unknown to bridge the union.
			const result = await page.screenshot(options as never);
			return result as unknown as Buffer | Uint8Array;
		},
		async close() {
			await page.close();
		},
	};
}
