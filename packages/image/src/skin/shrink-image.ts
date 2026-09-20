/**
 * 把一张太大的图压进 CSS 自定义属性的 **2 MiB 上限**(见 `knob-assets.ts` 的
 * {@link CSS_CUSTOM_PROPERTY_MAX_CHARS})。
 *
 * **用 Chrome 自己当编码器。** 出图本来就必须有一个浏览器,而它的 `screenshot` 支持
 * `type: "webp"` + `quality` —— 于是「解码 → 缩放 → 重编码」这三件事一次 `setContent`
 * 就都做完了,**不引入任何新依赖**。这一点在本项目是硬要求:server 是自包含 bundle,
 * 旁边没有 node_modules,凡是靠 `__dirname` 读自己包内文件的编码器(wasm / 原生 .node)
 * 内联进去都会在**运行期**才炸,而构建全绿。
 *
 * **透明保得住**:截图开 `omitBackground`(puppeteer 把页面默认底色覆写成全透明),
 * 而 webp 有 alpha 通道 —— 所以皮肤把壁纸**叠**在渐变上那种用法(ADR-0014 决策 15 的
 * 🔗 明说支持)压完照样成立。⚠️ 这一档**只有 png / webp 认**,`jpeg` 没有 alpha,
 * 换格式的话透明会当场变黑边。没超上限的图一个字节都不动。
 *
 * 阶梯从宽到窄逐档试,**第一档就是为了「基本不损画质」**;实在压不进去回 `null`,
 * 由调用方报出来(别静默)。
 */

import type { PuppeteerLike } from "../puppeteer";

/**
 * 一档 = 一次「缩到多宽 + 用多高的质量重编码」。
 *
 * ⚠️ `width` 是 **CSS px**,而浏览器按 `deviceScaleFactor` 起(本项目是 2),所以出来的
 * 栅格是它的两倍宽 —— 2026-09-20 实测:800×800 的源图走第一档出来是 1600×1600。
 * 对真实的大图(照片通常 1500–3000px 宽)这一档是**降采样**,正合适;对「尺寸小但字节大」
 * 的源(噪点图)则是放大一倍,白费字节。认下这个:端口里没有视口/缩放这一档,而阶梯
 * 反正会一路收到预算之内。要改先给 `PageLike` 开一扇设视口的门,别在这儿按 2 硬除。
 */
interface Step {
	width: number;
	quality: number;
}

/**
 * 越往后越狠。最后一档窄到几乎必然塞得进 —— 留着它是为了「宁可糊一点也要画出来」,
 * 而不是让主人对着一张空卡片猜。
 */
const LADDER: readonly Step[] = [
	{ width: 1200, quality: 82 },
	{ width: 900, quality: 72 },
	{ width: 640, quality: 62 },
	{ width: 440, quality: 50 },
];

/** 渲染不出来(图损坏 / 格式不认)时 Chrome 画的是一个小破图标,别把它当成压好的图。 */
const MIN_RENDERED_PX = 8;

const SETCONTENT_TIMEOUT_MS = 15_000;

export async function shrinkImageForCssVar(
	pup: PuppeteerLike,
	dataUrl: string,
	budgetChars: number,
): Promise<string | null> {
	for (const step of LADDER) {
		const out = await encodeOnce(pup, dataUrl, step);
		if (out !== null && out.length <= budgetChars) return out;
	}
	return null;
}

async function encodeOnce(pup: PuppeteerLike, dataUrl: string, step: Step): Promise<string | null> {
	const page = await pup.page();
	try {
		// `max-width` 而不是 `width`:比这一档还窄的图不许被放大 —— 放大既不省字节,
		// 又把本来清楚的图糊掉。
		await page.setContent(
			`<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
				// 底色留空,配合 `omitBackground` 才透得过去 —— 写一句 `background:#fff`
				// 就等于把 alpha 焊死成白。
				`html,body{margin:0;padding:0;background:transparent}` +
				`img{display:block;max-width:${step.width}px;height:auto}` +
				`</style></head><body><img src="${dataUrl}"></body></html>`,
			{ waitUntil: "load", timeout: SETCONTENT_TIMEOUT_MS },
		);
		const el = await page.$("img");
		const box = await el?.boundingBox();
		await el?.dispose();
		if (!box || box.width < MIN_RENDERED_PX || box.height < MIN_RENDERED_PX) return null;
		const bytes = await page.screenshot({
			type: "webp",
			quality: step.quality,
			omitBackground: true,
			clip: { x: box.x, y: box.y, width: box.width, height: box.height },
		});
		return `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`;
	} finally {
		await page.close();
	}
}
