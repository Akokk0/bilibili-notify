/**
 * Platform-neutral Puppeteer abstraction. The image-engine consumes only this
 * surface; the host runtime wraps the npm `puppeteer-core` package.
 *
 * The signatures intentionally mirror the subset of the real Puppeteer API the
 * renderer actually invokes — see `image-renderer.ts`.
 */

import type { SerialPriority } from "@bilibili-notify/internal";

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
	/**
	 * 不画默认那层白底,让截图带 alpha。⚠️ **`jpeg` 不支持**(它没有 alpha 通道),
	 * 只有 `png` / `webp` 认。
	 *
	 * 压图那一档(`skin/shrink-image.ts`)靠它保住用户背景图的透明:不开的话透明处会
	 * 落到页面底色,而皮肤如果把壁纸**叠**在渐变上(ADR-0014 决策 15 的 🔗 明说这是
	 * 支持的用法),叠出来就是一块实心底而不是透出渐变。
	 */
	omitBackground?: boolean;
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

/**
 * 一次渲染的优先级。`low` = 队列里还有正常优先级的在等就不动 —— 群里谁都能触发的
 * 链接卡走它,推送卡(开播 / 动态)永远不被它挤到后面。与 internal 的 `SerialPriority`
 * 同一组值:渲染器自己那级队列和独立端的浏览器闸都按它排。
 */
export type RenderPriority = SerialPriority;

/**
 * 渲染页发出的这个请求是不是**内嵌内容**。只有 `data:` 地址算 —— 字节就写在地址里,
 * 不出本进程。浏览器适配层的请求闸只看这一个判断:是的不管,不是的一律掐断。
 *
 * 没有主机白名单,也没有协议白名单(`file:`、`blob:`、`about:` 同样不放行):卡里的图
 * 在出卡前都已经由来源抓进图库、再转成 data URL,渲染页不该有任何别的请求。
 */
export function isEmbeddedUrl(url: string): boolean {
	return url.startsWith("data:");
}

/** 渲染页有请求被闸掐断时的回调;参数是被掐断的那个地址。 */
export type BlockedRequestHandler = (url: string) => void;

export interface PageOptions {
	/** 缺省 `normal`。 */
	priority?: RenderPriority;
	/**
	 * 这一页有请求被掐断时叫一次(每个请求一次)。传了它,记账就归调用方;不传,
	 * 适配层自己逐个记日志。
	 */
	onBlockedRequest?: BlockedRequestHandler;
}

/** Puppeteer service facade. `page()` returns a fresh, disposable page each call. */
export interface PuppeteerLike {
	page(options?: PageOptions): Promise<PageLike>;
}
