import type { ExtensionOwnSubscription, ExtensionView } from "@bilibili-notify/extension";

/**
 * 假源交给面板的视图:名下几条订阅、开着几条,外加一句「这是假的」—— 免得有人在拓展页上
 * 看见一个「假源」还以为是哪个平台接好了。
 */
export function fakeSourceView(subs: readonly ExtensionOwnSubscription[]): ExtensionView {
	const enabled = subs.filter((one) => one.enabled).length;
	return {
		summary: { text: `${subs.length} 条订阅` },
		page: [
			{
				type: "keyValue",
				items: [
					{ label: "订阅", value: `${subs.length} 条` },
					{ label: "开着的", value: `${enabled} 条` },
				],
			},
			{
				type: "notice",
				tone: "info",
				text: "开发用的假源,背后什么平台都没连:新建订阅时按你输入的字现编候选,输 空 / 慢 / 坏 / 乱 各演一种失败。",
			},
		],
	};
}
