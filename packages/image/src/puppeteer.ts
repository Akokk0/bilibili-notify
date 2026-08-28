/**
 * Platform-neutral Puppeteer abstraction. The image-engine consumes only this
 * surface; concrete adapters wrap either the koishi puppeteer service plugin
 * (koishi shell) or the npm `puppeteer` package directly (standalone runtime).
 *
 * The signatures intentionally mirror the subset of the real Puppeteer API the
 * renderer actually invokes — see `image-renderer.ts`.
 */

export interface BoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenshotClip {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SetContentOptions {
	// puppeteer-core 25 起 setContent 不再支持 networkidle0/2,契约同步收窄。
	waitUntil?: "load" | "domcontentloaded";
	timeout?: number;
}

export interface WaitForFunctionOptions {
	timeout?: number;
}

export interface ScreenshotOptions {
	type?: "png" | "jpeg" | "webp";
	quality?: number;
	fullPage?: boolean;
	clip?: ScreenshotClip;
}

/** Element handle returned by {@link PageLike.$}. */
export interface ElementHandleLike {
	boundingBox(): Promise<BoundingBox | null>;
	dispose(): Promise<void>;
}

/** A puppeteer Page facade. Only the methods the renderer needs are exposed. */
export interface PageLike {
	setContent(html: string, options?: SetContentOptions): Promise<void>;
	waitForFunction(
		pageFunction:
			| string
			// biome-ignore lint/suspicious/noExplicitAny: mirrors puppeteer's waitForFunction overload — args type is opaque to the caller
			| ((...args: any[]) => unknown),
		options?: WaitForFunctionOptions,
	): Promise<unknown>;
	$(selector: string): Promise<ElementHandleLike | null>;
	screenshot(options?: ScreenshotOptions): Promise<Buffer | Uint8Array>;
	close(): Promise<void>;
}

/** Puppeteer service facade. `page()` returns a fresh, disposable page each call. */
export interface PuppeteerLike {
	page(): Promise<PageLike>;
}
