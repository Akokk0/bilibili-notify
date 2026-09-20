/**
 * 字体 / 图两档旋钮的**宿主解析**(ADR-0014 决策 16 的 🔗,2026-09-14 主人拍板)。
 *
 * 别的旋钮拧出来的就是 CSS 字面量,注进变量即可;这两档不是 —— 值是主人资产库里的一个
 * id(字体还可能是个家族名)。字体要读盘拼成 `@font-face`,图要读盘变成 data URL,
 * 两件都得 await,所以单拎出来:`cardSkinKnobCss` 那条同步路径上做不了。
 *
 * **解析不出来就不注**(资产被删了 / 卷丢了):注一条空 `url("")` 会把卡片背景当场刷白,
 * 而皮肤 CSS 里写好的兜底(`var(--bn-knob-wallpaper, <渐变>)`)一行都不会生效 —— 与
 * 从前 `fontAsset` / 背景图那条「悬空就静静回落」同一条纪律。
 */

import type { CardSkinKnob, CardSkinKnobOverrides } from "@bilibili-notify/internal";
import {
	cardSkinKnobVar,
	parseCardSkinFontKnobValue,
	parseCardSkinImageKnobValue,
} from "@bilibili-notify/internal";
import { cssFontFamily, FALLBACK_FAMILIES, USER_FONT_FAMILY } from "../render";

/**
 * 🔴 **Blink 对一条自定义属性的值封顶 2 MiB(`2,097,152` 字符)。超了整条声明在解析期
 * 就被丢掉** —— 元素上根本没有这个属性,于是皮肤 CSS 里的 `var(--bn-knob-x, 兜底)`
 * 判定「没设」、安安静静画兜底。**只卡自定义属性**:同样大的值写进 `background-image`
 * 或 `@font-face{src:…}` 都留得住(所以字体那一档不受这条管)。
 *
 * 2026-09-20 真机二分量出来的。它是主人那张 1.7MB 背景图「传得上去、存得住、就是
 * 不显示」的真因:base64 之后 2,265,368 字符,加上下面那层壳,越线 8%。
 * 这条**门禁钉不住** —— HTML 那头一个字节不少,只有真 Chrome 的 `getComputedStyle`
 * 看得见它是空的。
 */
export const CSS_CUSTOM_PROPERTY_MAX_CHARS = 2_097_152;

/** 图那一档的值是 `url("<url>") center / cover`,壳占掉的字符数。 */
const IMAGE_VALUE_OVERHEAD = 'url("") center / cover'.length;

/** 留给 data URL 本身的预算。**压缩器要照这个数压**,不然压到刚好 2 MiB 还是会被丢。 */
export const IMAGE_URL_BUDGET = CSS_CUSTOM_PROPERTY_MAX_CHARS - IMAGE_VALUE_OVERHEAD;

export interface KnobAssetResolvers {
	/** 用户资产 id → data URL。解析不出来给空串。 */
	image: (id: string) => Promise<string>;
	/** 用户字体资产 id → 一整条 `@font-face`(家族名由宿主定,见 `USER_FONT_FAMILY`)。 */
	fontFace: (id: string) => Promise<string>;
	/**
	 * 多张图时选第几张 —— **每次推送轮换**由调用方给(渲染器手里才有那个游标)。
	 * 不给就恒取第一张。
	 */
	pick?: (count: number, key: string) => number;
	/**
	 * 图超出 {@link IMAGE_URL_BUDGET} 时,把它压进预算。回 `null` = 压不下去。
	 *
	 * 住在调用方是因为压这一下要**一个浏览器**(见 `shrink-image.ts`:Chrome 自己就是
	 * 编码器),而这个函数是纯的。不给就只报不压 —— 那张图照旧不出,但至少不再静默。
	 */
	shrinkImage?: (dataUrl: string, budgetChars: number, assetId: string) => Promise<string | null>;
}

export interface ResolvedKnobAssets {
	/** 额外的 `@font-face`,拼在皮肤自带的那些后面。 */
	fontFaces: string;
	/** 要注在根块上的那串变量,拼在旋钮声明后面。 */
	vars: string;
	/**
	 * 哪一枚旋钮没注进去、为什么。**这一层的失败全是静默的**(图不出、字体回落),
	 * 调用方要把它摆到主人看得见的地方去(回落台账 / 日志)。
	 */
	warnings: string[];
}

/** 每次都给一份新的 —— `warnings` 是数组,共用一份会跨调用串味。 */
const empty = (): ResolvedKnobAssets => ({ fontFaces: "", vars: "", warnings: [] });

export async function resolveKnobAssets(
	knobs: readonly CardSkinKnob[] | undefined,
	overrides: CardSkinKnobOverrides | undefined,
	resolvers: KnobAssetResolvers,
): Promise<ResolvedKnobAssets> {
	if (!knobs?.length || !overrides) return empty();
	let fontFaces = "";
	let vars = "";
	const warnings: string[] = [];
	// 同一款字体被两枚旋钮指着时只内联一次:一款中文字库 base64 之后二三十兆,而镜像里
	// V8 的 old-space 上限只有 512MB —— 内联两份就是一次 OOM。
	const seenFonts = new Set<string>();

	for (const knob of knobs) {
		const raw = overrides[knob.key];
		if (raw === undefined) continue;

		if (knob.type === "font") {
			const parsed = parseCardSkinFontKnobValue(raw);
			if (parsed === null) continue;
			if ("family" in parsed) {
				vars += `${cardSkinKnobVar(knob.key)}:${familyValue(parsed.family)};`;
				continue;
			}
			if (!seenFonts.has(parsed.upload)) {
				const face = await resolvers.fontFace(parsed.upload);
				if (face === "") continue;
				seenFonts.add(parsed.upload);
				fontFaces += face;
			}
			vars += `${cardSkinKnobVar(knob.key)}:${familyValue(USER_FONT_FAMILY)};`;
			continue;
		}

		if (knob.type === "image") {
			const ids = parseCardSkinImageKnobValue(raw);
			if (ids === null) continue;
			const at = resolvers.pick ? clampIndex(resolvers.pick(ids.length, knob.key), ids.length) : 0;
			const id = ids[at] as string;
			const url = await fitUrl(await resolvers.image(id), resolvers, knob.key, id, warnings);
			if (url === "") continue;
			// 值是**完整的一层**(自带 `center / cover`):尺寸不能挪到皮肤 CSS 那头去写 ——
			// 渐变一带尺寸就换了光栅抖动(像素门 14 张红过),与 `--bn-card-bg-image` 同款。
			vars += `${cardSkinKnobVar(knob.key)}:url("${url}") center / cover;`;
		}
	}
	return { fontFaces, vars, warnings };
}

/**
 * 把一张图塞进 {@link IMAGE_URL_BUDGET}。塞不进就回空串 —— **宁可不注,也别注一个
 * 注定被 Chrome 丢掉的值**:注了跟没注画面上一模一样(都走皮肤 CSS 的兜底),但注了
 * 就没人知道发生过什么。
 *
 * 没超预算的**一个字节都不动**,压缩器碰都不碰 —— 像素基准与存量出图靠这条不变。
 */
async function fitUrl(
	url: string,
	resolvers: KnobAssetResolvers,
	key: string,
	id: string,
	warnings: string[],
): Promise<string> {
	if (url === "" || url.length <= IMAGE_URL_BUDGET) return url;
	const shrunk = await resolvers.shrinkImage?.(url, IMAGE_URL_BUDGET, id);
	if (shrunk !== undefined && shrunk !== null && shrunk.length <= IMAGE_URL_BUDGET) return shrunk;
	const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)}MB`;
	warnings.push(
		`旋钮「${key}」的图「${id}」压不进 CSS 自定义属性的 2 MiB 上限` +
			`(${mb(shrunk?.length ?? url.length)} / 上限 ${mb(IMAGE_URL_BUDGET)}),这一张没画上去`,
	);
	return "";
}

/** 家族名 → `font-family` 的值,后面跟上兜底链(选的那款缺中文字形时不至于出豆腐块)。 */
function familyValue(family: string): string {
	return [cssFontFamily(family), FALLBACK_FAMILIES].filter(Boolean).join(", ");
}

function clampIndex(i: number, count: number): number {
	if (!Number.isFinite(i)) return 0;
	const n = Math.trunc(i) % count;
	return n < 0 ? n + count : n;
}
