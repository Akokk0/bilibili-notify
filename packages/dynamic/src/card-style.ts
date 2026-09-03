import type { PickCardBackground, SubItemView } from "./push-like";

/** 动态卡的 colorOptions 形态 —— 与 `SubItemView.customCardStyle` 同一份。 */
export type DynamicCardStyle = SubItemView["customCardStyle"];

/**
 * 解析动态卡 colorOptions。背景图「每次推送轮换」:优先该样式自带的 `backgroundImages`;
 * 没有(样式自带列表为空)→ 落回 `defaultBackgroundImages`(全局默认图廊)—— 否则无覆盖
 * 的 UP 会一直渲染渲染器内部缓存的静态首图,图廊配再多张也不轮换(回归 bug)。列表 >1 张
 * 且注入了选择器 → 选下一张覆盖 backgroundImage(游标键 `scopeKey`)并强制 enable:true,
 * 其余字段留空,靠调用点逐字段回退渲染器全局配置;否则原样返回(enable=false →
 * undefined,走渲染器全局兜底)。**每次渲染调一次 = 每推送轮换一张。**
 *
 * 从 DynamicEngine 里提出来:独立端群里贴链接出的那张卡也是动态卡,必须按同一条规则
 * 出图 —— 各算一份的话,主人在卡片页给「动态」调的图廊只有推送卡在轮。
 */
export function resolveDynamicColorOptions(input: {
	style: DynamicCardStyle;
	defaultBackgroundImages: string[] | undefined;
	pick: PickCardBackground;
	scopeKey: string;
}): DynamicCardStyle | undefined {
	const { style, defaultBackgroundImages, pick, scopeKey } = input;
	const images =
		style?.backgroundImages && style.backgroundImages.length > 0
			? style.backgroundImages
			: defaultBackgroundImages;
	if (images && images.length > 1) {
		const picked = pick(scopeKey, images);
		if (picked !== undefined) return { ...style, enable: true, backgroundImage: picked };
	}
	return style?.enable ? style : undefined;
}
