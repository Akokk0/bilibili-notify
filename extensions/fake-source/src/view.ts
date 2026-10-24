import type {
	ExtensionBlock,
	ExtensionI18n,
	ExtensionView,
	SourceSubscriptionView,
} from "@bilibili-notify/extension";

/**
 * 假源交给面板的视图:几个人开着订阅(来源的名单只列启用中的,同一个人遗留的重复订阅合成一条),外加一句「这是假的」—— 免得有人在拓展页上
 * 看见一个「假源」还以为是哪个平台接好了。上报按钮那几块(`reportBlocks`)接在后面。
 *
 * 摘要与那句提示的字走 `ctx.i18n`(译文在包里的 `locales/`)。视图是现取的,所以每次取都现翻,
 * 语言切了面板重取到的就是新语言。
 */
export function fakeSourceView(
	people: readonly SourceSubscriptionView[],
	i18n: Pick<ExtensionI18n, "t">,
	reportBlocks: readonly ExtensionBlock[] = [],
): ExtensionView {
	return {
		summary: { text: i18n.t("view.summary", { count: people.length }) },
		page: [
			{
				type: "keyValue",
				items: [{ label: "开着订阅的人", value: `${people.length} 个` }],
			},
			{ type: "notice", tone: "info", text: i18n.t("view.notice") },
			...reportBlocks,
		],
	};
}
