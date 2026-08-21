// @vitest-environment jsdom

/**
 * DragHandle —— dnd-kit 可排序行的 ⠿ 手柄。
 *
 * 抄了三遍(cards/BlockListEditor → rules/MessageLayoutEditor → header 的
 * 标签页排序面板,一路 copy-forward),第三份还顺手把字号从 15px 改成 14px、
 * 多加了 px-0.5,没留下理由。这里钉的是三份共同的那些**不能丢**的东西:
 * `touch-none`(丢了触屏上一拖就变成滚页)、activator ref(丢了整行都成手柄,
 * 行内的开关/输入框点不动)、aria-label(键盘与读屏器唯一的抓手)。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DragHandle } from "../drag-handle";

afterEach(cleanup);

const ATTRS = { role: "button", tabIndex: 0 } as never;

describe("DragHandle", () => {
	it("触屏必须的 touch-none 与抓手光标都在", () => {
		render(<DragHandle attributes={ATTRS} listeners={undefined} setActivatorNodeRef={() => {}} />);
		const cls = screen.getByRole("button", { name: "拖动排序" }).className.split(/\s+/);
		for (const c of ["touch-none", "select-none", "cursor-grab", "active:cursor-grabbing"]) {
			expect([c, cls.includes(c)]).toEqual([c, true]);
		}
	});

	it("activator ref 落在手柄本身,而不是整行", () => {
		const setActivatorNodeRef = vi.fn();
		render(
			<DragHandle
				attributes={ATTRS}
				listeners={undefined}
				setActivatorNodeRef={setActivatorNodeRef}
			/>,
		);
		expect(setActivatorNodeRef).toHaveBeenCalledWith(
			screen.getByRole("button", { name: "拖动排序" }),
		);
	});

	it("listeners 透传到手柄上", () => {
		const onPointerDown = vi.fn();
		render(
			<DragHandle
				attributes={ATTRS}
				listeners={{ onPointerDown } as never}
				setActivatorNodeRef={() => {}}
			/>,
		);
		screen
			.getByRole("button", { name: "拖动排序" })
			.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		expect(onPointerDown).toHaveBeenCalled();
	});

	it("label 追加到读屏器名字上,标题保持通用", () => {
		render(
			<DragHandle
				attributes={ATTRS}
				listeners={undefined}
				setActivatorNodeRef={() => {}}
				label="推送历史"
			/>,
		);
		const el = screen.getByRole("button", { name: "拖动排序 推送历史" });
		expect(el.getAttribute("title")).toBe("拖动排序");
	});
});
