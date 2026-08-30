// @vitest-environment jsdom

/**
 * EmptyNote —— 「这里还什么都没有」那一档中性虚线框。
 *
 * 收编之前站内写了九份,同一个意思却在四种圆角之间漂(`rounded-md` 6px /
 * `rounded-bn-sm` 9.5px / `rounded-lg` 8px / `rounded-bn-card` 14px),字号在
 * 11 / 11.5 / 12.5px 之间漂。这里钉的是其中**逐字重复**的两份:面板档
 * (Dashboard 三张卡)与内嵌档(Targets / UpDialog 三处),期望值直接取自
 * 被替换的那段 markup,不是照着新实现回抄的。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EmptyNote } from "../atoms";

afterEach(cleanup);

/**
 * 两档共用的骨架:中性虚线边 + 居中。
 *
 * 边色与 add 家族同一档 `bn-inactive/50` —— 2026-08-30 主人真机对着「添加 UP 主」
 * 与「尚未配置任何适配器」两框指出深浅不一致后统一。皮肤若想要原来的淡边,
 * 在 note-empty 挂点自己钉 border-color。
 */
const SHARED = ["border", "border-dashed", "border-bn-inactive/50", "text-center"];

describe("EmptyNote", () => {
	it("默认(面板档)复刻 Dashboard 三张卡的空态盒", () => {
		render(<EmptyNote>当前没有订阅 UP 主在直播</EmptyNote>);
		const el = screen.getByText("当前没有订阅 UP 主在直播");
		const cls = el.className.split(/\s+/);
		for (const c of [...SHARED, "rounded-lg", "p-6", "text-bn-sm", "text-bn-text-secondary"]) {
			expect([c, cls.includes(c)]).toEqual([c, true]);
		}
	});

	it("内嵌档(size=sm)复刻 Targets / UpDialog 的行内空态盒", () => {
		render(<EmptyNote size="sm">还没有配置推送目标</EmptyNote>);
		const el = screen.getByText("还没有配置推送目标");
		const cls = el.className.split(/\s+/);
		for (const c of [
			...SHARED,
			"rounded-md",
			"px-3",
			"py-3",
			"text-bn-xs",
			"text-bn-text-secondary",
		]) {
			expect([c, cls.includes(c)]).toEqual([c, true]);
		}
		// 两档只差尺寸,别把面板档的 padding 也带进来。
		expect(cls).not.toContain("p-6");
	});

	/** 与 ErrorNote / WarnNote 同约定:className 只管外边距,盒子本体不许各处漂。 */
	it("className 追加在本体样式之后", () => {
		render(<EmptyNote className="mt-3">空</EmptyNote>);
		expect(screen.getByText("空").className.endsWith("mt-3")).toBe(true);
	});
});
