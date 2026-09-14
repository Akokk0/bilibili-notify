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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SkinCanvas, type SkinSelection } from "../SkinCanvas";
import { SkinInspector } from "../SkinInspector";
import { cardOf, setBlockGrid } from "../skin-draft-ops";

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

/** 画布 + 检查器接在一份真草稿上 —— 这条回路正是要钉的东西。 */
function Harness({ onDraft }: { onDraft?: (m: CardSkinManifest) => void }) {
	const [draft, setDraft] = useState<CardSkinManifest>(manifest());
	const [selection, setSelection] = useState<SkinSelection>(null);
	return (
		<div>
			<SkinCanvas
				kind="live"
				card={cardOf(draft, "live")}
				selection={selection}
				onSelect={setSelection}
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
			/>
		</div>
	);
}

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
		expect(screen.getByText(/卡片外框的宽度/)).toBeTruthy();
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
		expect(screen.getByText(/在左边画布上点一个块/)).toBeTruthy();
	});
});
