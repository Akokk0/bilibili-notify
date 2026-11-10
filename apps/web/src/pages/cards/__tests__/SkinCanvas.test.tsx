// @vitest-environment jsdom
import { chooseSelect, selectOptionsOf } from "../../../__tests__/select-controls";
import { i18n } from "../../../i18n";

/**
 * 网格画布 + 检查器那条回路(ADR-0014 决策 6 / 20 / 21)。
 *
 * 钉的都是**接线**,不是长相 —— 零件各自的单元测试全绿证明不了两个零件真接上了:
 * ① 块按 `column` / `span` 落在正确的 grid 位置(画布多一列行号,少 +1 就整排歪掉,
 * 而页面看着还是一排块);② 点一下真的选中;③ 检查器里改一个数,**改动真的回到调用方**
 * (断了的话界面上数字变了、草稿一个字没动);④ 皮肤没定义这种卡时说人话而不是白屏。
 */

import type { CardSkinManifest } from "@bilibili-notify/contract";
import {
	CARD_PREVIEW_SCENES,
	CARD_SKIN_LIMITS,
	CARD_SKIN_RANK_GUIDE,
	type CardKind,
} from "@bilibili-notify/internal/card-skin";
import { SELECTED_LANGUAGE } from "@bilibili-notify/ui";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SkinCanvas, type SkinSelection } from "../SkinCanvas";
import { SkinInspector } from "../SkinInspector";
import {
	addBlock,
	addCustomBlock,
	cardOf,
	removeBlock,
	setBlockCss,
	setBlockGrid,
	setBlockHtml,
	setBlockShowIf,
	setColumns,
	setFrame,
	setFrameCss,
} from "../skin-draft-ops";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

/** CSS 那一节默认是结构视图,源码文本框得先切过去(ADR-0014 决策 21 的 2026-09-19 🔗)。 */
const toSource = () => fireEvent.click(screen.getByRole("button", { name: "源码" }));

const manifest = (): CardSkinManifest =>
	({
		schemaVersion: 2,
		name: "测试皮肤",
		cards: {
			live: {
				width: 600,
				css: "",
				blocks: [
					{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
					{
						id: "name",
						kind: "builtin",
						builtin: "creatorName",
						grid: { row: 2, column: 3, span: 6 },
						showIf: "live.isStreaming",
					},
					{
						id: "notice",
						kind: "custom",
						html: "<div>公告</div>",
						grid: { row: 3, column: 1, span: 12 },
					},
				],
			},
			// 直播卡已经全是原子块、一个挂点都没有了,所以「内置块徽章」与「挂点列表」
			// 这两条改用动态卡的附加内容照 —— 它是主人拍板不拆的那几块之一。
			post: {
				width: 600,
				css: "",
				blocks: [
					{
						id: "additional",
						kind: "builtin",
						builtin: "attachment",
						grid: { row: 1, column: 1, span: 12 },
					},
					{
						id: "avatar",
						kind: "builtin",
						builtin: "creatorAvatar",
						grid: { row: 2, column: 1, span: 3 },
					},
				],
			},
			// 档位卡:检查器的 CSS 一节要带上「按档换色」的说明(㉔d)。
			superchat: {
				width: 290,
				css: "",
				blocks: [
					{
						id: "amount",
						kind: "builtin",
						builtin: "amount",
						grid: { row: 1, column: 1, span: 12 },
					},
				],
			},
		},
	}) as unknown as CardSkinManifest;

/**
 * 画布 + 检查器接在一份真草稿上 —— 这条回路正是要钉的东西。接线与 `CardSkinEditor`
 * 那头同形:增删块都是「换草稿 + 顺手把选中挪到该在的地方」。
 */
function Harness({
	onDraft,
	readOnly,
	kind = "live",
}: {
	onDraft?: (m: CardSkinManifest) => void;
	/** 只读时不给增删的口 —— 内置皮肤那档,控件根本不该出现。 */
	readOnly?: boolean;
	/**
	 * 画哪种卡。默认直播卡 —— 但直播卡拆完已经**一个复合块、一个挂点都不剩**了,
	 * 所以「内置块徽章」「挂点列表」那两条要拿动态卡照(ADR-0014 决策 8 的 2026-09-18 🔗)。
	 */
	kind?: CardKind;
}) {
	const [draft, setDraft] = useState<CardSkinManifest>(manifest());
	const [selection, setSelection] = useState<SkinSelection>(null);
	return (
		<div>
			<SkinCanvas
				kind={kind}
				card={cardOf(draft, kind)}
				scene={CARD_PREVIEW_SCENES[kind][0]?.id ?? ""}
				selection={selection}
				onSelect={setSelection}
				onAdd={
					readOnly
						? undefined
						: (builtin) => {
								const added = addBlock(draft, kind, builtin);
								if (!added) return;
								setDraft(added.manifest);
								onDraft?.(added.manifest);
								setSelection({ kind: "block", id: added.blockId });
							}
				}
				onAddCustom={
					readOnly
						? undefined
						: () => {
								const added = addCustomBlock(draft, kind);
								if (!added) return;
								setDraft(added.manifest);
								onDraft?.(added.manifest);
								setSelection({ kind: "block", id: added.blockId });
							}
				}
			/>
			<SkinInspector
				manifest={draft}
				kind={kind}
				selection={selection}
				onGrid={(id, patch) =>
					setDraft((d) => {
						const next = setBlockGrid(d, kind, id, patch);
						onDraft?.(next);
						return next;
					})
				}
				onHtml={(id, html) =>
					setDraft((d) => {
						const next = setBlockHtml(d, kind, id, html);
						onDraft?.(next);
						return next;
					})
				}
				onShowIf={(id, path) =>
					setDraft((d) => {
						const next = setBlockShowIf(d, kind, id, path);
						onDraft?.(next);
						return next;
					})
				}
				onCss={(id, css) =>
					setDraft((d) => {
						const next = setBlockCss(d, kind, id, css);
						onDraft?.(next);
						return next;
					})
				}
				onFrameCss={(css) =>
					setDraft((d) => {
						const next = setFrameCss(d, kind, css);
						onDraft?.(next);
						return next;
					})
				}
				onFrame={(patch) =>
					setDraft((d) => {
						const next = setFrame(d, kind, patch);
						onDraft?.(next);
						return next;
					})
				}
				onColumns={(cols) =>
					setDraft((d) => {
						const next = setColumns(d, kind, cols);
						onDraft?.(next);
						return next;
					})
				}
				onRemove={
					readOnly
						? undefined
						: (id) => {
								setDraft((d) => {
									const next = removeBlock(d, kind, id);
									onDraft?.(next);
									return next;
								});
								setSelection(null);
							}
				}
			/>
		</div>
	);
}

/** 目录面板。画布上也有同名的块,查目录里那枚得先圈住它。 */
const catalogue = (): HTMLElement => screen.getByRole("group", { name: "可以添加的块" });

const blockBtn = (label: string): HTMLElement => {
	const el = screen.getByText(label).closest("button");
	if (!el) throw new Error(`块「${label}」没渲染成按钮`);
	return el;
};

afterEach(() => cleanup());

describe("网格画布", () => {
	it.each([
		[
			"en",
			"Card frame",
			"Width 640 · Row gap 8 · Column gap 12",
			"Custom column widths",
			"Empty row",
			"Block limit reached (40)",
			"Add block",
		],
		[
			"ja",
			"カードの外枠",
			"幅 640 · 行間 8 · 列間 12",
			"列幅を個別指定",
			"空の行",
			"ブロック数の上限です（40）",
			"ブロックを追加",
		],
		[
			"zh-TW",
			"卡片外框",
			"寬度 640 · 列間距 8 · 欄間距 12",
			"自訂欄寬",
			"空白列",
			"已達區塊數量上限（40）",
			"新增區塊",
		],
	] as const)(
		"%s frame geometry and full-card hints translate without changing selection or allowing more blocks",
		(locale, frame, dimensions, customColumns, empty, full, add) => {
			const base = cardOf(manifest(), "live");
			if (!base) throw new Error("live card fixture is missing");
			const card = {
				...base,
				width: 640,
				gap: { row: 8, column: 12 },
				columns: Array.from({ length: 12 }, () => ({ fr: 1 })),
			};
			const onSelect = vi.fn();
			const onAdd = vi.fn();
			const view = render(
				<SkinCanvas
					kind="live"
					scene="streaming"
					card={card}
					selection={null}
					onSelect={onSelect}
				/>,
			);
			act(() => i18n.set({ locale, voice: "plain" }));
			const frameButton = screen.getByText(frame).closest("button");
			if (!frameButton) throw new Error("card frame button is missing");
			expect(frameButton.textContent).toContain(dimensions);
			expect(frameButton.textContent).toContain(customColumns);
			expect(screen.getByText(empty)).toBeTruthy();
			expect(onSelect).not.toHaveBeenCalled();
			fireEvent.click(frameButton);
			expect(onSelect).toHaveBeenCalledWith({ kind: "frame" });
			const fullCard = {
				...card,
				blocks: Array.from({ length: 40 }, (_v, i) => ({
					id: `original-${i}`,
					kind: "builtin" as const,
					builtin: "creatorName",
					grid: { row: i + 1, column: 1, span: 12 },
				})),
			};
			view.rerender(
				<SkinCanvas
					kind="live"
					scene="streaming"
					card={fullCard}
					selection={null}
					onSelect={onSelect}
					onAdd={onAdd}
				/>,
			);
			expect(screen.getByText(full)).toBeTruthy();
			expect(screen.queryByRole("button", { name: add })).toBeNull();
			expect(onAdd).not.toHaveBeenCalled();
		},
	);
	it("块落在正确的 grid 位置 —— 行号占掉第一列,所以起始列要 +1", () => {
		render(<Harness />);
		// name 块:column 3 / span 6 → CSS 上是 4 起跨 6。
		expect(blockBtn("创作者名").style.gridColumn).toBe("4 / span 6");
		expect(blockBtn("创作者名").style.gridRow).toBe("2 / span 1");
		expect(blockBtn("封面图").style.gridColumn).toBe("2 / span 12");
	});

	it("三档来历各挂各的徽章,showIf 也标出来", () => {
		render(<Harness />);
		expect(blockBtn("创作者名").textContent).toContain("原子");
		expect(blockBtn("创作者名").textContent).toContain("showIf");
		expect(blockBtn("自定义块").textContent).toContain("自定义");
		cleanup();

		render(<Harness kind="post" />);
		expect(blockBtn("附加内容").textContent).toContain("内置");
		expect(blockBtn("头像").textContent).toContain("原子");
	});

	it("点一下就选中(aria-pressed 是可查询的事实,不是一层 class)", () => {
		render(<Harness />);
		expect(blockBtn("创作者名").getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(blockBtn("创作者名"));
		expect(blockBtn("创作者名").getAttribute("aria-pressed")).toBe("true");
		expect(blockBtn("封面图").getAttribute("aria-pressed")).toBe("false");
	});

	it("卡片外框也能选中 —— 它不是块,但宽度 / 间距 / 外框 CSS 都在它身上", () => {
		render(<Harness />);
		fireEvent.click(screen.getByText("卡片外框"));
		expect(screen.getByLabelText(/卡宽/)).toBeTruthy();
	});

	it("定宽列按占比画 —— 照抄 px 的话,430 宽的卡摊在面板里那几列比例就错了", () => {
		// 400 宽 = 8 等分列分 300px(每列 37.5)+ 4 列定宽 25px。
		const m = manifest();
		const card = m.cards.live as { width: number; columns?: unknown };
		card.width = 400;
		card.columns = [
			...Array.from({ length: 8 }, () => ({ fr: 1 })),
			...Array.from({ length: 4 }, () => ({ px: 25 })),
		];
		const { container } = render(
			<SkinCanvas
				kind="live"
				scene="streaming"
				card={cardOf(m, "live")}
				selection={null}
				onSelect={vi.fn()}
			/>,
		);
		const grid = container.querySelector("[style*='grid-template-columns']") as HTMLElement;
		expect(grid.style.gridTemplateColumns).toContain("37.500fr");
		expect(grid.style.gridTemplateColumns).toContain("25.000fr");
	});

	it("皮肤没定义这种卡 → 说清楚它跟着出厂默认,不是白屏", () => {
		render(
			<SkinCanvas
				kind="superchat"
				scene="default"
				card={undefined}
				selection={null}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.getByText(/没有定义这种卡/)).toBeTruthy();
	});
});

describe("检查器 · 位置", () => {
	it("改「起始列」→ 改动真的回到草稿(接线断了的话数字变了、草稿没动)", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(blockBtn("创作者名"));

		const input = screen.getByLabelText(/起始列/);
		fireEvent.change(input, { target: { value: "5" } });

		expect(onDraft).toHaveBeenCalled();
		const next = onDraft.mock.calls.at(-1)?.[0] as CardSkinManifest;
		expect(cardOf(next, "live")?.blocks.find((b) => b.id === "name")?.grid.column).toBe(5);
		// 画布跟着动 —— 检查器改完只更新自己的话,左边那格还停在老位置。
		expect(blockBtn("创作者名").style.gridColumn).toBe("6 / span 6");
	});

	it("没选中任何东西 → 检查器请人去点一个,而不是空着", () => {
		render(<Harness />);
		expect(screen.getByText(/在中间画布上点一个块/)).toBeTruthy();
	});
});

describe("添加块 / 删块", () => {
	it.each([
		[
			"en",
			"Add block",
			"Available blocks",
			"Custom block",
			"Write custom HTML using field placeholders such as {creator.name}.",
			"Already added",
		],
		[
			"ja",
			"ブロックを追加",
			"追加できるブロック",
			"カスタムブロック",
			"HTMLを自由に書き、{creator.name} などのプレースホルダーでフィールドを参照できます。",
			"追加済み",
		],
		[
			"zh-TW",
			"新增區塊",
			"可新增的區塊",
			"自訂區塊",
			"自行撰寫 HTML，使用 {creator.name} 等預留位置引用欄位。",
			"已新增",
		],
	] as const)(
		"%s block catalogue localizes while adding a selected custom block without rewriting existing HTML",
		(locale, add, catalogueLabel, custom, hint, used) => {
			const onDraft = vi.fn();
			render(<Harness onDraft={onDraft} />);
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(onDraft).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: add }));
			const choices = screen.getByRole("group", { name: catalogueLabel });
			expect(within(choices).getByText(hint)).toBeTruthy();
			expect(within(choices).getAllByText(used).length).toBeGreaterThan(0);
			fireEvent.click(within(choices).getByRole("button", { name: custom }));
			expect(onDraft).toHaveBeenCalledTimes(1);
			const next = onDraft.mock.calls[0][0] as CardSkinManifest;
			const blocks = next.cards.live?.blocks;
			expect(blocks?.slice(0, 3)).toEqual(manifest().cards.live?.blocks);
			const added = blocks?.at(-1);
			expect(added?.kind).toBe("custom");
			expect(
				document.querySelector(`[data-block-id="${added?.id}"]`)?.getAttribute("aria-pressed"),
			).toBe("true");
		},
	);
	it("添加块 → 目录列出这种卡的内置块,点一个就落在最底下那一行并被选中", () => {
		render(<Harness />);
		expect(screen.queryByText("简介")).toBeNull();

		fireEvent.click(screen.getByText(/添加块/));
		fireEvent.click(within(catalogue()).getByRole("button", { name: /简介/ }));

		// 已有三块占到 r3,新块落在 r4、整宽(画布多一列行号,所以 CSS 上是 2 起跨 12)。
		expect(blockBtn("简介").style.gridRow).toBe("4 / span 1");
		expect(blockBtn("简介").style.gridColumn).toBe("2 / span 12");
		// 加完立刻选中 —— 不选中的话主人得自己再去画布上找那一格才能接着摆。
		expect(blockBtn("简介").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByLabelText(/起始列/)).toBeTruthy();
	});

	it("目录里已经摆上去的块标一句「已有」—— 重复摆封面几乎总是手滑", () => {
		render(<Harness />);
		fireEvent.click(screen.getByText(/添加块/));
		const cover = within(catalogue()).getByRole("button", { name: /封面图/ });
		expect(cover.textContent).toContain("已有");
	});

	it("删块:画布上那格没了,检查器也不再对着它", () => {
		render(<Harness />);
		fireEvent.click(blockBtn("创作者名"));
		fireEvent.click(screen.getByText(/删除这个块/));

		expect(screen.queryByText("创作者名")).toBeNull();
		expect(screen.queryByLabelText(/起始列/)).toBeNull();
		// 剩下的块一个没少。
		expect(blockBtn("封面图")).toBeTruthy();
	});

	it("带内容的块要先问一句 —— 自定义块的 html 删了就找不回来", () => {
		render(<Harness />);
		fireEvent.click(blockBtn("自定义块"));
		fireEvent.click(screen.getByText(/删除这个块/));

		// 还在:问完才删。(画布上一处、检查器的徽章一处,所以数个数。)
		expect(screen.getAllByText("自定义块").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByText("删掉"));
		expect(screen.queryAllByText("自定义块")).toHaveLength(0);
	});

	it("只读的皮肤不给增删的口", () => {
		render(<Harness readOnly />);
		expect(screen.queryByText(/添加块/)).toBeNull();
		fireEvent.click(blockBtn("创作者名"));
		expect(screen.queryByText(/删除这个块/)).toBeNull();
	});
});

/**
 * ㉔d:档位卡(醒目留言 / 会员)的 CSS 一节给皮肤作者一段「按档换色」的说明(`CARD_SKIN_RANK_GUIDE`,与 AI 的规则
 * 提示词同一段):`data-rank` 怎么写、档色变量盖不掉。别的卡没有这段 —— 它们没有「档」。
 * 验红:去掉 `SkinInspector` 里按卡种给的那条说明,或让它对所有卡都显示,这组红。
 */
describe("检查器 · 按档换色的说明", () => {
	it("醒目留言卡:外框的 CSS 与块的 CSS 都带这段说明", () => {
		render(<Harness kind="superchat" />);
		fireEvent.click(screen.getByText("卡片外框"));
		expect(screen.getByText(CARD_SKIN_RANK_GUIDE)).toBeTruthy();
		cleanup();
		render(<Harness kind="superchat" />);
		fireEvent.click(blockBtn("金额"));
		expect(screen.getByText(CARD_SKIN_RANK_GUIDE)).toBeTruthy();
	});

	it("直播卡:没有这段说明(它没有档位)", () => {
		render(<Harness />);
		fireEvent.click(screen.getByText("卡片外框"));
		expect(screen.queryByText(CARD_SKIN_RANK_GUIDE)).toBeNull();
		fireEvent.click(blockBtn("封面图"));
		expect(screen.queryByText(CARD_SKIN_RANK_GUIDE)).toBeNull();
	});
});

describe("检查器 · 卡片外框", () => {
	it.each([
		["en", "Column 1 unit", "Column 1 width", "Column 1", "Fraction"],
		["ja", "1列目の単位", "1列目の幅", "1列目", "比率"],
		["zh-TW", "第 1 欄的單位", "第 1 欄的寬度", "第 1 欄", "比例"],
	] as const)(
		"%s column controls translate without changing units or untouched columns",
		(locale, unit, width, caption, fraction) => {
			const onDraft = vi.fn();
			render(<Harness onDraft={onDraft} />);
			fireEvent.click(screen.getByText("卡片外框"));
			fireEvent.click(screen.getByLabelText("自定义列宽"));
			expect(onDraft).toHaveBeenCalledTimes(1);
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(caption)).toBeTruthy();
			const field = screen.getByRole("group", { name: unit });
			expect(within(field).getByRole("button", { name: fraction })).toBeTruthy();
			expect(onDraft).toHaveBeenCalledTimes(1);
			fireEvent.click(within(field).getByRole("button", { name: "px" }));
			expect((screen.getByLabelText(width) as HTMLInputElement).value).toBe("50");
			fireEvent.change(screen.getByLabelText(width), { target: { value: "24" } });
			const next = lastDraft(onDraft);
			expect(cardOf(next, "live")?.columns?.[0]).toEqual({ px: 24 });
			expect(cardOf(next, "live")?.columns?.slice(1)).toEqual(
				Array.from({ length: 11 }, () => ({ fr: 1 })),
			);
			expect(cardOf(next, "live")?.blocks).toEqual(manifest().cards.live?.blocks);
		},
	);
	/** 最近一次回到调用方的草稿。 */
	const lastDraft = (spy: ReturnType<typeof vi.fn>) =>
		spy.mock.calls.at(-1)?.[0] as CardSkinManifest;

	it("改卡宽 → 改动真的回到草稿", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(screen.getByText("卡片外框"));

		fireEvent.change(screen.getByLabelText(/卡宽/), { target: { value: "480" } });

		expect(cardOf(lastDraft(onDraft), "live")?.width).toBe(480);
		// 画布底下那行摘要跟着动 —— 检查器只更新自己的话,那行还停在老数。
		expect(screen.getByText(/宽 480/)).toBeTruthy();
	});

	it("列宽默认 12 等分,打开「自定义列宽」才落进清单", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(screen.getByText("卡片外框"));
		expect(screen.queryByLabelText("第 9 列的单位")).toBeNull();

		fireEvent.click(screen.getByLabelText("自定义列宽"));

		expect(cardOf(lastDraft(onDraft), "live")?.columns).toHaveLength(12);
		expect(screen.getByLabelText("第 9 列的单位")).toBeTruthy();
	});

	it("把一列换成定宽 → 那一项是 px,其余仍是等分", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(screen.getByText("卡片外框"));
		fireEvent.click(screen.getByLabelText("自定义列宽"));

		// 第 9 列切到 px(上舰卡那枚 175px 徽章就是这么复刻的)。
		fireEvent.click(within(screen.getByLabelText("第 9 列的单位")).getByText("px"));
		fireEvent.change(screen.getByLabelText(/第 9 列的宽度/), { target: { value: "43.75" } });

		const cols = cardOf(lastDraft(onDraft), "live")?.columns;
		expect(cols?.[8]).toEqual({ px: 43.75 });
		expect(cols?.[0]).toEqual({ fr: 1 });
	});

	it("关掉自定义 → 整份 columns 从清单里消失(回到 12 等分)", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(screen.getByText("卡片外框"));
		fireEvent.click(screen.getByLabelText("自定义列宽"));
		fireEvent.click(screen.getByLabelText("自定义列宽"));

		expect("columns" in (cardOf(lastDraft(onDraft), "live") as object)).toBe(false);
	});
});

describe("检查器 · CSS", () => {
	const lastDraft = (spy: ReturnType<typeof vi.fn>) =>
		spy.mock.calls.at(-1)?.[0] as CardSkinManifest;

	it("敲块 CSS → 回到草稿", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(blockBtn("封面图"));

		toSource();
		fireEvent.change(screen.getByLabelText("这个块的 CSS"), {
			target: { value: '[data-bn="self"]{padding:8px}' },
		});

		expect(cardOf(lastDraft(onDraft), "live")?.blocks[0]?.css).toBe(
			'[data-bn="self"]{padding:8px}',
		);
	});

	it("挂点是对外 API,列出来还能点一下补进去 —— 名字记不住是写皮肤第一道坎", () => {
		const onDraft = vi.fn();
		render(<Harness kind="post" onDraft={onDraft} />);
		fireEvent.click(blockBtn("附加内容"));

		// 附加内容块内部有「附加卡」「附加卡封面」「按钮」三个挂点。
		fireEvent.click(within(screen.getByLabelText("这个块的挂点")).getByText("附加卡"));

		expect(cardOf(lastDraft(onDraft), "post")?.blocks[0]?.css).toContain('[data-bn="card"]');
	});

	it("外框的两层挂点摆在外框那一节", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(screen.getByText("卡片外框"));

		toSource();
		fireEvent.change(screen.getByLabelText("外框的 CSS"), {
			target: { value: '[data-bn="glass"]{border-radius:20px}' },
		});

		expect(cardOf(lastDraft(onDraft), "live")?.css).toBe('[data-bn="glass"]{border-radius:20px}');
	});

	it("超了上限当场说 —— 不然是存的时候才被装包门拒", () => {
		render(<Harness />);
		fireEvent.click(blockBtn("封面图"));

		toSource();
		fireEvent.change(screen.getByLabelText("这个块的 CSS"), {
			target: { value: "a".repeat(CARD_SKIN_LIMITS.maxCssBytes + 1) },
		});

		expect(screen.getByText(/存不下去/)).toBeTruthy();
	});
});

describe("检查器 · 显示条件", () => {
	const lastDraft = (spy: ReturnType<typeof vi.fn>) =>
		spy.mock.calls.at(-1)?.[0] as CardSkinManifest;

	it.each([
		[
			"en",
			"Row",
			"Start column",
			"Column span",
			"Row span",
			"Stack order",
			"Display condition",
			"Always show",
			"Remove block",
			"Remove this block?",
			"Cancel",
			"Remove",
			"Block hooks",
			"Whole block",
		],
		[
			"ja",
			"行",
			"開始列",
			"列の占有数",
			"行の占有数",
			"重なり順",
			"表示条件",
			"常に表示",
			"ブロックを削除",
			"このブロックを削除しますか？",
			"キャンセル",
			"削除",
			"ブロックのフック",
			"ブロック全体",
		],
		[
			"zh-TW",
			"列",
			"起始欄",
			"跨欄數",
			"跨列數",
			"堆疊順序",
			"顯示條件",
			"一律顯示",
			"刪除此區塊",
			"刪除此區塊？",
			"取消",
			"刪除",
			"區塊掛點",
			"整個區塊",
		],
	] as const)(
		"%s block controls retain geometry, field paths and cancelled work",
		(locale, row, column, span, rows, z, condition, always, remove, title, cancel, confirm, hooks, whole) => {
			const onDraft = vi.fn();
			render(<Harness onDraft={onDraft} />);
			fireEvent.click(blockBtn("创作者名"));
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(onDraft).not.toHaveBeenCalled();
			for (const [label, value] of [
				[row, "4"],
				[column, "2"],
				[span, "5"],
				[rows, "2"],
				[z, "3"],
			]) {
				fireEvent.change(screen.getByLabelText(new RegExp(`^${label}\\(`)), { target: { value } });
			}
			expect(cardOf(lastDraft(onDraft), "live")?.blocks.find((b) => b.id === "name")?.grid).toEqual(
				{ row: 4, column: 2, span: 5, rowSpan: 2, z: 3 },
			);
			const select = screen.getByRole("combobox", { name: condition });
			chooseSelect(select, always);
			expect(
				cardOf(lastDraft(onDraft), "live")?.blocks.find((b) => b.id === "name"),
			).not.toHaveProperty("showIf");
			chooseSelect(select, /live.isEnded/);
			expect(cardOf(lastDraft(onDraft), "live")?.blocks.find((b) => b.id === "name")?.showIf).toBe(
				"live.isEnded",
			);
			expect(within(screen.getByLabelText(hooks)).getByText(whole)).toBeTruthy();
			act(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
			fireEvent.click(screen.getByRole("button", { name: /notice ·/ }));
			act(() => i18n.set({ locale, voice: "plain" }));
			onDraft.mockClear();
			fireEvent.click(screen.getByRole("button", { name: remove }));
			expect(screen.getByText(title)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: cancel }));
			expect(onDraft).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: remove }));
			fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: confirm }));
			expect(cardOf(lastDraft(onDraft), "live")?.blocks.map((b) => b.id)).toEqual([
				"cover",
				"name",
			]);
		},
	);

	it("候选来自这种卡的字段契约,选一个就写进草稿", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(blockBtn("封面图"));

		chooseSelect(screen.getByRole("combobox", { name: "显示条件" }), /live.isStreaming/);

		expect(cardOf(lastDraft(onDraft), "live")?.blocks[0]?.showIf).toBe("live.isStreaming");
	});

	it("回到「总是显示」→ 键从清单里消失(空串在装包门那头过不了字段路径)", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(blockBtn("创作者名"));

		chooseSelect(screen.getByRole("combobox", { name: "显示条件" }), "总是显示");

		const block = cardOf(lastDraft(onDraft), "live")?.blocks.find((b) => b.id === "name");
		expect("showIf" in (block as object)).toBe(false);
	});

	it("别的卡种的字段不出现在候选里 —— 写进去装包门会拒", () => {
		render(<Harness />);
		fireEvent.click(blockBtn("封面图"));

		const select = screen.getByLabelText("显示条件") as HTMLButtonElement;
		const values = selectOptionsOf(select).map((o) => o.textContent ?? "");
		expect(values.some((v) => v.includes("live.isEnded"))).toBe(true);
		expect(values.some((v) => v.includes("sc."))).toBe(false);
	});
});

/** 草稿里最后那个块的 HTML(自定义块总是加在最后)。 */
const lastHtml = (m: CardSkinManifest): string =>
	(cardOf(m, "live")?.blocks.at(-1) as { html?: string } | undefined)?.html ?? "";

describe("检查器 · 自定义块的内容", () => {
	const lastDraft = (spy: ReturnType<typeof vi.fn>) =>
		spy.mock.calls.at(-1)?.[0] as CardSkinManifest;

	it.each([
		[
			"en",
			"Block HTML",
			"Fields available to this card type",
			"Creator name",
			"Creator avatar",
			"An empty custom block cannot be saved. The package validator checks whether anything remains after sanitizing.",
		],
		[
			"ja",
			"ブロックのHTML",
			"この種類のカードで使えるフィールド",
			"クリエイター名",
			"クリエイターのアバター",
			"空のカスタムブロックは保存できません。パッケージの検証では、安全でない内容を除去した後に何か残っているかを確認します。",
		],
		[
			"zh-TW",
			"區塊 HTML",
			"此類型卡片可使用的欄位",
			"創作者名稱",
			"創作者頭像",
			"空白的自訂區塊無法儲存。套件驗證會檢查清理後是否仍有內容。",
		],
	] as const)(
		"%s HTML editing preserves original content and inserts typed field placeholders",
		(locale, html, fieldsLabel, name, avatar, empty) => {
			const onDraft = vi.fn();
			render(<Harness onDraft={onDraft} />);
			fireEvent.click(screen.getByRole("button", { name: /notice ·/ }));
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(onDraft).not.toHaveBeenCalled();
			expect((screen.getByLabelText(html) as HTMLTextAreaElement).value).toBe("<div>公告</div>");
			const fields = screen.getByLabelText(fieldsLabel);
			fireEvent.click(within(fields).getByText(name));
			fireEvent.click(within(fields).getByText(avatar));
			expect(lastHtml(lastDraft(onDraft))).toBe(
				'<div>公告</div>{creator.name}<img src="{creator.avatar}">',
			);
			fireEvent.change(screen.getByLabelText(html), { target: { value: " " } });
			expect(screen.getByText(empty)).toBeTruthy();
			expect(lastHtml(lastDraft(onDraft))).toBe(" ");
		},
	);

	/** 从目录里添一个自定义块,回它的 id。 */
	function addCustom(): void {
		fireEvent.click(screen.getByText(/添加块/));
		fireEvent.click(within(catalogue()).getByRole("button", { name: /自定义块/ }));
	}

	it("目录里能添自定义块,添完就选中、内容框跟着出来", () => {
		render(<Harness />);
		addCustom();
		expect(screen.getByLabelText("这个块的 HTML")).toBeTruthy();
	});

	it("改内容 → 回到草稿", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		addCustom();

		fireEvent.change(screen.getByLabelText("这个块的 HTML"), {
			target: { value: "<div>{creator.name}</div>" },
		});

		expect(lastHtml(lastDraft(onDraft))).toBe("<div>{creator.name}</div>");
	});

	it("字段点一下补进去;图片字段补的是一整个 img —— 占位符只能坐在 src 上", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		addCustom();
		const fields = screen.getByLabelText("这种卡能引用的字段");

		fireEvent.click(within(fields).getByText("创作者名"));
		expect(lastHtml(lastDraft(onDraft))).toContain("{creator.name}");

		fireEvent.click(within(fields).getByText("创作者头像"));
		expect(lastHtml(lastDraft(onDraft))).toContain('<img src="{creator.avatar}">');
	});

	it("清空内容当场说一句 —— 装包门那头判的是「清洗后什么都不剩」", () => {
		render(<Harness />);
		addCustom();

		fireEvent.change(screen.getByLabelText("这个块的 HTML"), { target: { value: "  " } });

		expect(screen.getByText(/什么都不剩/)).toBeTruthy();
	});

	it("内置块没有内容框 —— 它画的是模板里那一段", () => {
		render(<Harness />);
		fireEvent.click(blockBtn("封面图"));
		expect(screen.queryByLabelText("这个块的 HTML")).toBeNull();
	});
});

describe("接管 / 交还一种卡", () => {
	it.each([
		[
			"en",
			"Loading built-in skin…",
			"Customize this card",
			"This skin does not define this card type. Rendering uses the built-in default skin.",
		],
		[
			"ja",
			"内蔵スキンを読み込み中…",
			"このカードをカスタマイズ",
			"このスキンにはこの種類のカードがありません。描画時は内蔵の既定スキンを使います。",
		],
		[
			"zh-TW",
			"正在讀取內建外觀…",
			"自訂此類型卡片",
			"此外觀未定義此類型的卡片，繪製時使用內建預設外觀。",
		],
	] as const)(
		"%s adoption hints translate while waiting for the built-in definition and adopt only on click",
		(locale, loading, adopt, hint) => {
			const onAdopt = vi.fn();
			const onSelect = vi.fn();
			const view = render(
				<SkinCanvas
					kind="live"
					scene="streaming"
					card={undefined}
					selection={null}
					onSelect={onSelect}
					onAdopt={onAdopt}
					adoptBusy
				/>,
			);
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(hint)).toBeTruthy();
			expect((screen.getByRole("button", { name: loading }) as HTMLButtonElement).disabled).toBe(
				true,
			);
			expect(onAdopt).not.toHaveBeenCalled();
			view.rerender(
				<SkinCanvas
					kind="live"
					scene="streaming"
					card={undefined}
					selection={null}
					onSelect={onSelect}
					onAdopt={onAdopt}
					adoptBusy={false}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: adopt }));
			expect(onAdopt).toHaveBeenCalledTimes(1);
			expect(onSelect).not.toHaveBeenCalled();
		},
	);
	it("皮肤没定义这种卡 → 画布上就给一颗「接管」钮,不用去别处找", () => {
		const onAdopt = vi.fn();
		render(
			<SkinCanvas
				kind="superchat"
				scene="default"
				card={undefined}
				selection={null}
				onSelect={vi.fn()}
				onAdopt={onAdopt}
			/>,
		);
		fireEvent.click(screen.getByText(/接管这种卡/));
		expect(onAdopt).toHaveBeenCalled();
	});

	it("出厂皮肤还没读到时那颗钮禁着 —— 接管要抄的就是它", () => {
		render(
			<SkinCanvas
				kind="superchat"
				scene="default"
				card={undefined}
				selection={null}
				onSelect={vi.fn()}
				onAdopt={vi.fn()}
				adoptBusy
			/>,
		);
		expect((screen.getByText(/出厂皮肤/).closest("button") as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("只读的皮肤不给接管的口", () => {
		render(
			<SkinCanvas
				kind="superchat"
				scene="default"
				card={undefined}
				selection={null}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.queryByText(/接管这种卡/)).toBeNull();
	});

	it("交还要先问一句 —— 整张卡的活儿一次没了", () => {
		const onDropCard = vi.fn();
		render(
			<SkinInspector
				manifest={manifest()}
				kind="live"
				selection={{ kind: "frame" }}
				onGrid={vi.fn()}
				onCss={vi.fn()}
				onHtml={vi.fn()}
				onShowIf={vi.fn()}
				onFrame={vi.fn()}
				onFrameCss={vi.fn()}
				onColumns={vi.fn()}
				onDropCard={onDropCard}
			/>,
		);
		fireEvent.click(screen.getByText(/交还给默认/));
		expect(onDropCard).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("交还"));
		expect(onDropCard).toHaveBeenCalled();
	});
});

/**
 * **块的层次**(2026-09-15 主人拍板「重叠是特性,补层次控制」)。
 *
 * 画布的职责是**如实反映出图**,所以它必须按同一份层次叠 —— 编辑器里看到的顺序和推出去
 * 的图对不上,比不给层次还糟。
 */
describe("画布 — 块的层次", () => {
	const withBlocks = (
		blocks: Array<Record<string, unknown>>,
		selection: SkinSelection | null = null,
	) => {
		render(
			<SkinCanvas
				kind="live"
				scene="streaming"
				card={{ width: 600, blocks } as never}
				selection={selection}
				onSelect={vi.fn()}
			/>,
		);
	};

	const chip = (name: RegExp) => screen.getByRole("button", { name });

	it("层次落成 wrapper 的 z-index —— 画布与出图按同一个数叠", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			{
				id: "name",
				kind: "builtin",
				builtin: "creatorName",
				grid: { row: 1, column: 9, span: 4, z: 2 },
			},
		]);
		expect(chip(/UP 主名|name/).style.zIndex).toBe("2");
	});

	it("不写层次就不写 z-index —— 交还给块的先后(与渲染器同一条规矩)", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
		]);
		expect(chip(/封面|cover/).style.zIndex).toBe("");
	});

	it("叠了不写字 —— 深浅自己说(主人 2026-09-15 拍板,别再退回计数)", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			{
				id: "name",
				kind: "builtin",
				builtin: "creatorName",
				grid: { row: 1, column: 9, span: 4, z: 2 },
			},
		]);
		expect(chip(/封面|cover/).textContent).not.toContain("叠");
		expect(chip(/UP 主名|name/).textContent).not.toContain("叠");
	});

	it("压着别人的块抬起来 —— 走 shadow-bn-elev,不写死影子", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			{
				id: "name",
				kind: "builtin",
				builtin: "creatorName",
				grid: { row: 1, column: 9, span: 4, z: 2 },
			},
		]);
		expect(chip(/UP 主名|name/).className).toContain("shadow-bn-elev");
		expect(chip(/封面|cover/).className).not.toContain("shadow-bn-elev");
	});

	it("往右下浮的是**上面那块**,被压住的停在自己真正的格子上", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			{
				id: "name",
				kind: "builtin",
				builtin: "creatorName",
				grid: { row: 1, column: 1, span: 12, z: 2 },
			},
		]);
		// 被压住的不动 —— 它往左退的话会撞上左边的邻居(主人 2026-09-18 指着截图报的:
		// 「重叠导致底下的和旁边的完全挨着了」)。
		const under = chip(/封面|cover/);
		expect([under.style.top, under.style.left]).toEqual(["", ""]);
		// 上面那块往右下让开一格,露出底下那块的左边缘 —— 完全盖住时那条露边是它唯一的痕迹。
		const over = chip(/UP 主名|name/);
		expect([over.style.top, over.style.left]).toEqual(["4px", "8px"]);
	});

	it("再深也只有一档 —— 三重及以上不表达(主人 2026-09-18 拍板)", () => {
		// 五个摞在同一格:拖拽已经拦到两层,这种只可能是手写 / 别人分享的皮肤装进来。
		// 画布不为它们造第三档,谁压着人谁就让开那一格,仅此而已。
		const stacked = (builtin: string) => ({
			id: builtin,
			kind: "builtin",
			builtin,
			grid: { row: 1, column: 1, span: 12 },
		});
		withBlocks(["cover", "creatorName", "title", "description", "currentViewers"].map(stacked));
		expect(chip(/cover/).style.left).toBe("");
		for (const id of [/creatorName/, /description/, /currentViewers/]) {
			expect(chip(id).style.left, String(id)).toBe("8px");
		}
	});

	it("选中一个压着别人的块,底仍然不透明 —— 选中态不许自己去糊一层纱", () => {
		withBlocks(
			[
				{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
				{
					id: "name",
					kind: "builtin",
					builtin: "creatorName",
					grid: { row: 1, column: 1, span: 12, z: 2 },
				},
			],
			{ kind: "block", id: "name" },
		);
		const over = chip(/UP 主名|name/);
		// 选中态**整句吃库里那句语汇**:它的粉调底是 color-mix 落在 surface 上出的
		// **不透明**色。手抄 `bg-bn-pink/N` 那类纱,被压住那块的字会直接透上来,
		// 两块的字叠在一起谁都读不了(2026-09-16 主人报的)。
		expect(over.className).toContain(SELECTED_LANGUAGE);
		expect(over.className).not.toMatch(/bg-bn-pink\/\d/);
	});

	it("同行不同列不算叠 —— 那是分栏,决策 6 要的就是它;不抬也不错位", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 4 } },
			{ id: "name", kind: "builtin", builtin: "creatorName", grid: { row: 1, column: 5, span: 8 } },
		]);
		expect(chip(/封面|cover/).style.top).toBe("");
		expect(chip(/UP 主名|name/).className).not.toContain("shadow-bn-elev");
	});
});

/**
 * **画布只摆这一场会有的块,而且和出图一样紧**(ADR-0014 决策 10 的 2026-09-19 🔗)。
 *
 * 上一版靠预览框回报「这一场画了谁」再给没画的挂个「这一场不画」的灰壳,主人在面板上
 * 看到的是一堆空块、点一下还乱跳。这一版**由目录说了算**:图廊只属图文,视频那场一点
 * 痕迹都不留;整行没块的行也压掉 —— 画布上的行号是压后的,行号列印的仍是真行号。
 */
describe("网格画布 — 只摆这一场的块,和出图一样紧", () => {
	const blocks = [
		{
			id: "avatar",
			kind: "builtin",
			builtin: "creatorAvatar",
			grid: { row: 1, column: 1, span: 3 },
		},
		{
			id: "video-cover",
			kind: "builtin",
			builtin: "videoCover",
			grid: { row: 2, column: 1, span: 12, rowSpan: 3 },
		},
		{
			id: "pics",
			kind: "builtin",
			builtin: "images",
			grid: { row: 2, column: 1, span: 12, rowSpan: 2 },
		},
		{ id: "like", kind: "builtin", builtin: "likeCount", grid: { row: 6, column: 1, span: 4 } },
	];
	const canvas = (scene: string, over: Record<string, unknown> = {}) =>
		render(
			<SkinCanvas
				kind="post"
				card={{ width: 600, blocks } as never}
				selection={null}
				onSelect={vi.fn()}
				scene={scene}
				{...over}
			/>,
		);
	const blockEl = (id: string) =>
		document.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null;
	const rowLabels = () =>
		Array.from(document.querySelectorAll('[data-canvas-track="row"]')).map((el) => el.textContent);

	it("视频那场:图廊一点痕迹都不留;图文那场反过来", () => {
		canvas("video");
		expect(blockEl("video-cover")).toBeTruthy();
		expect(blockEl("pics")).toBeNull();
		expect(document.body.textContent).not.toContain("这一场不画");
		cleanup();
		canvas("pics");
		expect(blockEl("pics")).toBeTruthy();
		expect(blockEl("video-cover")).toBeNull();
	});

	it("共有块每一场都在", () => {
		for (const scene of ["text", "video", "pics", "forward"]) {
			canvas(scene);
			expect(blockEl("avatar")).toBeTruthy();
			expect(blockEl("like")).toBeTruthy();
			cleanup();
		}
	});

	it("独有块挂「图文专属」,共有块什么都不挂", () => {
		canvas("pics");
		expect(blockEl("pics")?.textContent).toContain("图文专属");
		expect(blockEl("avatar")?.textContent).not.toContain("专属");
	});

	it("整行没块的行压掉:块按压后行号落位,行号列印真行号", () => {
		// 图文那场真行 1、2–3、6 有块;4、5 空着 → 互动数落在画布第 4 行。
		canvas("pics");
		expect(blockEl("pics")?.style.gridRow).toBe("2 / span 2");
		expect(blockEl("like")?.style.gridRow).toBe("4 / span 1");
		// 最后一条是「添加块」的备用行:真第 7 行。
		expect(rowLabels()).toEqual(["r1", "r2", "r3", "r6", "r7"]);
		cleanup();
		// 视频那场封面跨 3 行,把 2–4 都占了,只有第 5 行空 → 互动数落在画布第 5 行。
		canvas("video");
		expect(blockEl("like")?.style.gridRow).toBe("5 / span 1");
		expect(rowLabels()).toEqual(["r1", "r2", "r3", "r4", "r6", "r7"]);
	});

	it("叠放只看这一场的块 —— 图廊在数组里排在封面后面、占同一片行,但图文那场它底下什么都没有", () => {
		canvas("pics");
		expect(blockEl("pics")?.className).not.toContain("shadow-bn-elev");
		expect(blockEl("pics")?.style.left).toBe("");
	});

	it("加块目录里独有块也打标,共有块不打", () => {
		canvas("text", { onAdd: vi.fn() });
		fireEvent.click(screen.getByRole("button", { name: /添加块/ }));
		const catalogue = screen.getByRole("group", { name: "可以添加的块" });
		expect(within(catalogue).getByRole("button", { name: /图廊/ }).textContent).toContain(
			"图文专属",
		);
		expect(within(catalogue).getByRole("button", { name: /视频封面/ }).textContent).toContain(
			"视频投稿专属",
		);
		expect(within(catalogue).getByRole("button", { name: /^头像/ }).textContent).not.toContain(
			"专属",
		);
	});
});

/**
 * **行高印在行号旁边**(2026-09-20 主人问「大家占的行都一样多,为什么容器高度不一致」)。
 *
 * 真因是行轨道 `auto`、高度由内容撑(实测 SC 卡七行:54/31/16/82/39/26/52.8,而画布按 56
 * 等高画出来是 392 对真卡的 300.8)。**画布的行不改成按真高度画** —— 那版 2026-09-18 做过
 * 又撤回(ADR-0014 决策 6 的 🔗),而且**列稳行抖**:列宽只在改列定义 / 卡宽时变,行高改一个
 * 字就变,画布会跟着预览一路跳。改成把真高度**说出来**:数字跳一下不影响布局。
 *
 * 量不到就只印行号 —— 退回那条路必须一直活着(预览还没出来、只读态、jsdom 里都走它)。
 */
describe("网格画布 · 行高印在行号旁", () => {
	const card = manifest().cards.live;

	const paint = (rowHeights: readonly number[] | null) =>
		render(
			<SkinCanvas
				kind="live"
				card={card}
				selection={null}
				onSelect={() => {}}
				scene={CARD_PREVIEW_SCENES.live[0]?.id ?? ""}
				rowHeights={rowHeights}
			/>,
		);

	/** 行号列里那一格的全部文字。 */
	const rowLabel = (n: number): string =>
		document.querySelector(`[data-canvas-track="row"][data-canvas-index="${n}"]`)?.textContent ??
		"";

	it("量到行高 → 行号底下印出来", () => {
		paint([54, 31, 16]);
		expect(rowLabel(1)).toContain("r1");
		expect(rowLabel(1)).toContain("54");
		expect(rowLabel(2)).toContain("31");
	});

	it("量不到 → 只印行号,一个数字都不多", () => {
		paint(null);
		expect(rowLabel(1)).toBe("r1");
	});

	// 画布最后多画一条空行当新块的落点,它在真卡里**没有对应的轨道** —— 印一个凭空的数字
	// 比不印更糟。
	it("最后那条空行没有对应轨道 → 不印高度", () => {
		paint([54, 31, 16]);
		expect(rowLabel(4)).toBe("r4");
	});
});

/**
 * **画布指哪一格,真卡就亮哪一格**(2026-09-20 主人要的)。画布这一侧只管报「指到谁了」,
 * 点亮归预览框那边(它往框里那份文档上打标记)。
 *
 * 这条线也是**静默的**:不报的话画布照旧好使,只是真卡那头永远不亮。所以剪断必红。
 */
describe("网格画布 · 指到哪个块就报出来", () => {
	const card = manifest().cards.live;

	function paint(onHover: (id: string | null) => void) {
		return render(
			<SkinCanvas
				kind="live"
				card={card}
				selection={null}
				onSelect={() => {}}
				scene={CARD_PREVIEW_SCENES.live[0]?.id ?? ""}
				onHover={onHover}
			/>,
		);
	}

	const blockEl = (id: string): Element => {
		const el = document.querySelector(`[data-block-id="${id}"]`);
		if (!el) throw new Error(`画布上没有「${id}」这一块`);
		return el;
	};

	it("指进一个块 → 报它的 id;指走 → 报 null", () => {
		const got: (string | null)[] = [];
		paint((id) => got.push(id));
		fireEvent.pointerEnter(blockEl("cover"));
		expect(got).toEqual(["cover"]);
		fireEvent.pointerLeave(blockEl("cover"));
		expect(got).toEqual(["cover", null]);
	});

	it("换一个块 → 报新的那个", () => {
		const got: (string | null)[] = [];
		paint((id) => got.push(id));
		fireEvent.pointerEnter(blockEl("cover"));
		fireEvent.pointerEnter(blockEl("notice"));
		expect(got.at(-1)).toBe("notice");
	});
});

it.each([
	[
		"ja",
		"ご主人様、このスキンにはこの種類のカードがありません。描画には内蔵の既定スキンを使いますよ。",
		"ご主人様、このカードにはすでに40個のブロックがあります。これ以上は追加できませんよ。",
		"ブロックを追加",
	],
	[
		"zh-TW",
		"主人，這套外觀沒有定義此類型的卡片，出圖時會使用內建預設外觀喔。",
		"主人，這張卡已經有 40 個區塊，不能再新增了喔。",
		"新增區塊",
	],
] as const)("%s 女仆画布回落与块上限说明不自动接管或增加块", (locale, missing, full, add) => {
	const onSelect = vi.fn();
	const onAdopt = vi.fn();
	const onAdd = vi.fn();
	const view = render(
		<SkinCanvas
			kind="live"
			scene="streaming"
			card={undefined}
			selection={null}
			onSelect={onSelect}
			onAdopt={onAdopt}
		/>,
	);
	act(() => i18n.set({ locale, voice: "maid" }));
	expect(screen.getByText(missing)).toBeTruthy();
	expect(onAdopt).not.toHaveBeenCalled();
	expect(onSelect).not.toHaveBeenCalled();
	const base = cardOf(manifest(), "live");
	if (!base) throw new Error("Missing fixture card");
	const card = {
		...base,
		blocks: Array.from({ length: 40 }, (_, i) => ({
			id: `original-${i}`,
			kind: "builtin" as const,
			builtin: "creatorName",
			grid: { row: i + 1, column: 1, span: 12 },
		})),
	};
	view.rerender(
		<SkinCanvas
			kind="live"
			scene="streaming"
			card={card}
			selection={null}
			onSelect={onSelect}
			onAdd={onAdd}
		/>,
	);
	expect(screen.getByText(full)).toBeTruthy();
	expect(screen.queryByRole("button", { name: add })).toBeNull();
	expect(onAdd).not.toHaveBeenCalled();
	expect(onSelect).not.toHaveBeenCalled();
});
