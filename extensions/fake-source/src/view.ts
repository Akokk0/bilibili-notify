import type {
	ExtensionBlock,
	ExtensionI18n,
	ExtensionOwnSubscription,
	ExtensionView,
} from "@bilibili-notify/extension";

/**
 * 假源交给面板的视图:名下几条订阅、开着几条,外加一句「这是假的」—— 免得有人在拓展页上
 * 看见一个「假源」还以为是哪个平台接好了。上报按钮那几块(`reportBlocks`)接在后面。
 *
 * 摘要与那句提示的字走 `ctx.i18n`(译文在包里的 `locales/`)。视图是现取的,所以每次取都现翻,
 * 语言切了面板重取到的就是新语言。
 */
export function fakeSourceView(
	subs: readonly ExtensionOwnSubscription[],
	i18n: Pick<ExtensionI18n, "t">,
	reportBlocks: readonly ExtensionBlock[] = [],
): ExtensionView {
	const enabled = subs.filter((one) => one.enabled).length;
	return {
		summary: { text: i18n.t("view.summary", { count: subs.length }) },
		page: [
			{
				type: "keyValue",
				items: [
					{ label: "订阅", value: `${subs.length} 条` },
					{ label: "开着的", value: `${enabled} 条` },
				],
			},
			{ type: "notice", tone: "info", text: i18n.t("view.notice") },
			...reportBlocks,
		],
	};
}
