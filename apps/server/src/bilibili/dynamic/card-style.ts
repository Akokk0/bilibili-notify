/**
 * 动态卡的样式覆盖(链接预览卡与卡片路由吃它;作品推送那条路不带样式覆盖,见 `posts/deliver-post.ts`)。
 * 背景图归皮肤自己的 `image` 旋钮(`--bn-knob-wallpaper`),不再从样式覆盖里透传。
 */
export interface DynamicCardStyle {
	enable?: boolean;
	/** 字体家族名;透传给 generatePostCard 的 colorOptions(缺省回退全局)。 */
	font?: string;
	/** 主人自带字体的资产 id(独立端专属);设了优先于 `font`,缺省回退全局。 */
	fontAsset?: string;
}

/**
 * 解析动态卡 colorOptions:样式覆盖启用(`enable`)就原样交出去;没启用 / 压根没有 →
 * undefined,调用点据此让渲染器逐字段回退自己的全局配置。
 *
 * 从前这里还管「背景图每次推送轮换」(样式自带图廊 ?? 全局默认图廊,>1 张就选下一张覆盖
 * `backgroundImage`)。整条 `cardStyle.backgroundImages` 链 2026-09-20 删掉:背景图
 * 2026-09-14 退役成皮肤自己的 `image` 旋钮,轮出来的那张从 2026-09-19 起已经喂不到任何 CSS。
 *
 * 独立端群里贴链接出的那张卡也是动态卡,必须按同一条规则出图 —— 各算一份的话,主人在卡片页给
 * 「动态」调的样式只有一边吃得到。
 */
export function resolveDynamicColorOptions(
	style: DynamicCardStyle | undefined,
): DynamicCardStyle | undefined {
	return style?.enable ? style : undefined;
}
