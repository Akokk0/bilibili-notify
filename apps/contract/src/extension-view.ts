import type {
	ExtensionBlock,
	ExtensionItemView,
	ExtensionViewSummary,
} from "@bilibili-notify/extension/wire";

/**
 * `GET /api/ext/:id/status` 交给面板的那份视图(v2)—— 拓展交的 `ExtensionView` **宿主核过
 * 之后**的样子(ADR-0019 决策 40)。
 *
 * 拓展交的不合规矩时**按主人看的单位降级**:页上按块、列表按项、摘要单独。坏块换成一条
 * {@link ExtensionViewFault}(点名哪一块、为什么),坏项那张卡写「状态未知」加同一条提示,摘要坏了
 * 就不下发。从前是「一格不对整份不画」:一个对端报来的超长名字就让整页连同列表页那一行一起消失,
 * 逼得每个拓展抄一份宿主的上限自己截断。
 *
 * 🔴 **「坏了」的标记只有宿主加得了。** 拓展交的积木一律包在 `{ block }` / `{ view }` 里,标记是与
 * 它们并列的 `{ fault }` —— 那一层是宿主造的,拓展那份 schema 里根本没有它,拓展自己造不出一条
 * 假的「宿主报错」。
 *
 * v1 拓展的那一口仍是它自己交的任意 JSON(`publishStatus`),不是这个形状。
 */
export interface ExtensionPanelView {
	/** 拓展列表页那一行。坏了就没有这一格(决策 40「摘要坏了不画」)。 */
	summary?: ExtensionViewSummary;
	/** 头卡正文里的积木,按拓展交的次序,坏的那一块换成一条提示。 */
	page?: readonly ExtensionPanelBlock[];
	/**
	 * 列表设置项的 key → 项的 id → 那一项。键已经对过清单与存着的设置:不是声明过的列表、不是
	 * 现存的项的,宿主丢掉了(记一行日志),不会出现在这里。
	 */
	items?: Readonly<Record<string, Readonly<Record<string, ExtensionPanelItem>>>>;
	/** 图片字典 —— 只剩还有人引用的那几张。 */
	images?: Readonly<Record<string, string>>;
}

/** 页上的一块:拓展交的那块积木,或者宿主换上的一条「这一块画不出来」。 */
export type ExtensionPanelBlock = { block: ExtensionBlock } | { fault: ExtensionViewFault };

/** 列表的一项:拓展交的那几格,或者宿主换上的一条「这一项画不出来」(卡上写「状态未知」)。 */
export type ExtensionPanelItem = { view: ExtensionItemView } | { fault: ExtensionViewFault };

/**
 * 宿主说「这一块画不出来」。面板照原话摆:`{where}画不出来:{reason}`。
 *
 * 🔴 失败的原因不许吞:`reason` 是宿主那一道校验的原话(哪一格、为什么;超了上限就说多大),是
 * 拓展作者与主人唯一能照着查的线索。
 */
export interface ExtensionViewFault {
	/** 哪一块 —— 「页上第 2 块(表格)」「这一项」「整份视图」。 */
	where: string;
	/** 为什么。 */
	reason: string;
}
