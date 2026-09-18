// @vitest-environment jsdom

/**
 * 网格画布 + 检查器那条回路(ADR-0014 决策 6 / 20 / 21)。
 *
 * 钉的都是**接线**,不是长相 —— 零件各自的单元测试全绿证明不了两个零件真接上了:
 * ① 块按 `column` / `span` 落在正确的 grid 位置(画布多一列行号,少 +1 就整排歪掉,
 * 而页面看着还是一排块);② 点一下真的选中;③ 检查器里改一个数,**改动真的回到调用方**
 * (断了的话界面上数字变了、草稿一个字没动);④ 皮肤没定义这种卡时说人话而不是白屏。
 */

import type { CardSkinManifest } from "@bilibili-notify/contract";
import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { SELECTED_LANGUAGE } from "@bilibili-notify/ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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

const manifest = (): CardSkinManifest =>
	({
		schemaVersion: 1,
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
						builtin: "name",
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
		},
	}) as unknown as CardSkinManifest;

/**
 * 画布 + 检查器接在一份真草稿上 —— 这条回路正是要钉的东西。接线与 `CardSkinEditor`
 * 那头同形:增删块都是「换草稿 + 顺手把选中挪到该在的地方」。
 */
function Harness({
	onDraft,
	readOnly,
}: {
	onDraft?: (m: CardSkinManifest) => void;
	/** 只读时不给增删的口 —— 内置皮肤那档,控件根本不该出现。 */
	readOnly?: boolean;
}) {
	const [draft, setDraft] = useState<CardSkinManifest>(manifest());
	const [selection, setSelection] = useState<SkinSelection>(null);
	return (
		<div>
			<SkinCanvas
				kind="live"
				card={cardOf(draft, "live")}
				selection={selection}
				onSelect={setSelection}
				onAdd={
					readOnly
						? undefined
						: (builtin) => {
								const added = addBlock(draft, "live", builtin);
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
								const added = addCustomBlock(draft, "live");
								if (!added) return;
								setDraft(added.manifest);
								onDraft?.(added.manifest);
								setSelection({ kind: "block", id: added.blockId });
							}
				}
			/>
			<SkinInspector
				manifest={draft}
				kind="live"
				selection={selection}
				onGrid={(id, patch) =>
					setDraft((d) => {
						const next = setBlockGrid(d, "live", id, patch);
						onDraft?.(next);
						return next;
					})
				}
				onHtml={(id, html) =>
					setDraft((d) => {
						const next = setBlockHtml(d, "live", id, html);
						onDraft?.(next);
						return next;
					})
				}
				onShowIf={(id, path) =>
					setDraft((d) => {
						const next = setBlockShowIf(d, "live", id, path);
						onDraft?.(next);
						return next;
					})
				}
				onCss={(id, css) =>
					setDraft((d) => {
						const next = setBlockCss(d, "live", id, css);
						onDraft?.(next);
						return next;
					})
				}
				onFrameCss={(css) =>
					setDraft((d) => {
						const next = setFrameCss(d, "live", css);
						onDraft?.(next);
						return next;
					})
				}
				onFrame={(patch) =>
					setDraft((d) => {
						const next = setFrame(d, "live", patch);
						onDraft?.(next);
						return next;
					})
				}
				onColumns={(cols) =>
					setDraft((d) => {
						const next = setColumns(d, "live", cols);
						onDraft?.(next);
						return next;
					})
				}
				onRemove={
					readOnly
						? undefined
						: (id) => {
								setDraft((d) => {
									const next = removeBlock(d, "live", id);
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
	it("块落在正确的 grid 位置 —— 行号占掉第一列,所以起始列要 +1", () => {
		render(<Harness />);
		// name 块:column 3 / span 6 → CSS 上是 4 起跨 6。
		expect(blockBtn("主播名").style.gridColumn).toBe("4 / span 6");
		expect(blockBtn("主播名").style.gridRow).toBe("2 / span 1");
		expect(blockBtn("封面图").style.gridColumn).toBe("2 / span 12");
	});

	it("三档来历各挂各的徽章,showIf 也标出来", () => {
		render(<Harness />);
		expect(blockBtn("封面图").textContent).toContain("内置");
		expect(blockBtn("主播名").textContent).toContain("原子");
		expect(blockBtn("主播名").textContent).toContain("showIf");
		expect(blockBtn("自定义块").textContent).toContain("自定义");
	});

	it("点一下就选中(aria-pressed 是可查询的事实,不是一层 class)", () => {
		render(<Harness />);
		expect(blockBtn("主播名").getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(blockBtn("主播名"));
		expect(blockBtn("主播名").getAttribute("aria-pressed")).toBe("true");
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
			<SkinCanvas kind="live" card={cardOf(m, "live")} selection={null} onSelect={vi.fn()} />,
		);
		const grid = container.querySelector("[style*='grid-template-columns']") as HTMLElement;
		expect(grid.style.gridTemplateColumns).toContain("37.500fr");
		expect(grid.style.gridTemplateColumns).toContain("25.000fr");
	});

	it("皮肤没定义这种卡 → 说清楚它跟着出厂默认,不是白屏", () => {
		render(<SkinCanvas kind="sc" card={undefined} selection={null} onSelect={vi.fn()} />);
		expect(screen.getByText(/没有定义这种卡/)).toBeTruthy();
	});
});

describe("检查器 · 位置", () => {
	it("改「起始列」→ 改动真的回到草稿(接线断了的话数字变了、草稿没动)", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(blockBtn("主播名"));

		const input = screen.getByLabelText(/起始列/);
		fireEvent.change(input, { target: { value: "5" } });

		expect(onDraft).toHaveBeenCalled();
		const next = onDraft.mock.calls.at(-1)?.[0] as CardSkinManifest;
		expect(cardOf(next, "live")?.blocks.find((b) => b.id === "name")?.grid.column).toBe(5);
		// 画布跟着动 —— 检查器改完只更新自己的话,左边那格还停在老位置。
		expect(blockBtn("主播名").style.gridColumn).toBe("6 / span 6");
	});

	it("没选中任何东西 → 检查器请人去点一个,而不是空着", () => {
		render(<Harness />);
		expect(screen.getByText(/在中间画布上点一个块/)).toBeTruthy();
	});
});

describe("添加块 / 删块", () => {
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
		fireEvent.click(blockBtn("主播名"));
		fireEvent.click(screen.getByText(/删除这个块/));

		expect(screen.queryByText("主播名")).toBeNull();
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
		fireEvent.click(blockBtn("主播名"));
		expect(screen.queryByText(/删除这个块/)).toBeNull();
	});
});

describe("检查器 · 卡片外框", () => {
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

		fireEvent.change(screen.getByLabelText("这个块的 CSS"), {
			target: { value: '[data-bn="self"]{padding:8px}' },
		});

		expect(cardOf(lastDraft(onDraft), "live")?.blocks[0]?.css).toBe(
			'[data-bn="self"]{padding:8px}',
		);
	});

	it("挂点是对外 API,列出来还能点一下补进去 —— 名字记不住是写皮肤第一道坎", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(blockBtn("封面图"));

		// 封面块内部有「封面」与「状态角标」两个挂点。
		fireEvent.click(within(screen.getByLabelText("这个块的挂点")).getByText("封面"));

		expect(cardOf(lastDraft(onDraft), "live")?.blocks[0]?.css).toContain('[data-bn="image"]');
	});

	it("外框的两层挂点摆在外框那一节", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(screen.getByText("卡片外框"));

		fireEvent.change(screen.getByLabelText("外框的 CSS"), {
			target: { value: '[data-bn="glass"]{border-radius:20px}' },
		});

		expect(cardOf(lastDraft(onDraft), "live")?.css).toBe('[data-bn="glass"]{border-radius:20px}');
	});

	it("超了上限当场说 —— 不然是存的时候才被装包门拒", () => {
		render(<Harness />);
		fireEvent.click(blockBtn("封面图"));

		fireEvent.change(screen.getByLabelText("这个块的 CSS"), {
			target: { value: "a".repeat(CARD_SKIN_LIMITS.maxCssBytes + 1) },
		});

		expect(screen.getByText(/存不下去/)).toBeTruthy();
	});
});

describe("检查器 · 显示条件", () => {
	const lastDraft = (spy: ReturnType<typeof vi.fn>) =>
		spy.mock.calls.at(-1)?.[0] as CardSkinManifest;

	it("候选来自这种卡的字段契约,选一个就写进草稿", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(blockBtn("封面图"));

		fireEvent.change(screen.getByLabelText("显示条件"), {
			target: { value: "live.isStreaming" },
		});

		expect(cardOf(lastDraft(onDraft), "live")?.blocks[0]?.showIf).toBe("live.isStreaming");
	});

	it("回到「总是显示」→ 键从清单里消失(空串在装包门那头过不了字段路径)", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		fireEvent.click(blockBtn("主播名"));

		fireEvent.change(screen.getByLabelText("显示条件"), { target: { value: "" } });

		const block = cardOf(lastDraft(onDraft), "live")?.blocks.find((b) => b.id === "name");
		expect("showIf" in (block as object)).toBe(false);
	});

	it("别的卡种的字段不出现在候选里 —— 写进去装包门会拒", () => {
		render(<Harness />);
		fireEvent.click(blockBtn("封面图"));

		const select = screen.getByLabelText("显示条件") as HTMLSelectElement;
		const values = Array.from(select.options).map((o) => o.value);
		expect(values).toContain("live.isEnded");
		expect(values.some((v) => v.startsWith("sc."))).toBe(false);
	});
});

/** 草稿里最后那个块的 HTML(自定义块总是加在最后)。 */
const lastHtml = (m: CardSkinManifest): string =>
	(cardOf(m, "live")?.blocks.at(-1) as { html?: string } | undefined)?.html ?? "";

describe("检查器 · 自定义块的内容", () => {
	const lastDraft = (spy: ReturnType<typeof vi.fn>) =>
		spy.mock.calls.at(-1)?.[0] as CardSkinManifest;

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
			target: { value: "<div>{up.name}</div>" },
		});

		expect(lastHtml(lastDraft(onDraft))).toBe("<div>{up.name}</div>");
	});

	it("字段点一下补进去;图片字段补的是一整个 img —— 占位符只能坐在 src 上", () => {
		const onDraft = vi.fn();
		render(<Harness onDraft={onDraft} />);
		addCustom();
		const fields = screen.getByLabelText("这种卡能引用的字段");

		fireEvent.click(within(fields).getByText("主播名"));
		expect(lastHtml(lastDraft(onDraft))).toContain("{up.name}");

		fireEvent.click(within(fields).getByText("主播头像"));
		expect(lastHtml(lastDraft(onDraft))).toContain('<img src="{up.face}">');
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
	it("皮肤没定义这种卡 → 画布上就给一颗「接管」钮,不用去别处找", () => {
		const onAdopt = vi.fn();
		render(
			<SkinCanvas
				kind="sc"
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
				kind="sc"
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
		render(<SkinCanvas kind="sc" card={undefined} selection={null} onSelect={vi.fn()} />);
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
			{ id: "name", kind: "builtin", builtin: "name", grid: { row: 1, column: 9, span: 4, z: 2 } },
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
			{ id: "name", kind: "builtin", builtin: "name", grid: { row: 1, column: 9, span: 4, z: 2 } },
		]);
		expect(chip(/封面|cover/).textContent).not.toContain("叠");
		expect(chip(/UP 主名|name/).textContent).not.toContain("叠");
	});

	it("压着别人的块抬起来 —— 走 shadow-bn-elev,不写死影子", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			{ id: "name", kind: "builtin", builtin: "name", grid: { row: 1, column: 9, span: 4, z: 2 } },
		]);
		expect(chip(/UP 主名|name/).className).toContain("shadow-bn-elev");
		expect(chip(/封面|cover/).className).not.toContain("shadow-bn-elev");
	});

	it("被压住的块往左上错一点 —— 完全盖住时那条露边是它唯一的痕迹", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			{ id: "name", kind: "builtin", builtin: "name", grid: { row: 1, column: 1, span: 12, z: 2 } },
		]);
		const under = chip(/封面|cover/);
		// 整摞居中放:被压的往上 4、压着别人的往下 4 —— 两层之间还是 8px 的落差,
		// 但谁都只占半个行距,不贴上一行也不贴下一行。
		expect([under.style.top, under.style.left]).toEqual(["-4px", "-8px"]);
		const over = chip(/UP 主名|name/);
		expect([over.style.top, over.style.left]).toEqual(["4px", ""]);
	});

	it("压得越深往左错得越多,但到两档为止", () => {
		// **五个**摞在同一格:最底下那块被压了 4 层,封顶才看得出来(三个块最深才 2 层,
		// 那个例子离了封顶也不会坏)。
		const stacked = (builtin: string) => ({
			id: builtin,
			kind: "builtin",
			builtin,
			grid: { row: 1, column: 1, span: 12 },
		});
		withBlocks(["cover", "name", "title", "desc", "popularity"].map(stacked));
		expect(chip(/cover/).style.left).toBe("-16px");
		expect(chip(/desc/).style.left).toBe("-8px");
		expect(chip(/popularity/).style.left).toBe("");
	});

	it("纵向只有三档 —— 再深也不超出半个行距,两头都叠着的就不动", () => {
		const stacked = (builtin: string) => ({
			id: builtin,
			kind: "builtin",
			builtin,
			grid: { row: 1, column: 1, span: 12 },
		});
		withBlocks(["cover", "name", "title", "desc", "popularity"].map(stacked));
		expect(chip(/cover/).style.top).toBe("-4px");
		expect(chip(/desc/).style.top).toBe("");
		expect(chip(/popularity/).style.top).toBe("4px");
	});

	it("选中一个压着别人的块,底仍然不透明 —— 选中态不许自己去糊一层纱", () => {
		withBlocks(
			[
				{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
				{
					id: "name",
					kind: "builtin",
					builtin: "name",
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
			{ id: "name", kind: "builtin", builtin: "name", grid: { row: 1, column: 5, span: 8 } },
		]);
		expect(chip(/封面|cover/).style.top).toBe("");
		expect(chip(/UP 主名|name/).className).not.toContain("shadow-bn-elev");
	});
});

/**
 * 空行在画布上留着(排版时好用),出图那头会被压掉 —— 两边就此对不上一件事,得说出来。
 * 真要留白就摆一个空白块:块占着那一行,压行就不会把它收走(主人 2026-09-15 拍板)。
 */
describe("网格画布 — 空行", () => {
	const withBlocks = (blocks: Array<Record<string, unknown>>) => {
		render(
			<SkinCanvas
				kind="live"
				card={{ width: 600, blocks } as never}
				selection={null}
				onSelect={vi.fn()}
			/>,
		);
	};

	const notes = () => screen.queryAllByTestId("empty-row-note");

	it("中间的空行标一句「出图时收掉」,并给出留白的走法", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			{ id: "name", kind: "builtin", builtin: "name", grid: { row: 4, column: 1, span: 12 } },
		]);
		expect(notes().map((n) => n.style.gridRow)).toEqual(["2", "3"]);
		expect(notes()[0].textContent).toContain("出图时收掉");
		expect(notes()[0].textContent).toContain("空白块");
	});

	it("有块的行不标", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			{ id: "name", kind: "builtin", builtin: "name", grid: { row: 2, column: 1, span: 12 } },
		]);
		expect(notes()).toHaveLength(0);
	});

	it("跨行的块把中间行占着 —— 那几行不是空行", () => {
		withBlocks([
			{
				id: "cover",
				kind: "builtin",
				builtin: "cover",
				grid: { row: 1, column: 1, span: 12, rowSpan: 3 },
			},
			{ id: "name", kind: "builtin", builtin: "name", grid: { row: 4, column: 1, span: 12 } },
		]);
		expect(notes()).toHaveLength(0);
	});

	it("最后那一行是「添加块」的落点,不算空行", () => {
		withBlocks([
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
		]);
		expect(notes()).toHaveLength(0);
	});
});

/**
 * **画布跟着预览场景**(2026-09-18 主人反馈:各个场景画布都一样)。
 *
 * 画布画的是皮肤 JSON,而 JSON 只有一份;真卡却是分场景的 —— `showIf` 判假、或者内置块
 * 这一场没数据,整块就不画。不说出来,主人对着一堆块猜哪些这会儿有用。
 *
 * 钉的是**「标出来了」而不是「藏起来」**:不画的块照旧在原地、照旧选得中拖得动 ——
 * 编辑器就是要让人改那些块,按场景把它们收走等于没法编辑。
 */
describe("SkinCanvas · 这一场画不画", () => {
	const canvas = (drawn?: readonly string[] | null) =>
		render(
			<SkinCanvas
				kind="live"
				card={cardOf(manifest(), "live")}
				selection={null}
				onSelect={() => {}}
				drawn={drawn}
			/>,
		);

	const blockEl = (root: HTMLElement, id: string) =>
		root.querySelector(`[data-block-id="${id}"]`) as HTMLElement;

	it("这一场没画出来的块标出来,画了的不标", () => {
		const view = canvas(["cover"]);
		expect(blockEl(view.container, "name").textContent).toContain("这一场不画");
		expect(blockEl(view.container, "cover").textContent).not.toContain("这一场不画");
	});

	it("不画的块照旧选得中 —— 编辑器就是要让人改它", () => {
		const picked: string[] = [];
		const view = render(
			<SkinCanvas
				kind="live"
				card={cardOf(manifest(), "live")}
				selection={null}
				onSelect={(s) => picked.push(s?.kind === "block" ? s.id : "")}
				drawn={["cover"]}
			/>,
		);
		fireEvent.click(blockEl(view.container, "name"));
		expect(picked).toEqual(["name"]);
	});

	it("还没画好 / 读不到 → 一个都不标,别把满屏都说成不出现", () => {
		for (const drawn of [undefined, null]) {
			const view = canvas(drawn);
			expect(view.container.textContent).not.toContain("这一场不画");
			cleanup();
		}
	});
});
