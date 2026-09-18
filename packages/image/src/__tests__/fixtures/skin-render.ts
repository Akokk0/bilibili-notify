/**
 * **夹具走皮肤那条路** —— 基准门与结构门共用的一份装配(ADR-0014 决策 24 的 2026-09-18 🔗)。
 *
 * 从前这两道门是拿「旧版式折成皮肤」当入口的,而那条折叠(以及它服务的一次性迁移)已经
 * 退役。现在一律用**出厂默认皮肤**画;另有四份夹具专测「非默认版式也画得对」,各配一张
 * 手写的皮肤卡 —— 默认皮肤只有一种摆法,分割线的抑制与弹出这些规矩得靠别的摆法才照得出。
 */

import {
	type CardSkinBlock,
	type CardSkinCard,
	type CardSkinKind,
	DEFAULT_CARD_SKIN,
} from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { renderCard } from "../../render";
import { renderSkinnedCard } from "../../skin/render-skin";
import { CARD_FIXTURES, type CardFixture, type CardRenderInput } from "./card-fixtures";

/** 出厂默认皮肤里那张卡,拿来改一改。 */
function base(kind: CardSkinKind): CardSkinCard {
	const card = DEFAULT_CARD_SKIN.cards[kind];
	if (!card) throw new Error(`出厂默认皮肤缺 ${kind} 卡`);
	return card;
}

/** 按 id 挑出几块,重新编行号(1..n)。挑不到的 id 直接报错 —— 默认皮肤改了名要当场发现。 */
function pick(kind: CardSkinKind, ids: readonly string[]): CardSkinBlock[] {
	const card = base(kind);
	return ids.map((id, i) => {
		const block = card.blocks.find((b) => b.id === id);
		if (!block) throw new Error(`默认皮肤的 ${kind} 卡没有「${id}」这一块`);
		// 重排后原来的跨行/跨列关系未必还成立,这里只留通栏一行 —— 这几张卡要照的是
		// 「块序与分割线规矩」,不是位置。
		return { ...block, grid: { row: i + 1, column: 1, span: 12 } };
	});
}

/**
 * 四份专测非默认版式的夹具各自的皮肤卡。覆盖的正是默认皮肤照不到的那几条:
 * 开头的分割线要被抑制、末尾的要被弹掉、中间块收起后悬空的那条也要抑制。
 */
const CUSTOM_CARDS: Record<string, () => CardSkinCard> = {
	// 开头就摆一条分割线 —— 该被抑制;块序也打乱。**故意不摆 `status`**:直播状态角标
	// 拆成独立的块之后就能单独关掉了(从前它长在封面块里,关不掉),这张卡顺便钉住这件事。
	"live-minimal": () => ({
		...base("live"),
		blocks: pick("live", ["divider-1", "title", "cover", "name", "desc"]),
	}),
	// 末尾摆一条分割线(该被弹掉),互动数整个不摆。
	"dynamic-custom-layout": () => ({
		...base("dynamic"),
		blocks: pick("dynamic", ["name", "text", "media", "additional", "divider-2"]),
	}),
	// 留言是空的 → 那一块收起,排在它后面的分割线就悬空在开头了,该被抑制。
	"sc-custom-layout": () => ({
		...base("sc"),
		blocks: pick("sc", ["message", "divider-1", "price", "name"]),
	}),
	// 徽章挪到左边四列,内容列跟着靠右 —— 与默认皮肤正好镜像。
	"guard-badge-left": () => {
		const card = base("guard");
		return {
			...card,
			blocks: card.blocks.map((b) =>
				b.id === "badge"
					? { ...b, grid: { ...b.grid, column: 1, span: 4 } }
					: { ...b, grid: { ...b.grid, column: b.grid.column + 4 } },
			),
		};
	},
};

// 夹具名拼错的话,那份夹具会**静默**退回默认皮肤 —— 想覆盖的「非默认版式」当场落空,
// 而所有测试照旧全绿。所以加载时就把名字对一遍。
for (const name of Object.keys(CUSTOM_CARDS)) {
	if (!CARD_FIXTURES.some((f) => f.name === name)) {
		throw new Error(`skin-render:没有叫「${name}」的夹具,这张自定义皮肤卡挂不上去`);
	}
}

/** 这份夹具该用哪张皮肤卡。 */
export function skinCardOf(fixture: CardFixture): CardSkinCard {
	return CUSTOM_CARDS[fixture.name]?.() ?? base(fixture.kind);
}

/** 一张皮肤卡 + 一份 props 出的完整 HTML(含皮肤那段 CSS)。 */
async function render(
	kind: CardSkinKind,
	card: CardSkinCard,
	props: unknown,
	options: CardRenderInput["options"],
): Promise<string> {
	const out = renderSkinnedCard({ kind, card, props: props as never });
	return await renderCard(
		{ render: (): VNode => out.vnode },
		{},
		{ ...options, extraCss: out.css },
	);
}

/** 同一份夹具走皮肤那条路出的完整 HTML。 */
export async function renderViaSkin(fixture: CardFixture, input: CardRenderInput): Promise<string> {
	return await render(fixture.kind, skinCardOf(fixture), input.props, input.options);
}

/** 出厂默认皮肤画一张卡 —— 给不走夹具、只想看某种卡画出什么的测试用。 */
export async function renderViaDefaultSkin(
	kind: CardSkinKind,
	props: unknown,
	options: CardRenderInput["options"] = {},
): Promise<string> {
	return await render(kind, base(kind), props, options);
}
