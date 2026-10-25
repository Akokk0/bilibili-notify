import type {
	ExtensionBlock,
	ExtensionI18n,
	ExtensionView,
	SourceSubscriptionView,
} from "@bilibili-notify/extension";
import type { FakeSentEntry } from "./adapter.js";

/** 表格最多列最近这么多条发送(账本身最多留 50 条)。 */
const SENT_ROWS = 10;

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
	adapterBlocks: readonly ExtensionBlock[] = [],
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
			...adapterBlocks,
		],
	};
}

function destinationText(one: FakeSentEntry["destination"]): string {
	if (one.kind === "endpoint") return `端点 ${one.endpointId ?? ""}`;
	const parent = one.parentAddress ? ` / 上级 ${one.parentAddress}` : "";
	return `${one.scope ?? ""} ${one.address ?? ""}${parent}`;
}

function payloadText(one: FakeSentEntry): string {
	return one.segments.map((segment) => segment.kind).join(" + ");
}

/**
 * 假平台适配器那几块,接在原有各块之后:管着几条连接、最近几条发送(表格,新的在上)、最近一条文字。
 * 适配器没有别的出口 —— 它收到什么,只经这一页给人看。
 */
export function fakeAdapterBlocks(
	connectionCount: number,
	sent: readonly FakeSentEntry[],
): ExtensionBlock[] {
	const latest = sent
		.filter((one) => one.segments.some((segment) => segment.text !== undefined))
		.at(-1);
	const latestText = latest?.segments.find((segment) => segment.text !== undefined)?.text;
	return [
		{ type: "keyValue", items: [{ label: "假平台管着", value: `${connectionCount} 条连接` }] },
		{
			type: "table",
			title: "假平台收到的发送",
			count: true,
			empty: "还没有收到发送",
			columns: [{ kind: "mono" }, { kind: "text" }, { kind: "text" }, { kind: "text" }],
			rows: [...sent]
				.reverse()
				.slice(0, SENT_ROWS)
				.map((one) => [
					{ kind: "mono", text: one.connectionId },
					{ kind: "text", text: one.platform },
					{ kind: "text", text: destinationText(one.destination) },
					{ kind: "text", text: payloadText(one) },
				]),
		},
		{
			type: "notice",
			tone: "info",
			text: latestText === undefined ? "最近一条文字:还没有" : `最近一条文字:${latestText}`,
		},
	];
}
