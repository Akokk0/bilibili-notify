/**
 * **dashboard 皮肤**的 CSS 清洗层 —— 白名单制,走 css-tree 真 parser 的 AST。
 *
 * 通用那部分(选择器逐段挂 hook、属性白名单、`url()` 与转义、`position` 归宿主、
 * `!important` 一律摘、宽容模式与体积闸)住 {@link ./scoped-css.js};这里只剩
 * **dashboard 这一档的参数**与它独有的存量烙印清洁工。卡片皮肤是同一套方言的另一个
 * 作用域(`card-skins/css-sanitizer.ts`),参数不同、实现同一份 —— 红线抄第二遍就是
 * 它破的方式。
 *
 * dashboard 这一档的取值:
 * - hook 集合 = `SKIN_CSS_HOOK_MAP` 的键
 * - `@keyframes` 放行(界面是活的),名字必须 `skin-` 前缀
 * - 宿主 opacity 有下限({@link HOST_OPACITY_FLOOR})—— 收的是「看不见却点得到」这
 *   一类。**注意这不是「皮肤无法欺骗」**:`background:transparent;color:transparent`
 *   一样让按钮隐形,而那是主题系统的固有能力,拦不掉也不该拦。装皮肤 = 信任那套皮肤。
 */

import { SKIN_CSS_HOOK_MAP, SKIN_LIMITS } from "@bilibili-notify/contract";
import type { CssNode, List, ListItem } from "css-tree";
// 走自包含 dist bundle,不走默认入口:理由见 scoped-css.ts 顶部。
import { generate, parse } from "css-tree/dist/csstree.esm";
import {
	everyChild,
	type SanitizeCssResult,
	type ScopedCssOptions,
	sanitizeScopedCss,
	targetsPseudoElement,
} from "./scoped-css.js";

export type { SanitizeCssResult } from "./scoped-css.js";

/**
 * 自定义 CSS 的上限,**按 UTF-8 字节算**(理由见 {@link ScopedCssOptions.maxBytes})。
 */
export const MAX_SKIN_CSS_BYTES = SKIN_LIMITS.maxCssBytes;

/**
 * 宿主的透明度下限。低于它就是「看不见、但点得到」—— UI 欺骗的起手式,而
 * `visibility` / `display` 这些**更温和**的隐身法本来就不在白名单里,放行 opacity
 * 等于挡了安全的那个、开了危险的那个。
 *
 * 这道闸**不封闭**,也封不闭:`background:transparent;color:transparent` 同样让
 * 一颗按钮隐形,而那是主题系统的固有能力。这里堵的是最顺手的那条路,不是宣称
 * 「皮肤无法欺骗」。
 */
const HOST_OPACITY_FLOOR = 0.15;

const DASHBOARD_SCOPE: ScopedCssOptions = {
	hooks: new Set(Object.keys(SKIN_CSS_HOOK_MAP)),
	allowKeyframes: true,
	maxBytes: MAX_SKIN_CSS_BYTES,
	hostOpacityFloor: HOST_OPACITY_FLOOR,
};

export function sanitizeSkinCss(input: string): SanitizeCssResult {
	return sanitizeScopedCss(input, DASHBOARD_SCOPE);
}

/**
 * 摘掉清洗层旧版烙进存盘产物的两句硬规矩(`pointer-events:none` / `z-index:-1`)。
 *
 * 烙印的签名是**成对**:当年两句一起补进同一条装饰规则,而保存路径过的是已洗
 * 内存,盘上残留不会只剩半句。所以 `z-index:-1` 只在同规则还有 `pointer-events:
 * none` 时才算笔迹 —— 落单的它是作者升级后自己的声明,摘了就是让主人的字凭空
 * 消失。`pointer-events` 不在白名单、作者经编辑器写不进来,单独出现也摘。
 *
 * v0.7.0 及之前,这两句由清洗层补进产物再落盘;它们在白名单外(pointer-events),
 * 于是每次再清洗都对着自己上一轮的笔迹刷「已丢弃」警告。硬规矩挪去注入层之后,
 * 存量文件里的烙印靠这里在**读盘进索引时**摘掉 —— 内存与导出立即干净,磁盘在
 * 下一次保存时自然升级,不主动回写(与 active.json 旧格式迁移同一套哲学)。
 *
 * 摘不动(解析失败等)就原样返回:这是清洁工,不是守门员 —— 拦截是清洗层的事。
 */
export function stripDecorationResidue(css: string): string {
	if (!css.includes("pointer-events") && !css.includes("z-index")) return css;
	let ast: CssNode;
	try {
		ast = parse(css, { parseCustomProperty: false });
	} catch {
		return css;
	}
	if (ast.type !== "StyleSheet") return css;
	let changed = false;
	const stripIn = (list: List<CssNode>, inKeyframes: boolean): void => {
		list.forEach((node: CssNode) => {
			if (node.type === "Atrule") {
				const block = node.block;
				if (block) stripIn(block.children, node.name.toLowerCase() === "keyframes");
				return;
			}
			if (node.type !== "Rule" || inKeyframes) return;
			const prelude = node.prelude;
			// 与过滤层同一口径(everyChild + targetsPseudoElement):烙印当年就是按这个
			// 判定落进去的,摘的时候差一个字就漏。
			const pseudo =
				prelude.type === "SelectorList" && everyChild(prelude.children, targetsPseudoElement);
			if (!pseudo || !node.block) return;
			let hasBrandPair = false;
			node.block.children.forEach((decl: CssNode) => {
				if (decl.type !== "Declaration") return;
				if (
					decl.property.toLowerCase() === "pointer-events" &&
					generate(decl.value).trim().toLowerCase() === "none"
				) {
					hasBrandPair = true;
				}
			});
			const drop: ListItem<CssNode>[] = [];
			node.block.children.forEach((decl: CssNode, item) => {
				if (decl.type !== "Declaration") return;
				const prop = decl.property.toLowerCase();
				const value = generate(decl.value).trim().toLowerCase();
				if (
					(prop === "pointer-events" && value === "none") ||
					(prop === "z-index" && value === "-1" && hasBrandPair)
				) {
					drop.push(item);
				}
			});
			for (const item of drop) node.block.children.remove(item);
			if (drop.length > 0) changed = true;
		});
	};
	stripIn((ast as CssNode & { children: List<CssNode> }).children, false);
	return changed ? generate(ast) : css;
}
