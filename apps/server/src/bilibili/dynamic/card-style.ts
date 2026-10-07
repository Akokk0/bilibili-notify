import type { SubItemView } from "./push-like";

/** 动态卡的 colorOptions 形态 —— 与 `SubItemView.customCardStyle` 同一份。 */
export type DynamicCardStyle = SubItemView["customCardStyle"];

/**
 * 解析动态卡 colorOptions:样式覆盖启用(`enable`)就原样交出去;没启用 / 压根没有 →
 * undefined,调用点据此让渲染器逐字段回退自己的全局配置。
 *
 * 从前这里还管「背景图每次推送轮换」(样式自带图廊 ?? 全局默认图廊,>1 张就选下一张覆盖
 * `backgroundImage`)。整条 `cardStyle.backgroundImages` 链 2026-09-20 删掉:背景图
 * 2026-09-14 退役成皮肤自己的 `image` 旋钮,轮出来的那张从 2026-09-19 起已经喂不到任何 CSS。
 *
 * 从 DynamicEngine 里提出来:独立端群里贴链接出的那张卡也是动态卡,必须按同一条规则
 * 出图 —— 各算一份的话,主人在卡片页给「动态」调的样式只有推送卡吃得到。
 */
export function resolveDynamicColorOptions(style: DynamicCardStyle): DynamicCardStyle | undefined {
	return style?.enable ? style : undefined;
}
