// @vitest-environment jsdom
/**
 * 灵动岛 ExpandPanel 渲染层测试(plan Phase I 矩阵的最后一块)。
 *
 * `draft-island.test.ts` 已覆盖 selectChipKind 纯函数;本文件用 jsdom +
 * @testing-library/react 覆盖 4 个交互路径:
 * - hover 灵动岛容器 → panel 显示(预览态)
 * - click chip 内容区 → panelLocked + panel 持续显示
 * - outside click → panel 关闭
 * - panel 内 DiffRow click → scrollIntoView + bn-anim-highlight class
 *
 * 顺手测 dirty/saving/saved/error 4 态 chip 文案、保存/丢弃按钮回调。
 *
 * motion.dev 在 jsdom 下不跑实际动画但不报错;scrollIntoView 在 jsdom 没有,
 * 在 prototype 上挂 vi.fn() spy 即可。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type DraftRegistration, useDraftStore } from "../../store/draft";
import type { FieldDiff } from "../../utils/walkTreeDiff";
import { DraftIsland } from "../draft-island";

const sampleDiff: FieldDiff[] = [
	{ code: "blockKeywords", oldValue: [], newValue: ["spam"] },
	{ code: "schedule.pushTime", oldValue: "09:00", newValue: "10:00" },
];

function makeReg(overrides: Partial<DraftRegistration> = {}): DraftRegistration {
	return {
		pageKey: "rules",
		pageLabel: "动态过滤规则",
		diff: sampleDiff,
		onSave: vi.fn(),
		onDiscard: vi.fn(),
		...overrides,
	};
}

function resetStore() {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

beforeEach(() => {
	resetStore();
	// scrollIntoView 在 jsdom 不存在;Element.prototype 挂 vi.fn 全局 spy。
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("DraftIsland chip 5 态渲染", () => {
	it("idle → 不渲染任何 chip(section 容器空)", () => {
		render(<DraftIsland />);
		const section = screen.getByTestId("draft-island");
		// chip 与 panel 都是 AnimatePresence 子,idle 下都不渲染
		expect(section.textContent).toBe("");
	});

	it("dirty → 渲染页面标签 + 字段数徽章 + 保存按钮", () => {
		useDraftStore.setState({ current: makeReg(), uiState: "dirty" });
		render(<DraftIsland />);
		expect(screen.getByText("动态过滤规则")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy(); // diff.length 徽章
		expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
	});

	it("saving → 渲染 '保存中…'", () => {
		useDraftStore.setState({ current: makeReg(), uiState: "saving" });
		render(<DraftIsland />);
		expect(screen.getByText("保存中…")).toBeTruthy();
	});

	it("saved → 渲染 '已保存'", () => {
		useDraftStore.setState({ current: makeReg(), uiState: "saved" });
		render(<DraftIsland />);
		expect(screen.getByText("已保存")).toBeTruthy();
	});

	it("error → 渲染 errorMessage + 关闭按钮 → 关闭按钮 click 切回 dirty", () => {
		useDraftStore.setState({
			current: makeReg(),
			uiState: "error",
			errorMessage: "网络异常",
		});
		render(<DraftIsland />);
		expect(screen.getByText("网络异常")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
		expect(useDraftStore.getState().uiState).toBe("dirty");
	});

	it("error + errorMessage=null → 回退文案 '保存失败'", () => {
		useDraftStore.setState({
			current: makeReg(),
			uiState: "error",
			errorMessage: null,
		});
		render(<DraftIsland />);
		expect(screen.getByText("保存失败")).toBeTruthy();
	});
});

describe("DraftIsland chip 行为", () => {
	it("dirty 态 click 保存按钮 → reg.onSave 被调", () => {
		const onSave = vi.fn();
		useDraftStore.setState({ current: makeReg({ onSave }), uiState: "dirty" });
		render(<DraftIsland />);
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("保存按钮 click 不会冒泡触发 panelLocked toggle", () => {
		useDraftStore.setState({ current: makeReg(), uiState: "dirty" });
		render(<DraftIsland />);
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		// onSave 内 stopPropagation,确保不进入 chip click 处理(panelLocked 保持 false)
		expect(useDraftStore.getState().panelLocked).toBe(false);
	});
});

describe("DraftIsland expand panel 显示规则", () => {
	it("dirty + hover 容器 → panel 显示(预览态,不锁定)", () => {
		useDraftStore.setState({ current: makeReg(), uiState: "dirty" });
		render(<DraftIsland />);
		const section = screen.getByTestId("draft-island");
		fireEvent.mouseEnter(section);
		// panel 渲染了页脚的「丢弃全部更改」按钮
		expect(screen.getByRole("button", { name: "丢弃全部更改" })).toBeTruthy();
		expect(useDraftStore.getState().panelLocked).toBe(false);
	});

	it("click chip 内容(非保存按钮)→ panelLocked + panel 持续显示即使 mouseLeave", () => {
		useDraftStore.setState({ current: makeReg(), uiState: "dirty" });
		render(<DraftIsland />);
		// click chip 内容(页面标签)
		fireEvent.click(screen.getByText("动态过滤规则"));
		expect(useDraftStore.getState().panelLocked).toBe(true);
		const section = screen.getByTestId("draft-island");
		fireEvent.mouseLeave(section);
		// 锁定后即使没 hover panel 也仍在
		expect(screen.queryByRole("button", { name: "丢弃全部更改" })).not.toBeNull();
	});

	it("再次 click chip 内容 → panelLocked toggle 关闭", () => {
		useDraftStore.setState({
			current: makeReg(),
			uiState: "dirty",
			panelLocked: true,
		});
		render(<DraftIsland />);
		fireEvent.click(screen.getByText("动态过滤规则"));
		expect(useDraftStore.getState().panelLocked).toBe(false);
	});

	it("outside click(document body)→ 已锁定的 panel 关闭", () => {
		useDraftStore.setState({
			current: makeReg(),
			uiState: "dirty",
			panelLocked: true,
		});
		render(<DraftIsland />);
		fireEvent.mouseDown(document.body);
		expect(useDraftStore.getState().panelLocked).toBe(false);
	});

	it("outside click 仅在 panelLocked=true 时挂监听 — 非锁定下 body mouseDown 不改 state", () => {
		useDraftStore.setState({ current: makeReg(), uiState: "dirty" });
		render(<DraftIsland />);
		fireEvent.mouseDown(document.body);
		expect(useDraftStore.getState().panelLocked).toBe(false);
	});
});

describe("DraftIsland expand panel DiffRow 行跳转", () => {
	it("行 click → scrollIntoView 调用 + 目标元素加 bn-anim-highlight class", () => {
		useDraftStore.setState({
			current: makeReg(),
			uiState: "dirty",
			panelLocked: true,
		});
		// 在 DOM 里塞一个匹配 [data-code="blockKeywords"] 的目标
		const target = document.createElement("div");
		target.setAttribute("data-code", "blockKeywords");
		document.body.appendChild(target);
		render(<DraftIsland />);
		// DiffRow button 的 title 是 `跳转到 ${code}`
		fireEvent.click(screen.getByTitle("跳转到 blockKeywords"));
		expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(target.classList.contains("bn-anim-highlight")).toBe(true);
		document.body.removeChild(target);
	});

	it("行 click 但 DOM 无匹配 [data-code] → silent no-op,不抛", () => {
		useDraftStore.setState({
			current: makeReg(),
			uiState: "dirty",
			panelLocked: true,
		});
		render(<DraftIsland />);
		// blockKeywords / schedule.pushTime 都不在 DOM 里
		expect(() => fireEvent.click(screen.getByTitle("跳转到 blockKeywords"))).not.toThrow();
	});

	it("丢弃按钮 click → reg.onDiscard 被调", () => {
		const onDiscard = vi.fn();
		useDraftStore.setState({
			current: makeReg({ onDiscard }),
			uiState: "dirty",
			panelLocked: true,
		});
		render(<DraftIsland />);
		fireEvent.click(screen.getByRole("button", { name: "丢弃全部更改" }));
		expect(onDiscard).toHaveBeenCalledTimes(1);
	});

	it("panel 渲染分 section 标题 — 字典里 blockKeywords→filter, schedule.pushTime→schedule", () => {
		useDraftStore.setState({
			current: makeReg(),
			uiState: "dirty",
			panelLocked: true,
		});
		render(<DraftIsland />);
		expect(screen.getByText("动态过滤")).toBeTruthy();
		expect(screen.getByText("调度")).toBeTruthy();
	});
});

describe("DraftIsland dirty 态外圈流光线(grill-me 二轮:单色流动)", () => {
	it("dirty 渲染 → 流光节点存在", () => {
		useDraftStore.setState({ current: makeReg(), uiState: "dirty" });
		render(<DraftIsland />);
		expect(screen.getByTestId("draft-island-aura")).toBeTruthy();
	});

	it.each(["saving", "saved", "error"] as const)("%s 态 → 不渲染流光节点", (state) => {
		useDraftStore.setState({
			current: makeReg(),
			uiState: state,
			errorMessage: state === "error" ? "x" : null,
		});
		render(<DraftIsland />);
		expect(screen.queryByTestId("draft-island-aura")).toBeNull();
	});
});
