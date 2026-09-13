/**
 * **卡片皮肤**的 CSS 清洗层(ADR-0014 决策 13)—— dashboard 皮肤方言按**块**收窄。
 *
 * 核心与 dashboard 同一份实现(`skins/scoped-css.ts`),这里只给参数。与 dashboard
 * 刻意不同的两处:
 *
 * - **`@keyframes` 不放行**:卡片是截图,静态的;动画一帧都画不出来,只拖慢渲染。
 * - **宿主 opacity 不设下限**:那道闸收的是「看不见却点得到」的 UI 欺骗,而一张 PNG
 *   上没有能点的东西 —— 照抄反而把「淡淡的水印」这种正经写法堵死。
 *
 * 相同的红线一条不松:`url()`、转义写法、`@import`、外部 URL 任何情况下不放行(puppeteer
 * 是 `--no-sandbox` 跑在 server 旁边的,皮肤包又是要分享的);`position` 只归伪元素;
 * 选择器每一段都得挂着挂点。
 *
 * **存盘形态与 dashboard 一样:按 hook 存**(`[data-bn="self"]{…}`)。翻译成真实选择器
 * 是渲染器(`packages/image`)的事 —— 内部 class 怎么重构都不固化进存量皮肤。
 */

import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FRAME_HOOKS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_SELF_HOOK,
	type CardSkinKind,
} from "@bilibili-notify/internal";
import {
	type SanitizeCssResult,
	type ScopedCssOptions,
	sanitizeScopedCss,
} from "../skins/scoped-css.js";

export type { SanitizeCssResult } from "../skins/scoped-css.js";

/** 两处共用的那几格:卡片皮肤的 CSS 一律这个规格。 */
const CARD_SCOPE = {
	allowKeyframes: false,
	maxBytes: CARD_SKIN_LIMITS.maxCssBytes,
	hostOpacityFloor: null,
} satisfies Omit<ScopedCssOptions, "hooks">;

/** 根块(卡片外框)的两层挂点:外层渐变 / 背景图,内层玻璃。 */
const FRAME_HOOKS: ReadonlySet<string> = new Set(Object.keys(CARD_SKIN_FRAME_HOOKS));

export interface CardBlockCssOptions {
	kind: CardSkinKind;
	/** 内置块名;缺省 = 自定义块(只有 `self`,没有内部挂点)。 */
	builtin?: string;
}

/**
 * 一个块的 CSS。允许的挂点 = `self`(块自己)∪ 该内置块的内部挂点。
 *
 * 内部挂点**按块分**是要紧的:给 `live/header` 写 `[data-bn="price"]`(SC 卡金额块的
 * 挂点)必须整条丢掉 —— 不然挂点契约就从「这个块内部有什么」松成「全仓所有挂点」,
 * 而渲染器真把它翻出去的话,一个块的 CSS 就摸得到另一个块。
 */
export function sanitizeCardBlockCss(input: string, opts: CardBlockCssOptions): SanitizeCssResult {
	const catalogue = CARD_SKIN_BUILTIN_BLOCKS[opts.kind];
	const entry = opts.builtin === undefined ? undefined : catalogue[opts.builtin];
	const hooks = new Set<string>([CARD_SKIN_SELF_HOOK]);
	if (entry) for (const hook of Object.keys(entry.hooks)) hooks.add(hook);
	const res = sanitizeScopedCss(input, { ...CARD_SCOPE, hooks });
	// 认不出的块名只按 `self` 洗,但**不静默**:块名打错时作者会看着一堆「不在 hook
	// 白名单」纳闷,而真正的毛病在块名上。(形状那道门 `parseCardSkin` 会单独拒收它。)
	if (res.ok && opts.builtin !== undefined && !entry) {
		res.warnings.unshift(
			`${opts.kind} 卡没有叫「${opts.builtin}」的内置块,这段 CSS 只按 self 清洗`,
		);
	}
	return res;
}

/** 根块(卡片外框)的 CSS:挂点只有 `frame` / `glass`。 */
export function sanitizeCardFrameCss(input: string): SanitizeCssResult {
	return sanitizeScopedCss(input, { ...CARD_SCOPE, hooks: FRAME_HOOKS });
}
