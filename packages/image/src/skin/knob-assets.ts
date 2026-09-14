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
}

export interface ResolvedKnobAssets {
	/** 额外的 `@font-face`,拼在皮肤自带的那些后面。 */
	fontFaces: string;
	/** 要注在根块上的那串变量,拼在旋钮声明后面。 */
	vars: string;
}

const EMPTY: ResolvedKnobAssets = { fontFaces: "", vars: "" };

export async function resolveKnobAssets(
	knobs: readonly CardSkinKnob[] | undefined,
	overrides: CardSkinKnobOverrides | undefined,
	resolvers: KnobAssetResolvers,
): Promise<ResolvedKnobAssets> {
	if (!knobs?.length || !overrides) return EMPTY;
	let fontFaces = "";
	let vars = "";
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
			const url = await resolvers.image(ids[at] as string);
			if (url === "") continue;
			// 值是**完整的一层**(自带 `center / cover`):尺寸不能挪到皮肤 CSS 那头去写 ——
			// 渐变一带尺寸就换了光栅抖动(像素门 14 张红过),与 `--bn-card-bg-image` 同款。
			vars += `${cardSkinKnobVar(knob.key)}:url("${url}") center / cover;`;
		}
	}
	return { fontFaces, vars };
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
