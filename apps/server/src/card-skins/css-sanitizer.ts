/**
 * **卡片皮肤**的 CSS 清洗层(ADR-0014 决策 13,2026-09-13「开放重写」那一版)——
 * dashboard 皮肤方言按**块**收窄,但**开得比 dashboard 宽**。
 *
 * 核心与 dashboard 同一份实现(`skins/scoped-css.ts`),这里只给参数。四处刻意不同:
 *
 * - **属性走黑名单**({@link CARD_CSS_DENY_PROPS})。出图是一张静态 PNG,没有点击面,
 *   dashboard「看不见却点得到」那一类顾虑在这里整个不成立;白名单当年顺带背了安全的锅,
 *   而真正危险的只有**值**里的取网 / 执行写法 —— 那一层与名单无关、一条不松。名单于是
 *   只列属性名本身就是执行面的那几个。
 * - **选择器自由**(`selectors: free`)。挂点之外的段随便写(class / 标签 / 属性 /
 *   伪类 / `:is` `:has` `:not` / 伪元素),清洗时保证每条都以挂点起头 —— 不以
 *   `self`(块)/ `frame`、`glass`(根)打头的,前面补一个后代前缀。作用域是靠这个前缀
 *   收住的,所以 `:has()` 再花也越不出块去,而我们不用再追着 CSS 新特性补洞。
 * - **`@keyframes` 不放行**:卡片是截图,静态的;动画一帧都画不出来,只拖慢渲染。
 * - **宿主 opacity 不设下限**:同上,一张 PNG 上没有能点的东西 —— 照抄反而把「淡淡的
 *   水印」这种正经写法堵死。
 *
 * 🔴 地板一条不松:`url()` / `image-set()` / `element()` / `expression()` / `src()`、
 * 反斜杠转义、`@import`、外部 URL 任何情况下不放行(puppeteer 是 `--no-sandbox` 跑在
 * server 旁边的,皮肤包又是要分享的);`position` 的值域仍只有 static / relative /
 * absolute;`!important` 一律摘。包内资产只有结构化那两条路(块 / 根的 `assets` 注成
 * `--bn-asset-<名>`、皮肤级 `fonts` 注成 `@font-face`),CSS 里 `var()` 引用。
 *
 * **存盘形态与 dashboard 一样:按 hook 存**(`[data-bn="self"]{…}`),而且归一之后
 * 只有精确等号这一种写法。翻译成真实选择器是渲染器(`packages/image`)的事 —— 内部
 * class 怎么重构都不固化进存量皮肤。
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

/**
 * 属性黑名单 —— 只列**属性名本身就是执行面**的那几个:它们的值是一个会被浏览器当代码
 * 加载的文档。取网那一层由值级过滤独挑(`url()` 等一律拒),所以这几条其实是第二道锁;
 * 留着是因为「这个属性名根本没有正当用途」比「它这次的值恰好被拦下了」更结实。
 *
 * 来历(都是已经死掉的浏览器扩展,出图跑的是 Chromium,认不出它们):
 * - `behavior` / `-ms-behavior` —— IE 的 HTC 绑定,`behavior:url(x.htc)` 把一份 DHTML
 *   组件挂到元素上;`-ms-behavior` 是 IE8 起的同义前缀写法,IE10 移除。
 * - `-moz-binding` / `binding` —— Gecko 的 XBL 绑定,`-moz-binding:url(x.xml#b)` 把一份
 *   XML 绑定文档挂到元素上,Firefox 57 移除;`binding` 是 CSS3 UI 草案里同一件事的无前缀名。
 *
 * **`-webkit-` 前缀的一律不列**:那是出图这个浏览器自己的东西,`-webkit-backdrop-filter`
 * / `-webkit-mask` 这类正是皮肤要用的。
 */
const CARD_CSS_DENY_PROPS: ReadonlySet<string> = new Set([
	"behavior",
	"-ms-behavior",
	"binding",
	"-moz-binding",
]);

/** 两处共用的那几格:卡片皮肤的 CSS 一律这个规格。 */
const CARD_SCOPE = {
	allowKeyframes: false,
	maxBytes: CARD_SKIN_LIMITS.maxCssBytes,
	hostOpacityFloor: null,
	props: { deny: CARD_CSS_DENY_PROPS },
	hostPosition: true,
	// 出图上没有可被冒充的界面,`content:"▶"` 这类装饰放行(dashboard 那档不放)。
	contentStrings: true,
} satisfies Omit<ScopedCssOptions, "hooks" | "selectors">;

/** 自定义块 `style=""` 属性用的声明级规格(与块级同一份黑名单)。 */
export const CARD_DECL_OPTIONS = {
	hostOpacityFloor: CARD_SCOPE.hostOpacityFloor,
	props: CARD_SCOPE.props,
	hostPosition: CARD_SCOPE.hostPosition,
	contentStrings: CARD_SCOPE.contentStrings,
} as const;

/** 根块(卡片外框)的两层挂点:外层渐变 / 背景图,内层玻璃。 */
const FRAME_HOOKS: ReadonlySet<string> = new Set(Object.keys(CARD_SKIN_FRAME_HOOKS));

/** 根块缺前缀时补哪一个 —— 外框那层(玻璃在它里面,补外层才装得下两者)。 */
const FRAME_FALLBACK_HOOK: keyof typeof CARD_SKIN_FRAME_HOOKS = "frame";

export interface CardBlockCssOptions {
	kind: CardSkinKind;
	/** 内置块名;缺省 = 自定义块(只有 `self`,没有内部挂点)。 */
	builtin?: string;
}

/**
 * 一个块的 CSS。允许的挂点 = `self`(块自己)∪ 该内置块的内部挂点;打头的只能是 `self`,
 * 缺了就补 `[data-bn="self"] ` 后代前缀。
 *
 * 内部挂点**按块分**是要紧的:给 `live/header` 写 `[data-bn="price"]`(SC 卡金额块的
 * 挂点)必须整条丢掉 —— 不然挂点契约就从「这个块内部有什么」松成「全仓所有挂点」,
 * 而渲染器真把它翻出去的话,一个块的 CSS 就摸得到另一个块。自由化的是挂点**之外**的段:
 * 那些段再花也被 `self` 前缀关在块里,摸不到别处。
 */
export function sanitizeCardBlockCss(input: string, opts: CardBlockCssOptions): SanitizeCssResult {
	const catalogue = CARD_SKIN_BUILTIN_BLOCKS[opts.kind];
	const entry = opts.builtin === undefined ? undefined : catalogue[opts.builtin];
	const hooks = new Set<string>([CARD_SKIN_SELF_HOOK]);
	if (entry) for (const hook of Object.keys(entry.hooks)) hooks.add(hook);
	const res = sanitizeScopedCss(input, {
		...CARD_SCOPE,
		hooks,
		selectors: {
			mode: "free",
			leadHooks: new Set([CARD_SKIN_SELF_HOOK]),
			fallbackHook: CARD_SKIN_SELF_HOOK,
		},
	});
	// 认不出的块名只按 `self` 洗,但**不静默**:块名打错时作者会看着一堆「不在 hook
	// 白名单」纳闷,而真正的毛病在块名上。(形状那道门 `parseCardSkin` 会单独拒收它。)
	if (res.ok && opts.builtin !== undefined && !entry) {
		res.warnings.unshift(
			`${opts.kind} 卡没有叫「${opts.builtin}」的内置块,这段 CSS 只按 self 清洗`,
		);
	}
	return res;
}

/**
 * 根块(卡片外框)的 CSS:挂点只有 `frame` / `glass`,两个都能打头,缺前缀补
 * {@link FRAME_FALLBACK_HOOK}。
 */
export function sanitizeCardFrameCss(input: string): SanitizeCssResult {
	return sanitizeScopedCss(input, {
		...CARD_SCOPE,
		hooks: FRAME_HOOKS,
		selectors: { mode: "free", leadHooks: FRAME_HOOKS, fallbackHook: FRAME_FALLBACK_HOOK },
	});
}
