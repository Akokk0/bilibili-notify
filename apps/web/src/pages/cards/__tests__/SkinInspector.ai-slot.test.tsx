// @vitest-environment jsdom

/**
 * CSS 框旁那颗「请女仆帮忙写」(ADR-0015 决策 3–10)。
 *
 * 钉的是用户看得见的那几件:按不动时说得出为什么;按了才弹;写出来的规则一条条进框,
 * 第一条到之前框里还是原文;写完给一次性的「还原」(编辑器没有撤销栈,不给的话手写的
 * 那段当场找不回来);重来、失败、停、半路换了选中 —— 框一律退回动手前的原文。
 */

import type { CardSkinManifest } from "@bilibili-notify/contract";
import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { CardSkinAiDone, CardSkinAiHandlers } from "../../../services/cardSkinAi";
import type { CardSkinAiReadiness } from "../card-skin-ai";
import type { SkinSelection } from "../SkinCanvas";
import { type InspectorAi, SkinInspector } from "../SkinInspector";
import { setBlockCss, setFrameCss } from "../skin-draft-ops";

afterEach(cleanup);

const ORIGINAL = '[data-bn="self"]{padding:1px}';

/** 一次可以从测试这头推着走的 AI 调用。 */
function fakeAi(readiness: CardSkinAiReadiness = { ready: true }) {
	const state: {
		handlers?: CardSkinAiHandlers;
		signal?: AbortSignal;
		resolve?: (d: CardSkinAiDone) => void;
		reject?: (e: Error) => void;
	} = {};
	const run = vi.fn<InspectorAi["run"]>(
		(_target, _instruction, handlers, signal) =>
			new Promise<CardSkinAiDone>((resolve, reject) => {
				Object.assign(state, { handlers, signal, resolve, reject });
				signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			}),
	);
	return { ai: { readiness, run } satisfies InspectorAi, run, state };
}

/** 持有草稿的壳 —— 检查器是受控的,写进去的东西得真的回到框里。 */
function Harness(props: { ai: InspectorAi; selection: SkinSelection }) {
	const [manifest, setManifest] = useState<CardSkinManifest>(() => {
		const m = structuredClone(DEFAULT_CARD_SKIN) as CardSkinManifest;
		const live = m.cards.live;
		if (live) {
			live.css = ORIGINAL;
			const cover = live.blocks.find((b) => b.id === "cover");
			if (cover) cover.css = ORIGINAL;
		}
		return m;
	});
	return (
		<SkinInspector
			manifest={manifest}
			kind="live"
			selection={props.selection}
			onGrid={vi.fn()}
			onCss={(id, css) => setManifest((m) => setBlockCss(m, "live", id, css))}
			onHtml={vi.fn()}
			onShowIf={vi.fn()}
			onFrame={vi.fn()}
			onFrameCss={(css) => setManifest((m) => setFrameCss(m, "live", css))}
			onColumns={vi.fn()}
			ai={props.ai}
		/>
	);
}

const COVER: SkinSelection = { kind: "block", id: "cover" };
/** CSS 那一节默认是结构视图,源码文本框得先切过去。 */
const box = () => {
	fireEvent.click(screen.getByRole("button", { name: "源码" }));
	return screen.getByLabelText("这个块的 CSS") as HTMLTextAreaElement;
};
const slot = () => screen.getByRole("button", { name: /请女仆帮忙写/ }) as HTMLButtonElement;

async function ask(instruction = "圆角大一点") {
	fireEvent.click(slot());
	const dialog = screen.getByRole("dialog", { name: "请女仆帮忙写" });
	fireEvent.change(within(dialog).getByLabelText("想让这段 CSS 变成什么样"), {
		target: { value: instruction },
	});
	await act(async () => {
		fireEvent.click(within(dialog).getByRole("button", { name: "拜托啦" }));
	});
	return dialog;
}

describe("CSS 旁边的「请女仆帮忙写」", () => {
	it("块与外框两处都有", () => {
		const { ai } = fakeAi();
		const { rerender } = render(<Harness ai={ai} selection={COVER} />);
		expect(slot()).toBeTruthy();
		rerender(<Harness ai={ai} selection={{ kind: "frame" }} />);
		expect(slot()).toBeTruthy();
	});

	it("按不动时说得出为什么", () => {
		const { ai } = fakeAi({ ready: false, reason: "还没配好模型" });
		render(<Harness ai={ai} selection={COVER} />);
		expect(slot().disabled).toBe(true);
		expect(slot().getAttribute("title")).toBe("还没配好模型");
	});

	it("按了才弹;发出去的是那句话与这个框", async () => {
		const { ai, run } = fakeAi();
		render(<Harness ai={ai} selection={COVER} />);
		expect(screen.queryByRole("dialog")).toBeNull();
		await ask("  圆角大一点 ");
		expect(run.mock.calls[0]?.[0]).toEqual({ blockId: "cover" });
		expect(run.mock.calls[0]?.[1]).toBe("圆角大一点");

		cleanup();
		render(<Harness ai={ai} selection={{ kind: "frame" }} />);
		await ask("深色");
		expect(run.mock.calls[1]?.[0]).toEqual({});
	});

	it("规则一条条进框,第一条到之前还是原文;写完以最终内容为准,给一次「还原」", async () => {
		const { ai, state } = fakeAi();
		render(<Harness ai={ai} selection={COVER} />);
		await ask();
		expect(box().value).toBe(ORIGINAL);

		act(() => state.handlers?.onRule(".a{x:1}"));
		expect(box().value).toBe(".a{x:1}");
		act(() => state.handlers?.onRule("\n.b{y:2}"));
		expect(box().value).toBe(".a{x:1}\n.b{y:2}");

		await act(async () =>
			state.resolve?.({ css: ".a{x:1}\n.b{y:2}\n/*尾*/", warnings: ["削掉一条"] }),
		);
		expect(box().value).toBe(".a{x:1}\n.b{y:2}\n/*尾*/");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByText(/削掉一条/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "还原" }));
		expect(box().value).toBe(ORIGINAL);
		expect(screen.queryByRole("button", { name: "还原" })).toBeNull();
	});

	it("第一趟没过、要重来 → 框退回原文", async () => {
		const { ai, state } = fakeAi();
		render(<Harness ai={ai} selection={COVER} />);
		const dialog = await ask();
		act(() => state.handlers?.onRule(".bad{"));
		act(() => state.handlers?.onRetry(["解析失败"]));
		expect(box().value).toBe(ORIGINAL);
		expect(within(dialog).getByText(/重写/)).toBeTruthy();
	});

	it("失败 → 框退回原文,弹层里说原因", async () => {
		const { ai, state } = fakeAi();
		render(<Harness ai={ai} selection={COVER} />);
		const dialog = await ask();
		act(() => state.handlers?.onRule(".a{x:1}"));
		await act(async () => state.reject?.(new Error("超过上限")));
		expect(box().value).toBe(ORIGINAL);
		expect(within(dialog).getByText(/超过上限/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "还原" })).toBeNull();
	});

	it("停 → 掐断,框退回原文,可以再写", async () => {
		const { ai, state } = fakeAi();
		render(<Harness ai={ai} selection={COVER} />);
		const dialog = await ask();
		act(() => state.handlers?.onRule(".a{x:1}"));
		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "先不用了" }));
		});
		expect(state.signal?.aborted).toBe(true);
		expect(box().value).toBe(ORIGINAL);
		expect(within(dialog).getByRole("button", { name: "拜托啦" })).toBeTruthy();
		// 被掐之后迟到的规则不许再进框。
		act(() => state.handlers?.onRule(".late{x:1}"));
		expect(box().value).toBe(ORIGINAL);
	});

	it("写到一半换到另一个块 → 剩下的规则不许写进新选中的那块", async () => {
		const { ai, state } = fakeAi();
		const { rerender } = render(<Harness ai={ai} selection={COVER} />);
		await ask();
		act(() => state.handlers?.onRule(".a{x:1}"));
		await act(async () => rerender(<Harness ai={ai} selection={{ kind: "block", id: "title" }} />));
		expect(state.signal?.aborted).toBe(true);
		const titleBefore = box().value;
		act(() => state.handlers?.onRule(".late{x:1}"));
		expect(box().value).toBe(titleBefore);
		rerender(<Harness ai={ai} selection={COVER} />);
		expect(box().value).toBe(ORIGINAL);
	});

	it("写到一半换了选中 → 掐断,那个块退回原文", async () => {
		const { ai, state } = fakeAi();
		const { rerender } = render(<Harness ai={ai} selection={COVER} />);
		await ask();
		act(() => state.handlers?.onRule(".a{x:1}"));
		await act(async () => rerender(<Harness ai={ai} selection={{ kind: "frame" }} />));
		expect(state.signal?.aborted).toBe(true);
		rerender(<Harness ai={ai} selection={COVER} />);
		expect(box().value).toBe(ORIGINAL);
	});
});
